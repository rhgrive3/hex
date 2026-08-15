from pathlib import Path


def replace(path, old, new, label):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,1))

# ProgramIndex: merge region scans under a single bounded global budget and
# retain per-region instruction-kind ownership.
p=Path('js/program.js'); s=p.read_text()
anchor="""function completeness(array, capped, source, queryLimited = false, unavailableReason = null) {"""
insert="""export const PROGRAM_MERGE_LIMITS = Object.freeze({
  calls: 2_000_000,
  refs: 2_000_000,
  kindWords: 16 * 1024 * 1024,
});

function boundedCount(scan, countKey, ...arrays) {
  const requested = Number.isSafeInteger(scan?.[countKey]) ? scan[countKey] : (arrays[0]?.length || 0);
  return Math.max(0, Math.min(requested, ...arrays.map((x) => x?.length || 0)));
}

/** Merge independently scanned executable regions without losing provenance. */
export function mergeProgramScans(scans = [], options = {}) {
  const limits = { ...PROGRAM_MERGE_LIMITS, ...(options.limits || {}) };
  const ordered = (scans || []).filter((x) => x && !x.cancelled).slice().sort((a,b) => {
    const av=BigInt(a.vmAddr ?? 0), bv=BigInt(b.vmAddr ?? 0);
    return av < bv ? -1 : av > bv ? 1 : String(a.regionId||'').localeCompare(String(b.regionId||''));
  });
  const expectedRegions = (options.regions || []).map((r) => ({ id:r.id ?? null, vmAddr:BigInt(r.vmAddr ?? 0), size:BigInt(r.size ?? 0) }));
  const reasons = [...(options.reasons || [])];
  const scannedIds = new Set(ordered.map((x) => x.regionId).filter((x) => x != null));
  for (const region of expectedRegions) if (region.id != null && !scannedIds.has(region.id)) reasons.push(`program-region-unscanned:${region.id}`);
  for (const scan of ordered) {
    if (scan.unsupported) reasons.push('unsupported-program-analysis');
    if (scan.completeness?.complete === false || scan.complete === false) {
      const rs = scan.completeness?.reasons || (scan.truncationReason ? [scan.truncationReason] : ['program-region-incomplete']);
      for (const reason of rs) reasons.push(`${scan.regionId || 'region'}:${reason}`);
    }
  }

  const callAvailable = ordered.reduce((n,s) => n + boundedCount(s,'callCount',s.callFrom,s.callTo),0);
  const refAvailable = ordered.reduce((n,s) => n + boundedCount(s,'refCount',s.refFrom,s.refTo,s.refKind),0);
  const callCap = Math.max(0, Math.min(Number(limits.calls)||0, callAvailable));
  const refCap = Math.max(0, Math.min(Number(limits.refs)||0, refAvailable));
  const callFrom=new BigUint64Array(callCap), callTo=new BigUint64Array(callCap);
  const refFrom=new BigUint64Array(refCap), refTo=new BigUint64Array(refCap), refKind=new Uint8Array(refCap);
  let ci=0, ri=0;
  for (const scan of ordered) {
    const nc=boundedCount(scan,'callCount',scan.callFrom,scan.callTo), ct=Math.min(nc,callCap-ci);
    if (ct>0) { callFrom.set(scan.callFrom.subarray(0,ct),ci); callTo.set(scan.callTo.subarray(0,ct),ci); ci+=ct; }
    const nr=boundedCount(scan,'refCount',scan.refFrom,scan.refTo,scan.refKind), rt=Math.min(nr,refCap-ri);
    if (rt>0) { refFrom.set(scan.refFrom.subarray(0,rt),ri); refTo.set(scan.refTo.subarray(0,rt),ri); refKind.set(scan.refKind.subarray(0,rt),ri); ri+=rt; }
  }
  if (callAvailable > callCap) reasons.push('global-call-edge-budget');
  if (refAvailable > refCap) reasons.push('global-reference-budget');

  let remainingKinds=Math.max(0,Number(limits.kindWords)||0), words=0, kindsCovered=0;
  const kindRegions=[];
  for (const scan of ordered) {
    const regionWords=Math.max(0,Number(scan.words)||0), src=scan.kinds || new Uint8Array(0);
    const sourceCovered=Math.max(0,Math.min(Number(scan.kindsCovered ?? src.length)||0,src.length,regionWords));
    const take=Math.min(sourceCovered,remainingKinds);
    const kinds=take>0 ? src.slice(0,take) : new Uint8Array(0);
    kindRegions.push({ regionId:scan.regionId ?? null, vmAddr:BigInt(scan.vmAddr ?? 0), words:regionWords, kinds, kindsCovered:take });
    words += regionWords; kindsCovered += take; remainingKinds -= take;
    if (take < sourceCovered || take < regionWords) reasons.push(`${scan.regionId || 'region'}:kind-stat-budget`);
  }

  const uniqueReasons=[...new Set(reasons.filter(Boolean))];
  const unsupported=ordered.length>0 && ordered.every((x)=>x.unsupported===true);
  const callsCapped=callAvailable>callCap || ordered.some((x)=>x.callsCapped);
  const refsCapped=refAvailable>refCap || ordered.some((x)=>x.refsCapped);
  const complete=!unsupported && uniqueReasons.length===0 && expectedRegions.length===ordered.length;
  return {
    vmAddr: ordered.length ? BigInt(ordered[0].vmAddr ?? 0) : (expectedRegions[0]?.vmAddr ?? 0n),
    regions: expectedRegions,
    kindRegions,
    callFrom, callTo, callCount:ci,
    refFrom, refTo, refKind, refCount:ri,
    kinds:new Uint8Array(0), kindsCovered, words,
    callsCapped, refsCapped, unsupported,
    architecture: ordered.find((x)=>x.architecture || x.arch)?.architecture || ordered.find((x)=>x.arch)?.arch || null,
    complete, truncated:!complete,
    completeness:{ complete, reasons:uniqueReasons, regionCount:ordered.length, expectedRegionCount:expectedRegions.length,
      limits:{calls:callCap,refs:refCap,kindWords:Number(limits.kindWords)||0} },
  };
}

function completeness(array, capped, source, queryLimited = false, unavailableReason = null) {"""
if anchor not in s: raise SystemExit('program merge insertion anchor missing')
s=s.replace(anchor,insert,1)
p.write_text(s)

replace('js/program.js', """    this.region = region || null;
    this.symbols = symbols || null;
    this.vmAddr = s.vmAddr != null ? s.vmAddr : (region ? region.vmAddr : 0n);""", """    this.region = region || null;
    this.regions = Array.isArray(s.regions) && s.regions.length ? s.regions.map((r)=>({ ...r, vmAddr:BigInt(r.vmAddr ?? 0), size:BigInt(r.size ?? 0) })) : (region ? [region] : []);
    this.symbols = symbols || null;
    this.vmAddr = s.vmAddr != null ? s.vmAddr : (region ? region.vmAddr : 0n);""", '#560 ProgramIndex regions')

replace('js/program.js', """    this.kinds = s.kinds || new Uint8Array(0);
    this.kindsCovered = s.kindsCovered || 0;
    this.callsCapped = !!s.callsCapped;
    this.refsCapped = !!s.refsCapped;
    this.words = s.words || 0;""", """    const singleKinds=s.kinds || new Uint8Array(0);
    this.kindRegions = Array.isArray(s.kindRegions) && s.kindRegions.length
      ? s.kindRegions.map((k)=>({ regionId:k.regionId ?? null, vmAddr:BigInt(k.vmAddr ?? 0), words:Math.max(0,Number(k.words)||0), kinds:k.kinds||new Uint8Array(0), kindsCovered:Math.max(0,Number(k.kindsCovered)||0) }))
      : (singleKinds.length || s.words ? [{ regionId:s.regionId ?? region?.id ?? null, vmAddr:BigInt(s.vmAddr ?? region?.vmAddr ?? 0), words:Math.max(0,Number(s.words)||0), kinds:singleKinds, kindsCovered:Math.max(0,Number(s.kindsCovered)||0) }] : []);
    this.kinds = this.kindRegions.length===1 ? this.kindRegions[0].kinds : singleKinds;
    this.kindsCovered = this.kindRegions.length ? this.kindRegions.reduce((n,k)=>n+k.kindsCovered,0) : (s.kindsCovered || 0);
    this.callsCapped = !!s.callsCapped;
    this.refsCapped = !!s.refsCapped;
    this.words = this.kindRegions.length ? this.kindRegions.reduce((n,k)=>n+k.words,0) : (s.words || 0);""", '#560 kind region state')

replace('js/program.js', """  get statsComplete() { return !this.unsupported && this.completeness.complete !== false && this.kindsCovered >= this.words; }""", """  get statsComplete() {
    if (this.unsupported || this.completeness.complete === false) return false;
    return this.kindRegions.length ? this.kindRegions.every((k)=>k.kindsCovered>=k.words) : this.kindsCovered>=this.words;
  }""", '#560 stats completeness')

replace('js/program.js', """  functionRange(addr) {
    if (!this.symbols || !this.symbols.functionCount) return null;
    const fn = this.symbols.functionAt(addr);
    if (!fn) return null;
    return { start: fn.start, end: fn.end != null ? fn.end : (this.region ? this.region.vmAddr + this.region.size : null) };
  }""", """  _regionFor(addr) {
    const a=BigInt(addr);
    return this.regions.find((r)=>a>=BigInt(r.vmAddr) && a<BigInt(r.vmAddr)+BigInt(r.size)) || null;
  }
  functionRange(addr) {
    if (!this.symbols || !this.symbols.functionCount) return null;
    const fn = this.symbols.functionAt(addr);
    if (!fn) return null;
    const owner=this._regionFor(fn.start) || this.region;
    return { start: fn.start, end: fn.end != null ? fn.end : (owner ? BigInt(owner.vmAddr) + BigInt(owner.size) : null), region:owner };
  }""", '#560 function region ownership')

# Finish #561: refsFrom must also propagate base unsupported/incomplete truth.
replace('js/program.js', """    return completeness(out, this.refsCapped, 'refs', queryLimited);
  }
  statsOf(start, end) {""", """    return completeness(out, this.refsCapped, 'refs', queryLimited, this.queryIncompleteReason);
  }
  statsOf(start, end) {""", '#561 refsFrom completeness')

# Multi-region stats use the owning region's kind vector rather than one __text base.
p=Path('js/program.js'); s=p.read_text()
start=s.index('  statsOf(start, end) {')
end=s.index('\n  mostCalled(limit = 20) {',start)
new_stats="""  statsOf(start, end) {
    const stats = { total: 0, covered: true, arith: 0, mul: 0, div: 0, logic: 0, shift: 0, farith: 0, fmul: 0, fconv: 0, simd: 0, load: 0, store: 0, cmp: 0, condbr: 0, branch: 0, call: 0, indcall: 0, ret: 0, csel: 0, atomic: 0, movimm: 0, adrp: 0, trap: 0, other: 0 };
    if (this.unsupported) { stats.covered = false; stats.unsupported = true; stats.incompleteReason = 'unsupported-program-analysis'; return stats; }
    const lastAddr=end!=null?BigInt(end):BigInt(start)+4n;
    const spans=this.kindRegions.length?this.kindRegions:[{vmAddr:BigInt(this.vmAddr||0),words:this.words,kinds:this.kinds,kindsCovered:this.kindsCovered}];
    const span=spans.find((k)=>BigInt(start)>=k.vmAddr && BigInt(start)<k.vmAddr+BigInt(k.words)*4n);
    if(!span || !span.kinds.length){stats.covered=false;return stats;}
    const spanEnd=span.vmAddr+BigInt(span.words)*4n;
    const boundedEnd=lastAddr>spanEnd?spanEnd:lastAddr;
    if(lastAddr>spanEnd)stats.covered=false;
    const first=Number((BigInt(start)-span.vmAddr)/4n);
    let last=Number((boundedEnd-span.vmAddr+3n)/4n);
    if(!(first>=0)){stats.covered=false;return stats;}
    if(last>span.kindsCovered){last=span.kindsCovered;stats.covered=false;}
    for (let i = first; i < last; i++) {
      const k = span.kinds[i]; stats.total++;
      switch (k) {
        case KIND.ARITH: stats.arith++; break; case KIND.MUL: stats.mul++; break; case KIND.DIV: stats.div++; break;
        case KIND.LOGIC: stats.logic++; break; case KIND.SHIFT: stats.shift++; break; case KIND.FARITH: stats.farith++; break;
        case KIND.FMUL: stats.fmul++; break; case KIND.FCONV: stats.fconv++; break; case KIND.SIMD: stats.simd++; break;
        case KIND.LOAD: stats.load++; break; case KIND.STORE: stats.store++; break; case KIND.CMP: stats.cmp++; break;
        case KIND.CONDBR: stats.condbr++; break; case KIND.BRANCH: stats.branch++; break; case KIND.CALL: stats.call++; break;
        case KIND.INDCALL: stats.indcall++; break; case KIND.RET: stats.ret++; break; case KIND.CSEL: stats.csel++; break;
        case KIND.ATOMIC: stats.atomic++; break; case KIND.MOVIMM: stats.movimm++; break; case KIND.ADRP: stats.adrp++; break;
        case KIND.TRAP: stats.trap++; break; case KIND.OTHER: stats.other++; break; default: break;
      }
    }
    stats.numeric = stats.mul + stats.div + stats.fmul + stats.farith;
    stats.memory = stats.load + stats.store;
    return stats;
  }"""
s=s[:start]+new_stats+s[end:]
p.write_text(s)

# Backend exposes optional per-region limits used by the app's global budget.
replace('js/backend.js', """  scanProgram(regionId, onProgress) { return this.call('scanProgram', { regionId }, null, onProgress); }""", """  scanProgram(regionId, onProgress, limits = {}) { return this.call('scanProgram', { regionId, ...limits }, null, onProgress); }""", '#560 backend scan limits')

# Classic worker honors region shares and transfers exact-sized arrays.
replace('js/worker-legacy.js', """async function scanProgram({ regionId, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const total = Number(region.size);
  const words = Math.floor(total / 4);

  const initial = Math.min(words, EDGES_INITIAL);
  let callFrom = new BigUint64Array(initial);
  let callTo = new BigUint64Array(initial);
  let refFrom = new BigUint64Array(initial);
  let refTo = new BigUint64Array(initial);
  let refKind = new Uint8Array(initial);
  const kinds = new Uint8Array(Math.min(words, MAX_KIND_WORDS));""", """async function scanProgram({ regionId, requestId, epoch, callLimit, refLimit, kindLimit }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const total = Number(region.size);
  const words = Math.floor(total / 4);
  const capOf=(value,hard)=>value==null?hard:Math.max(0,Math.min(hard,Math.floor(Number(value)||0)));
  const callCap=capOf(callLimit,MAX_EDGES), refCap=capOf(refLimit,MAX_REFS), kindCap=capOf(kindLimit,MAX_KIND_WORDS);

  const callInitial = Math.min(words, EDGES_INITIAL, callCap);
  const refInitial = Math.min(words, EDGES_INITIAL, refCap);
  let callFrom = new BigUint64Array(callInitial);
  let callTo = new BigUint64Array(callInitial);
  let refFrom = new BigUint64Array(refInitial);
  let refTo = new BigUint64Array(refInitial);
  let refKind = new Uint8Array(refInitial);
  const kinds = new Uint8Array(Math.min(words, kindCap));""", '#560 worker scan limits')
replace('js/worker-legacy.js', """    const size = Math.min(Math.max(1, callFrom.length * 2), MAX_EDGES);""", """    const size = Math.min(Math.max(1, callFrom.length * 2), MAX_EDGES, callCap);""", '#560 worker call growth')
replace('js/worker-legacy.js', """    const size = Math.min(Math.max(1, refFrom.length * 2), MAX_REFS);""", """    const size = Math.min(Math.max(1, refFrom.length * 2), MAX_REFS, refCap);""", '#560 worker ref growth')

p=Path('js/worker-legacy.js'); s=p.read_text()
old="""  return {
    regionId,
    vmAddr: region.vmAddr,
    words,
    callFrom, callTo, callCount: nCalls,
    refFrom, refTo, refKind, refCount: nRefs,
    kinds,
    kindsCovered: Math.min(words, kinds.length),
    callsCapped, refsCapped,
    cancelled: false,
    complete: truncationReasons.length === 0,
    truncated: truncationReasons.length > 0,
    truncationReason: truncationReasons[0] || null,
    completeness: { complete: truncationReasons.length === 0, reasons: truncationReasons, memoryBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES, allocatedBytes: allocatedBytes() },
    __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer],
  };"""
new="""  const outCallFrom=callFrom.slice(0,nCalls), outCallTo=callTo.slice(0,nCalls);
  const outRefFrom=refFrom.slice(0,nRefs), outRefTo=refTo.slice(0,nRefs), outRefKind=refKind.slice(0,nRefs);
  const outKinds=kinds.slice(0,Math.min(words,kinds.length));
  return {
    regionId,
    vmAddr: region.vmAddr,
    words,
    callFrom:outCallFrom, callTo:outCallTo, callCount: nCalls,
    refFrom:outRefFrom, refTo:outRefTo, refKind:outRefKind, refCount: nRefs,
    kinds:outKinds,
    kindsCovered: Math.min(words, outKinds.length),
    callsCapped, refsCapped,
    cancelled: false,
    complete: truncationReasons.length === 0,
    truncated: truncationReasons.length > 0,
    truncationReason: truncationReasons[0] || null,
    completeness: { complete: truncationReasons.length === 0, reasons: truncationReasons, memoryBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES, allocatedBytes: allocatedBytes() },
    __transfer: [outCallFrom.buffer, outCallTo.buffer, outRefFrom.buffer, outRefTo.buffer, outRefKind.buffer, outKinds.buffer],
  };"""
if old not in s: raise SystemExit('#560 worker return anchor missing')
p.write_text(s.replace(old,new,1))

# Platform unsupported scans retain requested region identity for aggregate completeness.
replace('js/platform/worker.js', """    case 'scanProgram': return emptyProgramScan();""", """    case 'scanProgram': return emptyProgramScan(msg.regionId);""", '#560 platform region identity')
replace('js/platform/worker.js', """function emptyProgramScan() {""", """function emptyProgramScan(regionId = null) {""", '#560 platform empty signature')
replace('js/platform/worker.js', """  return { callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0,""", """  return { regionId, callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0,""", '#560 platform empty region')

# App: import merger and scan every file-backed executable region with global fair shares.
replace('js/app.js', """import { ProgramIndex } from './program.js';""", """import { ProgramIndex, mergeProgramScans, PROGRAM_MERGE_LIMITS } from './program.js';""", '#560 app program import')
replace('js/app.js', """const $ = (id) => document.getElementById(id);""", """const $ = (id) => document.getElementById(id);
const FUNCTION_DISCOVERY_GLOBAL_CAP = 400_000;""", '#560 app function cap')

p=Path('js/app.js'); s=p.read_text()
start=s.index('  /** コードのセクション（__text 優先）。 */')
end=s.index('\n  /**\n   * 値の「ふるまい」をコード全体から集める。',start)
new_block="""  /** 全体解析の対象になる、active slice内のfile-backed executable regions。 */
  programRegions() {
    const candidates=(this.store.get('regions')||[]).filter((r)=>r?.exec===true && r.size>0n && !r.zerofill);
    const sectioned=candidates.filter((r)=>!!r.section);
    const source=sectioned.length?sectioned:candidates;
    const seen=new Set(), out=[];
    for(const r of source){
      const key=`${String(r.fileOffset??'')}|${String(r.vmAddr??'')}|${String(r.size??'')}`;
      if(seen.has(key))continue; seen.add(key); out.push(r);
    }
    out.sort((a,b)=>a.vmAddr<b.vmAddr?-1:a.vmAddr>b.vmAddr?1:String(a.id||'').localeCompare(String(b.id||'')));
    return out;
  }

  /** UIの既定コードregion（全体解析自体は programRegions() 全件を使う）。 */
  codeRegion() {
    const regions=this.programRegions();
    return regions.find((r)=>r.section==='__text') || regions[0] || this.store.get('currentRegion') || null;
  }

  /**
   * 関数の切れ目をactive sliceの全exec regionで補完する。
   * exact seedの正確さと一覧の網羅性は分離し、全region走査済みの時だけcompleteにする。
   */
  async ensureFunctions(region, onProgress) {
    const epoch=this.backend.gen;
    if(this.symbolsReady){try{await this.symbolsReady;}catch{/* names are optional */}}
    if(epoch!==this.backend.gen)return null;
    if(this.symbols===EMPTY_INDEX){this.symbols=new SymbolIndex({regions:this.store.get('regions')||[]});this.viewer.setSymbols(this.symbols);}
    const sym=this.symbols;
    if(!sym || sym.functionStartsComplete===true || sym.functionDiscovery?.complete===true)return sym;
    const targets=this.programRegions();
    if(region && region.exec && !targets.some((r)=>r.id===region.id))targets.push(region);
    if(!targets.length)return sym;
    const regionSetKey=targets.map((r)=>r.id).join('|');
    if(sym.functionDiscovery?.attempted===true && sym.functionDiscovery?.regionSetKey===regionSetKey)return sym;

    let remaining= Math.max(0, FUNCTION_DISCOVERY_GLOBAL_CAP - Math.min(FUNCTION_DISCOVERY_GLOBAL_CAP, sym.functionCount||0));
    let remainingBytes=targets.reduce((n,r)=>n+BigInt(r.size),0n);
    const results=[], reasons=[];
    for(let i=0;i<targets.length;i++){
      if(epoch!==this.backend.gen)return null;
      const r=targets[i], size=BigInt(r.size), share=remaining>0&&remainingBytes>0n
        ? Math.max(1,Math.min(remaining,Number((BigInt(remaining)*size+remainingBytes-1n)/remainingBytes))) : 0;
      if(share<=0){reasons.push(`function-global-budget:${r.id}`);results.push({regionId:r.id,complete:false,skipped:true});remainingBytes-=size;continue;}
      try{
        const res=await this.backend.guessFunctions(r.id,share,onProgress&&((p)=>onProgress({phase:'functions',done:i+(p.all?Math.min(1,p.done/p.all):0),all:targets.length,region:r.id})));
        if(epoch!==this.backend.gen)return null;
        if(res?.starts?.length){sym.addFunctions(res.starts,{source:'heuristic',confidence:0.55,confirmed:false});sym.guessed=true;remaining=Math.max(0,remaining-res.starts.length);}
        const complete=res?.discoveryComplete===true || res?.completeness?.complete===true || res?.complete===true;
        results.push({regionId:r.id,complete,capped:!!res?.capped,discovered:res?.starts?.length||0});
        if(!complete)reasons.push(`${r.id}:${res?.completeness?.reason||res?.truncationReason||'function-discovery-incomplete'}`);
      }catch{results.push({regionId:r.id,complete:false,error:true});reasons.push(`${r.id}:function-discovery-failed`);}
      remainingBytes-=size;
    }
    const complete=results.length===targets.length && results.every((x)=>x.complete===true);
    sym.functionDiscovery={complete,attempted:true,regionSetKey,regions:results,reasons:[...new Set(reasons)],capped:results.some((x)=>x.capped)};
    sym.functionStartsComplete=complete;
    sym.functionStartsCapped=sym.functionDiscovery.capped || reasons.some((x)=>x.includes('budget'));
    this.viewer.setSymbols(sym);
    return sym;
  }

  /** Build one global ProgramIndex from every executable region. */
  async ensureProgram(onProgress) {
    const regions=this.programRegions();
    if(!regions.length)return null;
    const key=regions.map((r)=>r.id).join('|');
    const primary=regions.find((r)=>r.section==='__text')||regions[0];
    if(this.program&&this.programKey===key&&this.program.gen===this.symbols.gen)return this.program;
    if(this.programScan&&this.programKey===key){this.program=new ProgramIndex(this.programScan,this.symbols,primary);return this.program;}
    const epoch=this.backend.gen;
    if(this.programBusy&&this.programBusyEpoch===epoch)return this.programBusy;
    this.programBusyEpoch=epoch;
    this.programBusy=(async()=>{
      await this.ensureFunctions(primary,onProgress);
      if(epoch!==this.backend.gen)return null;
      const scans=[], failures=[];
      let calls=PROGRAM_MERGE_LIMITS.calls, refs=PROGRAM_MERGE_LIMITS.refs, kinds=PROGRAM_MERGE_LIMITS.kindWords;
      let remainingBytes=regions.reduce((n,r)=>n+BigInt(r.size),0n);
      const share=(remaining,size,total)=>remaining>0&&total>0n?Math.max(1,Math.min(remaining,Number((BigInt(remaining)*size+total-1n)/total))):0;
      for(let i=0;i<regions.length;i++){
        const r=regions[i], size=BigInt(r.size);
        if(epoch!==this.backend.gen)return null;
        try{
          const scan=await this.backend.scanProgram(r.id,onProgress&&((p)=>onProgress({phase:'scan',done:i+(p.all?Math.min(1,p.done/p.all):0),all:regions.length,region:r.id})),{
            callLimit:share(calls,size,remainingBytes),refLimit:share(refs,size,remainingBytes),kindLimit:share(kinds,size,remainingBytes),
          });
          if(scan&&!scan.cancelled){scans.push(scan);calls=Math.max(0,calls-(scan.callCount??scan.callFrom?.length??0));refs=Math.max(0,refs-(scan.refCount??scan.refFrom?.length??0));kinds=Math.max(0,kinds-(scan.kindsCovered??scan.kinds?.length??0));}
          else failures.push(`${r.id}:program-scan-cancelled`);
        }catch{failures.push(`${r.id}:program-scan-failed`);}
        remainingBytes-=size;
      }
      if(epoch!==this.backend.gen)return null;
      const merged=mergeProgramScans(scans,{regions,reasons:failures,limits:PROGRAM_MERGE_LIMITS});
      this.programScan=merged;this.programKey=key;this.program=new ProgramIndex(merged,this.symbols,primary);
      return this.program;
    })().finally(()=>{if(this.programBusyEpoch===epoch){this.programBusy=null;this.programBusyEpoch=-1;}});
    return this.programBusy;
  }
"""
s=s[:start]+new_block+s[end:]
p.write_text(s)

print('applied issue #560 + #561 completion')
