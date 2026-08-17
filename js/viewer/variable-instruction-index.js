export const X86_MAX_INSTRUCTION_BYTES = 15;
export const VARIABLE_DECODE_PAGE_BYTES = 2048;
export const VARIABLE_DECODE_OVERLAP_BYTES = X86_MAX_INSTRUCTION_BYTES - 1;
export const VARIABLE_MAX_DECODE_REQUEST_BYTES = VARIABLE_DECODE_PAGE_BYTES + VARIABLE_DECODE_OVERLAP_BYTES;
export const VARIABLE_PREFETCH_PAGES = 1;
export const VARIABLE_CACHE_PAGES = 8;
export const VARIABLE_RETAINED_INSTRUCTION_LIMIT = VARIABLE_CACHE_PAGES * VARIABLE_DECODE_PAGE_BYTES;
export const VARIABLE_RESYNC_BYTES = 64;

function abortError(reason = null) {
  if (reason instanceof Error) return reason;
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  return Object.assign(new Error('aborted'), { name:'AbortError', code:'ABORT_ERR' });
}
function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }
function toBigInt(value, code) { try { return BigInt(value); } catch { throw new TypeError(code); } }
function int(value, code, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new TypeError(code);
  return n;
}
function bytesOf(instruction, length) {
  const raw = instruction?.rawBytes ?? instruction?.bytes;
  const bytes = raw instanceof Uint8Array ? raw.slice() : Uint8Array.from(raw || []);
  if (bytes.length !== length) throw new TypeError('variable-viewer-byte-length-mismatch');
  return bytes;
}
function freezeEntry(instruction, address, length) {
  return Object.freeze({
    kind:'instruction', address, length, bytes:bytesOf(instruction, length),
    mnemonic:String(instruction?.mnemonic ?? ''),
    opStr:String(instruction?.opStr ?? instruction?.operandString ?? ''), decoded:instruction,
  });
}
function freezeDecodeMarker(page) {
  return Object.freeze({
    kind:'decode-error', address:page.start, length:0, bytes:new Uint8Array(0),
    mnemonic:'???', opStr:page.status === 'unsupported' ? '[decoder unsupported]' : '[undecodable bytes]',
    decoded:null, status:page.status,
  });
}
function pageKey(generation, address) { return `${generation}:${address.toString(16)}`; }

export class VariableInstructionIndex {
  constructor({
    disassembleAt, architecture='x86_64', pageBytes=VARIABLE_DECODE_PAGE_BYTES,
    overlapBytes=VARIABLE_DECODE_OVERLAP_BYTES, maxPages=VARIABLE_CACHE_PAGES,
    maxInstructions=VARIABLE_RETAINED_INSTRUCTION_LIMIT, maxPrefetchPages=VARIABLE_PREFETCH_PAGES,
    resyncBytes=VARIABLE_RESYNC_BYTES, onPublish=null,
  } = {}) {
    if (typeof disassembleAt !== 'function') throw new TypeError('variable-viewer-disassembleAt-required');
    this.disassembleAt=disassembleAt;
    this.architecture=String(architecture||'x86_64');
    this.pageBytes=int(pageBytes,'variable-viewer-invalid-page-bytes',32,1<<20);
    this.overlapBytes=int(overlapBytes,'variable-viewer-invalid-overlap',0,X86_MAX_INSTRUCTION_BYTES-1);
    this.maxPages=int(maxPages,'variable-viewer-invalid-cache-pages',1,256);
    this.maxInstructions=int(maxInstructions,'variable-viewer-invalid-instruction-limit',1,1<<24);
    this.maxPrefetchPages=int(maxPrefetchPages,'variable-viewer-invalid-prefetch-pages',0,4);
    this.resyncBytes=int(resyncBytes,'variable-viewer-invalid-resync-bytes',X86_MAX_INSTRUCTION_BYTES,4096);
    this.onPublish=typeof onPublish==='function'?onPublish:null;
    this.region=null; this.generation=0; this.pages=new Map(); this.inflight=new Map(); this.known=new Map();
    this.currentPageKey=null; this.currentAddress=null; this._clock=0;
    this._metrics={decodeRequestCount:0,requestedDecodeBytes:0,decodedInstructionCount:0,cacheHits:0,cacheMisses:0,evictions:0,cancelledRequests:0,staleResultsDiscarded:0};
  }

  configureRegion(region,{architecture=null}={}) {
    this.cancelAll('region-changed');
    this.generation++; this.pages.clear(); this.inflight.clear(); this.known.clear();
    this.currentPageKey=null; this.currentAddress=null;
    if(!region){this.region=null;return;}
    const start=toBigInt(region.vmAddr,'variable-viewer-region-start-required');
    const size=toBigInt(region.size,'variable-viewer-region-size-required');
    if(size<0n)throw new TypeError('variable-viewer-negative-region-size');
    this.region=Object.freeze({id:region.id??null,start,size,end:start+size});
    if(architecture)this.architecture=String(architecture);
  }

  dispose(){
    this.cancelAll('viewer-disposed'); this.generation++; this.pages.clear(); this.inflight.clear(); this.known.clear();
    this.region=null; this.currentPageKey=null; this.currentAddress=null;
  }

  cancelAll(reason='superseded'){
    for(const pending of this.inflight.values()){
      if(!pending.controller.signal.aborted){ pending.controller.abort(abortError(reason)); this._metrics.cancelledRequests++; }
    }
    this.inflight.clear();
  }

  cancelExcept(addresses=[]){
    const keep=new Set(addresses.map((address)=>pageKey(this.generation,BigInt(address))));
    for(const[key,pending]of this.inflight){
      if(keep.has(key))continue;
      if(!pending.controller.signal.aborted){pending.controller.abort(abortError('superseded-navigation'));this._metrics.cancelledRequests++;}
      this.inflight.delete(key);
    }
  }

  metrics(){
    let retainedInstructions=0,retainedBytes=0;
    for(const page of this.pages.values()){retainedInstructions+=page.entries.length;retainedBytes+=page.retainedBytes;}
    return Object.freeze({...this._metrics,retainedPages:this.pages.size,retainedInstructions,retainedBytes,inflightRequests:this.inflight.size,pageBytes:this.pageBytes,overlapBytes:this.overlapBytes,maxDecodeRequestBytes:this.pageBytes+this.overlapBytes,maxPrefetchPages:this.maxPrefetchPages,maxPages:this.maxPages,maxInstructions:this.maxInstructions,generation:this.generation});
  }

  _assertInRegion(address,{allowEnd=false}={}){
    if(!this.region)throw new Error('variable-viewer-region-unavailable');
    const ok=allowEnd?address>=this.region.start&&address<=this.region.end:address>=this.region.start&&address<this.region.end;
    if(!ok)throw new RangeError('variable-viewer-address-outside-region');
  }

  knownEntry(address){return this.known.get(BigInt(address).toString(16))||null;}

  containingEntry(address){
    const target=BigInt(address),exact=this.knownEntry(target); if(exact)return exact;
    for(const page of this.pages.values())for(const entry of page.entries)if(entry.address<target&&target<entry.address+BigInt(entry.length))return entry;
    return null;
  }

  localRows(address=this.currentAddress){
    if(!this.pages.size)return Object.freeze([]);
    const target=address==null?this.currentAddress:BigInt(address);
    let current=null;
    if(target!=null)current=this._pageContaining(target);
    if(!current&&this.currentPageKey)current=this.pages.get(this.currentPageKey)||null;
    if(!current)current=this.pages.values().next().value||null;
    if(!current)return Object.freeze([]);

    const chain=[current]; let cursor=current;
    while(true){
      const prev=Array.from(this.pages.values()).find((page)=>page.nextAddress===cursor.start&&page.entries.length>0);
      if(!prev||chain.includes(prev))break; chain.unshift(prev); cursor=prev;
    }
    cursor=current;
    while(true){
      const next=Array.from(this.pages.values()).find((page)=>page.start===cursor.nextAddress);
      if(!next||chain.includes(next))break; chain.push(next); cursor=next;
      if(next.entries.length===0)break;
    }
    const byAddress=new Map();
    for(const page of chain){
      for(const entry of page.entries)byAddress.set(entry.address.toString(16),entry);
      if(page.entries.length===0&&(page.status==='undecodable'||page.status==='unsupported')){
        byAddress.set(`error:${page.start.toString(16)}`,freezeDecodeMarker(page));
      }
    }
    return Object.freeze(Array.from(byAddress.values()).sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:(a.kind==='instruction'?-1:1)));
  }

  localIndexOfAddress(address){
    const target=BigInt(address),rows=this.localRows(target),i=rows.findIndex((entry)=>entry.address===target);
    return i>=0?i:null;
  }
  localEntryAt(index,address=this.currentAddress){const rows=this.localRows(address);return Number.isInteger(index)&&index>=0&&index<rows.length?rows[index]:null;}

  async ensurePage(startAddress,{signal=null,priority='current',protect=true}={}){
    const start=BigInt(startAddress); this._assertInRegion(start);
    if(signal?.aborted)throw abortError(signal.reason);
    const key=pageKey(this.generation,start),cached=this.pages.get(key);
    if(cached){this._metrics.cacheHits++;cached.lastUsed=++this._clock;if(protect)this.currentPageKey=key;return cached;}
    const shared=this.inflight.get(key);
    if(shared){this._metrics.cacheHits++;return this._join(shared.promise,signal);}

    this._metrics.cacheMisses++;
    const controller=new AbortController(),generation=this.generation,region=this.region,remaining=region.end-start;
    const safeRemaining=remaining>BigInt(Number.MAX_SAFE_INTEGER)?Number.MAX_SAFE_INTEGER:Number(remaining);
    const requested=Math.max(0,Math.min(this.pageBytes+this.overlapBytes,safeRemaining));
    if(requested<=0)throw new RangeError('variable-viewer-empty-page');
    this._metrics.decodeRequestCount++; this._metrics.requestedDecodeBytes+=requested;

    const relayAbort=()=>{
      if(!controller.signal.aborted){controller.abort(abortError(signal?.reason));this._metrics.cancelledRequests++;}
    };
    signal?.addEventListener?.('abort',relayAbort,{once:true});
    const promise=(async()=>{
      try{
        const response=await this.disassembleAt(start,{architecture:this.architecture,length:requested,signal:controller.signal,priority});
        if(generation!==this.generation||this.region!==region){this._metrics.staleResultsDiscarded++;return Object.freeze({stale:true,start,entries:Object.freeze([]),status:'stale',nextAddress:start});}
        if(controller.signal.aborted)throw abortError(controller.signal.reason);
        const page=this._buildPage({start,requested,response,generation,region});
        this._publish(key,page,{protect}); return page;
      }catch(error){
        if(generation!==this.generation||this.region!==region){this._metrics.staleResultsDiscarded++;return Object.freeze({stale:true,start,entries:Object.freeze([]),status:'stale',nextAddress:start});}
        if(isAbort(error))throw error;
        throw error;
      }finally{
        signal?.removeEventListener?.('abort',relayAbort);
        const pending=this.inflight.get(key); if(pending?.promise===promise)this.inflight.delete(key);
      }
    })();
    this.inflight.set(key,{controller,promise,generation,start});
    return this._join(promise,signal);
  }

  async _join(promise,signal){
    if(!signal)return promise;
    if(signal.aborted)throw abortError(signal.reason);
    return await Promise.race([promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(abortError(signal.reason)),{once:true}))]);
  }

  _buildPage({start,requested,response,generation,region}){
    const nominalEnd=start+BigInt(Math.min(this.pageBytes,requested));
    if(response?.supported===false)return{generation,start,requested,actualBytes:0,entries:Object.freeze([]),nextAddress:start,status:'unsupported',retainedBytes:0,lastUsed:++this._clock};
    const instructions=Array.isArray(response?.instructions)?response.instructions:[];
    if(!instructions.length)return{generation,start,requested,actualBytes:Number(response?.bytesRead??response?.actualBytes??requested),entries:Object.freeze([]),nextAddress:start,status:'undecodable',retainedBytes:0,lastUsed:++this._clock};

    const entries=[]; let cursor=start;
    for(const instruction of instructions){
      const address=toBigInt(instruction?.address,'variable-viewer-invalid-instruction-address');
      const length=int(instruction?.length??instruction?.size,'variable-viewer-invalid-instruction-length',1,X86_MAX_INSTRUCTION_BYTES);
      if(address!==cursor)throw new TypeError('variable-viewer-non-monotonic-decoder-output');
      const end=address+BigInt(length);
      if(address<start||address>=region.end||end>region.end)throw new RangeError('variable-viewer-decoder-output-outside-region');
      if(address>=start+BigInt(requested))throw new RangeError('variable-viewer-decoder-output-outside-request');
      if(end>start+BigInt(requested))throw new RangeError('variable-viewer-partial-final-instruction');
      if(address>=nominalEnd)break;
      entries.push(freezeEntry(instruction,address,length)); this._metrics.decodedInstructionCount++;
      cursor=end; if(cursor>=nominalEnd)break;
    }
    if(!entries.length)return{generation,start,requested,actualBytes:Number(response?.bytesRead??response?.actualBytes??requested),entries:Object.freeze([]),nextAddress:start,status:'undecodable',retainedBytes:0,lastUsed:++this._clock};
    const retainedBytes=entries.reduce((sum,entry)=>sum+entry.bytes.byteLength,0);
    const nextAddress=entries.at(-1).address+BigInt(entries.at(-1).length);
    return{generation,start,requested,actualBytes:Number(response?.bytesRead??response?.actualBytes??requested),entries:Object.freeze(entries),nextAddress,status:nextAddress>=region.end?'region-end':'ok',retainedBytes,lastUsed:++this._clock};
  }

  _publish(key,page,{protect=true}={}){
    this.pages.set(key,page);
    for(const entry of page.entries)this.known.set(entry.address.toString(16),entry);
    if(protect){this.currentPageKey=key;this.currentAddress=page.entries[0]?.address??page.start;}
    this._evict(); this.onPublish?.(page);
  }

  _evict(){
    const retainedCount=()=>{let n=0;for(const page of this.pages.values())n+=page.entries.length;return n;};
    while(this.pages.size>this.maxPages||retainedCount()>this.maxInstructions){
      let victimKey=null,victim=null;
      for(const[key,page]of this.pages){if(key===this.currentPageKey)continue;if(!victim||page.lastUsed<victim.lastUsed){victimKey=key;victim=page;}}
      if(!victimKey)break;
      this.pages.delete(victimKey);
      for(const entry of victim.entries){
        const addressKey=entry.address.toString(16);
        const ownedElsewhere=Array.from(this.pages.values()).some((page)=>page.entries.some((candidate)=>candidate.address===entry.address));
        if(!ownedElsewhere)this.known.delete(addressKey);
      }
      this._metrics.evictions++;
    }
  }

  async prefetchForward(page,{signal=null}={}){
    if(!page||this.maxPrefetchPages<=0||page.status!=='ok')return Object.freeze([]);
    const out=[]; let next=page.nextAddress;
    for(let i=0;i<this.maxPrefetchPages&&next<this.region.end;i++){
      const candidate=await this.ensurePage(next,{signal,priority:'prefetch',protect:false}); out.push(candidate);
      if(!candidate.entries.length||candidate.nextAddress<=next)break; next=candidate.nextAddress;
    }
    return Object.freeze(out);
  }

  async navigate(address,{signal=null,trusted=false}={}){
    const target=BigInt(address); this._assertInRegion(target);
    const exact=this.knownEntry(target);
    if(exact){this.currentAddress=exact.address;return Object.freeze({status:'exact',address:exact.address,entry:exact,page:this._pageContaining(exact.address)});}
    const containing=this.containingEntry(target);
    if(containing){this.currentAddress=containing.address;return Object.freeze({status:'inside-known',address:containing.address,entry:containing,page:this._pageContaining(containing.address)});}
    this.cancelExcept([]);
    if(trusted||target===this.region.start){
      const page=await this.ensurePage(target,{signal,priority:'current',protect:true}),entry=page.entries[0]||null;
      if(!entry||entry.address!==target)return Object.freeze({status:page.status==='undecodable'?'undecodable':'unknown',address:target,entry:null,page});
      this.currentAddress=target; void this.prefetchForward(page).catch(()=>{});
      return Object.freeze({status:'decoded',address:target,entry,page});
    }
    const proven=await this.resynchronize(target,{signal});
    if(proven.status!=='proven')return proven;
    const page=await this.ensurePage(proven.address,{signal,priority:'current',protect:true}),entry=page.entries[0]||null;
    if(!entry||entry.address!==proven.address)return Object.freeze({status:'unknown',address:target,entry:null,page});
    this.currentAddress=proven.address; void this.prefetchForward(page).catch(()=>{});
    return Object.freeze({status:target===proven.address?'decoded':'resynchronized',address:proven.address,requestedAddress:target,entry,page});
  }

  _pageContaining(address){for(const page of this.pages.values())if(page.entries.some((entry)=>entry.address===address))return page;return null;}

  async previousBoundary(targetAddress,{signal=null}={}){
    const target=BigInt(targetAddress); this._assertInRegion(target,{allowEnd:true});
    const rows=this.localRows(target),knownIndex=rows.findIndex((entry)=>entry.kind==='instruction'&&entry.address===target);
    if(knownIndex>0){
      for(let i=knownIndex-1;i>=0;i--)if(rows[i].kind==='instruction')return Object.freeze({status:'proven',address:rows[i].address,entry:rows[i],source:'known-page'});
    }
    return this.resynchronize(target,{signal,requirePredecessor:true});
  }

  async resynchronize(targetAddress,{signal=null,requirePredecessor=false}={}){
    const target=BigInt(targetAddress); this._assertInRegion(target,{allowEnd:true});
    const lower=target-BigInt(Math.min(this.resyncBytes,Number(target-this.region.start)));
    const candidateFloor=target-BigInt(X86_MAX_INSTRUCTION_BYTES);
    const first=lower>candidateFloor?lower:(candidateFloor>this.region.start?candidateFloor:this.region.start);
    const candidates=[];
    for(let start=first;start<target;start++){
      if(signal?.aborted)throw abortError(signal.reason);
      const remaining=this.region.end-start;
      const length=Math.min(this.resyncBytes,Number(remaining>BigInt(this.resyncBytes)?BigInt(this.resyncBytes):remaining));
      if(length<=0)continue;
      this._metrics.decodeRequestCount++; this._metrics.requestedDecodeBytes+=length;
      let response;
      try{response=await this.disassembleAt(start,{architecture:this.architecture,length,signal,priority:'current'});}catch(error){if(isAbort(error))throw error;continue;}
      let cursor=start,predecessor=null,valid=true;
      for(const instruction of Array.isArray(response?.instructions)?response.instructions:[]){
        let instructionAddress,size;
        try{instructionAddress=BigInt(instruction.address);size=int(instruction.length??instruction.size,'variable-viewer-invalid-instruction-length',1,X86_MAX_INSTRUCTION_BYTES);bytesOf(instruction,size);}catch{valid=false;break;}
        if(instructionAddress!==cursor){valid=false;break;}
        const end=instructionAddress+BigInt(size); if(end>target){valid=false;break;}
        predecessor=freezeEntry(instruction,instructionAddress,size); cursor=end;
        if(cursor===target)break;
      }
      if(valid&&cursor===target&&predecessor&&predecessor.address<target)candidates.push(predecessor);
    }
    const unique=new Map(candidates.map((entry)=>[entry.address.toString(16),entry]));
    if(unique.size!==1)return Object.freeze({status:unique.size>1?'ambiguous':'unknown',address:target,candidates:Object.freeze(Array.from(unique.values()).map((entry)=>entry.address))});
    const predecessor=unique.values().next().value;
    if(requirePredecessor)return Object.freeze({status:'proven',address:predecessor.address,entry:predecessor,source:'bounded-resync'});
    return Object.freeze({status:'proven',address:target,predecessor,source:'bounded-resync'});
  }
}
