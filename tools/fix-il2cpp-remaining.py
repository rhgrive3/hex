from pathlib import Path

p=Path('js/il2cpp.js')
s=p.read_text()
anchor="const REQUIRED_HEADER_BYTES = 8 + (Math.max(...Object.values(PAIR)) + 1) * 8;\n"
helpers=r'''
export const MAX_IL2CPP_METADATA_BYTES = 64 * 1024 * 1024;
const DEFAULT_METADATA_BUDGET = Object.freeze({
  maxInputBytes: MAX_IL2CPP_METADATA_BYTES,
  maxOperations: 3_000_000,
  maxOutputObjects: 300_000,
  maxEstimatedHeapBytes: 96 * 1024 * 1024,
  wallMs: 2500,
});
const DEFAULT_BINDING_BUDGET = Object.freeze({
  maxScanBytes: 32 * 1024 * 1024,
  maxOperations: 3_000_000,
  maxCandidates: 5000,
  maxExtraReads: 12_000,
  maxExtraReadBytes: 64 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  wallMs: 3500,
});

function budgetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
function metadataBudget(options = {}, inputBytes = 0) {
  const limit = { ...DEFAULT_METADATA_BUDGET, ...(options.budget || options.metadataBudget || {}) };
  const started = nowMs();
  let operations = 0, objects = 0, heap = 0;
  const check = (ops = 0, addObjects = 0, addHeap = 0) => {
    operations += ops; objects += addObjects; heap += addHeap;
    if (options.signal?.aborted) throw budgetError('ABORT_ERR', 'IL2CPP metadata parsing was cancelled.');
    if (inputBytes > limit.maxInputBytes) throw budgetError('IL2CPP_METADATA_BUDGET', `global-metadata.dat is too large (${inputBytes} bytes).`);
    if (operations > limit.maxOperations || objects > limit.maxOutputObjects || heap > limit.maxEstimatedHeapBytes || nowMs() - started > limit.wallMs) {
      throw budgetError('IL2CPP_METADATA_BUDGET', 'IL2CPP metadata parsing exceeded its safety budget.');
    }
  };
  check();
  return { limit, check, snapshot:()=>({ operations, objects, estimatedHeapBytes:heap, elapsedMs:nowMs()-started }) };
}
function bindingBudget(options = {}) {
  const limit = { ...DEFAULT_BINDING_BUDGET, ...(options.budget || options.bindingBudget || {}) };
  if (Number.isFinite(options.scanLimit)) limit.maxScanBytes = Math.min(limit.maxScanBytes, Math.max(0, Number(options.scanLimit)));
  const started = nowMs();
  let operations=0, scanBytes=0, candidates=0, extraReads=0, extraReadBytes=0;
  const check = (ops=0) => {
    operations += ops;
    if (options.signal?.aborted) throw budgetError('ABORT_ERR','IL2CPP method binding was cancelled.');
    if (operations > limit.maxOperations || nowMs()-started > limit.wallMs) throw budgetError('IL2CPP_BINDING_BUDGET','IL2CPP method binding exceeded its safety budget.');
  };
  const consumeScan = (bytes) => {
    check();
    if (scanBytes + bytes > limit.maxScanBytes) throw budgetError('IL2CPP_BINDING_BUDGET','IL2CPP scan-byte budget exhausted.');
    scanBytes += bytes;
  };
  const consumeCandidate = () => {
    check(); candidates++;
    if (candidates > limit.maxCandidates) throw budgetError('IL2CPP_BINDING_BUDGET','IL2CPP candidate budget exhausted.');
  };
  const consumeExtraRead = (bytes) => {
    check(); extraReads++; extraReadBytes += bytes;
    if (extraReads > limit.maxExtraReads || extraReadBytes > limit.maxExtraReadBytes) throw budgetError('IL2CPP_BINDING_BUDGET','IL2CPP extra-read budget exhausted.');
  };
  return { limit, check, consumeScan, consumeCandidate, consumeExtraRead, snapshot:()=>({ operations,scanBytes,candidates,extraReads,extraReadBytes,elapsedMs:nowMs()-started }) };
}
function cooperativeYield() { return new Promise((resolve)=>setTimeout(resolve,0)); }
'''
if 'MAX_IL2CPP_METADATA_BYTES' not in s:
    if anchor not in s: raise SystemExit('top anchor missing')
    s=s.replace(anchor,anchor+helpers,1)

start=s.index('function parseLayout(ctx,layout)')
end=s.index('\nexport function looksLikeUnity',start)
parser=r'''function recordCount(pair, size) {
  if (!pair || size < 8 || pair.size % size !== 0) return null;
  return Math.floor(pair.size / size);
}
function sampleIndices(count, max = 256) {
  if (count <= max) return Array.from({length:count},(_,i)=>i);
  const out=[]; for(let i=0;i<max;i++) out.push(Math.floor(i*(count-1)/(max-1)));
  return [...new Set(out)];
}
function scoreLayout(ctx, layout, budget) {
  const typeDefs=ctx.pair('typeDefinitions'), methodDefs=ctx.pair('methods');
  const typeCount=recordCount(typeDefs,layout.type), methodCount=recordCount(methodDefs,layout.method);
  if(typeCount==null||methodCount==null||typeCount>200000||methodCount>500000)return null;
  const stringAt=makeStringAt(ctx), tokenAt=ctx.version>=27?24:40;
  let validTypeNames=0, validOwners=0, validMethodNames=0, validTokens=0;
  const ti=sampleIndices(typeCount), mi=sampleIndices(methodCount);
  for(const i of ti){ budget.check(1); const o=typeDefs.offset+i*layout.type; if(o+8>typeDefs.end)return null; if(stringAt(ctx.dv.getInt32(o,true)))validTypeNames++; }
  for(const i of mi){
    budget.check(1); const o=methodDefs.offset+i*layout.method; if(o+8>methodDefs.end)return null;
    const owner=ctx.dv.getInt32(o+4,true), name=stringAt(ctx.dv.getInt32(o,true));
    if(owner>=0&&owner<typeCount)validOwners++; if(!name)continue; validMethodNames++;
    const token=o+tokenAt+4<=o+layout.method?ctx.dv.getUint32(o+tokenAt,true):0;
    if((token>>>24)===0x06||token===0)validTokens++;
  }
  const score=(validTypeNames/Math.max(1,ti.length))*4+(validMethodNames/Math.max(1,mi.length))*3+(validOwners/Math.max(1,mi.length))*5+(validTokens/Math.max(1,validMethodNames))*2;
  return { layout, score, typeCount, methodCount };
}
function parseLayout(ctx,layout,budget){
  const {dv,version}=ctx,stringAt=makeStringAt(ctx),warnings=[];
  const typeDefs=ctx.pair('typeDefinitions'),methodDefs=ctx.pair('methods');
  const typeCount=recordCount(typeDefs,layout.type),methodCount=recordCount(methodDefs,layout.method);
  if(typeCount==null||methodCount==null||typeCount>200000||methodCount>500000)return null;
  const literalCount=Math.floor((ctx.pair('stringLiteral')?.size||0)/8);
  const imagePair=ctx.pair('images');
  const estimatedObjects=typeCount+methodCount+Math.min(literalCount,200000)+Math.min(Math.floor((imagePair?.size||0)/24),10000);
  budget.check(0,estimatedObjects,estimatedObjects*192);
  const classes=[];let validTypeNames=0;
  for(let i=0;i<typeCount;i++){
    if((i&1023)===0)budget.check(1024);
    const o=typeDefs.offset+i*layout.type;if(o<typeDefs.offset||o+8>typeDefs.end)return null;
    const name=stringAt(dv.getInt32(o,true)),ns=stringAt(dv.getInt32(o+4,true));
    if(!name)continue;validTypeNames++;
    classes.push({index:i,name,namespace:ns||'',full:ns?ns+'.'+name:name});
  }
  const methods=[];let validOwners=0,validTokens=0,validMethodNames=0;
  const tokenAt=version>=27?24:40;
  for(let i=0;i<methodCount;i++){
    if((i&1023)===0)budget.check(1024);
    const o=methodDefs.offset+i*layout.method;if(o<methodDefs.offset||o+8>methodDefs.end)return null;
    const name=stringAt(dv.getInt32(o,true)),owner=dv.getInt32(o+4,true);
    if(owner<0||owner>=typeCount)continue;validOwners++;
    if(!name)continue;validMethodNames++;
    const token=o+tokenAt+4<=o+layout.method?dv.getUint32(o+tokenAt,true):0;
    if((token>>>24)===0x06||token===0)validTokens++;
    methods.push({index:i,name,classIndex:owner,token});
  }
  const byIndex=new Map(classes.map((c)=>[c.index,c]));
  for(const m of methods){budget.check(1);const c=byIndex.get(m.classIndex);m.className=c?c.full:null;m.full=(c?c.full+'::':'')+m.name;}
  const images=parseImages(ctx,ctx.pair('images'),stringAt,typeCount,budget);
  const literals=parseLiterals(ctx,budget);
  const score=(validTypeNames/Math.max(1,typeCount))*4+(validMethodNames/Math.max(1,methodCount))*3+(validOwners/Math.max(1,methodCount))*5+(validTokens/Math.max(1,validMethodNames))*2+(images.length?1:0);
  return{version,classes,methods,literals,images,warnings,typeSize:layout.type,methodSize:layout.method,layout:layout.label,_layoutScore:score,_counts:{typeCount,methodCount}};
}

function parseLiterals(ctx,budget){
  const index=ctx.pair('stringLiteral'),data=ctx.pair('stringLiteralData'),out=[];
  if(!index.size||!data.size||index.size%8!==0)return out;
  const count=Math.floor(index.size/8);
  if(count>200000)throw budgetError('IL2CPP_METADATA_BUDGET','Too many IL2CPP string literals.');
  for(let i=0;i<count;i++){
    if((i&1023)===0)budget.check(1024);
    const o=index.offset+i*8;if(o+8>index.end)break;
    const len=ctx.dv.getInt32(o,true),off=ctx.dv.getInt32(o+4,true);
    if(len<0||len>1<<16||off<0||off+len>data.size)continue;
    const text=utf8(ctx.u8.subarray(data.offset+off,data.offset+off+len));if(text!=null)out.push({index:i,text});
  }return out;
}

function parseImages(ctx,table,stringAt,typeCount,budget){
  if(!table||table.size<=0)return[];let best={score:-1,out:[]};
  for(const size of [40,32,24]){
    if(table.size%size!==0)continue;const count=Math.floor(table.size/size);
    if(count>10000)continue;
    const out=[];let validRanges=0,validNames=0;
    for(let i=0;i<count;i++){
      if((i&511)===0)budget.check(512);
      const o=table.offset+i*size;if(o<0||o+16>table.end)break;
      const name=stringAt(ctx.dv.getInt32(o,true)),typeStart=ctx.dv.getInt32(o+8,true),typeCountForImage=ctx.dv.getUint32(o+12,true);
      if(typeStart<0||typeCountForImage>2_000_000||typeStart>typeCount||typeStart+typeCountForImage>typeCount)continue;
      validRanges++;if(name)validNames++;if(name)out.push({index:i,name,typeStart,typeCount:typeCountForImage});
    }
    const score=validRanges*3+validNames*2-(count-validRanges)*4;if(score>best.score)best={score,out};
  }return best.out;
}

function chooseLayout(ctx,candidates,budget){
  const scored=[];
  for(const layout of candidates){let item;try{item=scoreLayout(ctx,layout,budget);}catch(error){throw error;}if(item)scored.push(item);}
  scored.sort((a,b)=>b.score-a.score || a.layout.type-b.layout.type || a.layout.method-b.layout.method);
  const best=scored[0],second=scored[1]; if(!best)return null;
  const expected=layoutCandidates(ctx.version)[0];
  // Exact probe ties are unsafe unless the version's canonical ABI layout is one
  // of the tied records. This keeps known versions deterministic while refusing
  // malformed cross-layout ambiguity.
  if(second && Math.abs(best.score-second.score)<1e-9) {
    const canonical=scored.find((x)=>x.layout.type===expected.type&&x.layout.method===expected.method&&Math.abs(x.score-best.score)<1e-9);
    if(canonical) return parseLayout(ctx,canonical.layout,budget);
    throw budgetError('IL2CPP_METADATA_AMBIGUOUS','metadata record layout is ambiguous.');
  }
  return parseLayout(ctx,best.layout,budget);
}

function parseMetadataCommon(buffer,candidates,options={}){
  const byteLength=buffer?.byteLength ?? buffer?.length ?? 0;
  const budget=metadataBudget(options,byteLength);
  const ctx=headerContext(buffer),res=chooseLayout(ctx,candidates,budget);
  if(!res)throw new Error('metadata record layoutを安全に判定できませんでした。');
  res.parseBudget=budget.snapshot();
  delete res._layoutScore;delete res._counts;
  return {ctx,res};
}

export function parseMetadata(buffer,options={}){
  const ctx0=headerContext(buffer), warnings=[];
  if(ctx0.version<16||ctx0.version>31)warnings.push('知らない版です（version '+ctx0.version+'）。読める範囲だけ出します。');
  const {ctx,res}=parseMetadataCommon(buffer,layoutCandidates(ctx0.version),options);
  res.warnings.unshift(...warnings);
  if(layoutCandidates(ctx.version).length>1)res.warnings.push(`metadata v${ctx.version} のsub-layoutを整合性検証して ${res.layout} と判定しました。`);
  if(!res.classes.length)res.warnings.push('クラスの一覧を取り出せませんでした（版が違う可能性があります）。');
  if(!res.methods.length)res.warnings.push('メソッドの一覧を取り出せませんでした。');
  return res;
}

export function parseMetadataAuto(buffer,options={}){
  const ctx=headerContext(buffer);
  const candidates=[...layoutCandidates(ctx.version),{type:92,method:40,label:'probe-92/40'},{type:96,method:52,label:'probe-96/52'},{type:100,method:56,label:'probe-100/56'},{type:88,method:40,label:'probe-88/40'}];
  const unique=[...new Map(candidates.map((x)=>[`${x.type}/${x.method}`,x])).values()];
  const {res}=parseMetadataCommon(buffer,unique,options);
  const expected=layoutCandidates(ctx.version)[0];
  if(res.typeSize!==expected.type||res.methodSize!==expected.method)res.warnings.push(`版の既定形ではなく、owner/token/range整合性が最も高い形（${res.typeSize} / ${res.methodSize} バイト）を採用しました。`);
  return res;
}

function parseMetadataWith(buffer,typeSize,methodSize,options={}){
  const {res}=parseMetadataCommon(buffer,[{type:Number(typeSize),method:Number(methodSize),label:'explicit'}],options); return res;
}
'''
s=s[:start]+parser+s[end:]

start=s.index('export async function bindMethodAddresses(meta, opts)')
binder=r'''function bindingFail(meta,budget,reason,message,extra={}) {
  if(message) meta.warnings.push(message);
  meta.methodBinding={kind:'unresolved',bound:0,verified:false,partial:budget.snapshot().scanBytes>0,truncated:true,reason,budget:budget.snapshot(),...extra};
  return {bound:0,candidate:null,reason,partial:true,truncated:true,...extra};
}
async function readExtra(ctx,addr,len) {
  ctx.budget.consumeExtraRead(len);
  const bytes=await Promise.resolve(ctx.read(addr,len)).catch(()=>null);
  if(!bytes || bytes.length<len) return null;
  return bytes;
}
async function scanDataChunks(ctx,minimum,visit) {
  const overlap=Math.max(48,minimum);
  let complete=true;
  for(const r of ctx.data){
    let offset=0n;
    while(offset<r.size){
      ctx.budget.check(1);
      const remaining=r.size-offset;
      const left=ctx.budget.limit.maxScanBytes-ctx.budget.snapshot().scanBytes;
      if(left<=0){complete=false;return complete;}
      const want=Math.min(Number(remaining>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):remaining),ctx.budget.limit.chunkBytes,left);
      if(want<minimum){complete=false;return complete;}
      ctx.budget.consumeScan(want);
      const bytes=await Promise.resolve(ctx.read(r.vmAddr+offset,want)).catch(()=>null);
      if(!bytes || bytes.length<minimum){complete=false;break;}
      await visit(r,offset,bytes);
      if(offset+BigInt(want)>=r.size)break;
      const advance=Math.max(8,want-overlap);
      offset+=BigInt(advance-(advance%8));
      await cooperativeYield();
    }
  }
  return complete;
}
async function pointerValues(ctx,table,count,indices) {
  const groups=new Map();
  for(const index of indices){if(index<0||index>=count)continue;const block=Math.floor(index/8192);if(!groups.has(block))groups.set(block,[]);groups.get(block).push(index);}
  const out=new Map();
  for(const [block,list] of groups){
    ctx.budget.check(list.length);
    const first=block*8192, entries=Math.min(8192,count-first), bytes=await readExtra(ctx,table+BigInt(first*8),entries*8);
    if(!bytes)return null;
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(const index of list)out.set(index,dv.getBigUint64((index-first)*8,true));
  }
  return out;
}

export async function bindMethodAddresses(meta, opts) {
  const o=opts||{}, regions=o.regions||[], read=o.read;
  if(!meta||!meta.methods||!meta.methods.length||typeof read!=='function')return{bound:0,candidate:null};
  meta.warnings ||= [];
  const budget=bindingBudget(o);
  const exec=regions.filter((r)=>r.exec&&r.size>0n);
  const data=regions.filter((r)=>!r.exec&&!r.zerofill&&r.size>=16n&&/__(const|data|data_const|rodata)/.test(r.section||''));
  const inExec=(raw)=>{let p=BigInt.asUintN(64,raw);p&=0x00ffffffffffffffn;return exec.some((r)=>p>=r.vmAddr&&p<r.vmAddr+r.size)?p:null;};
  const containing=(addr,bytes)=>regions.find((r)=>addr>=r.vmAddr&&addr+BigInt(bytes)<=r.vmAddr+r.size);
  const context={regions,data,exec,read,containing,inExec,budget};
  try{
    const modern=await bindCodeGenModules(meta,context,o);
    if(modern.bound)return{...modern,preferred:'codegen-modules'};
    if(modern.blocked)return modern;

    const expectedSlots=meta.methods.reduce((m,method)=>Math.max(m,Number(method.index)+1),0);
    const maxLegacyCount=expectedSlots+Math.max(32,Math.ceil(expectedSlots*0.01));
    const candidates=[],seen=new Set();
    const complete=await scanDataChunks(context,48,async(r,base,bytes)=>{
      const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      for(let at=0;at+48<=bytes.length;at+=8){
        budget.check(1);
        const addr=r.vmAddr+base+BigInt(at); if(seen.has(addr.toString()))continue;seen.add(addr.toString());
        const count64=dv.getBigUint64(at,true);if(count64<1n||count64>5_000_000n)continue;
        const count=Number(count64);if(count<expectedSlots||count>maxLegacyCount)continue;
        const table=dv.getBigUint64(at+8,true)&0x00ffffffffffffffn,sampleCount=Math.min(count,128);
        if(!containing(table,sampleCount*8))continue;
        let observed=0,proven=0;
        for(let pair=1;pair<=3;pair++){
          const pos=at+pair*16;if(pos+16>bytes.length)break;observed++;
          const n=dv.getBigUint64(pos,true),pointer=dv.getBigUint64(pos+8,true)&0x00ffffffffffffffn;
          if(n>=1n&&n<=5_000_000n&&containing(pointer,Math.min(Number(n),16)*8))proven++;
        }
        if(observed<2||proven<2)continue;
        const sample=await readExtra(context,table,sampleCount*8);if(!sample)continue;
        const sdv=new DataView(sample.buffer,sample.byteOffset,sample.byteLength);let executable=0,nonzero=0;
        for(let i=0;i<sampleCount;i++){budget.check(1);const raw=sdv.getBigUint64(i*8,true);if(raw)nonzero++;if(inExec(raw)!=null)executable++;}
        const ratio=executable/Math.max(1,nonzero);if(nonzero<Math.min(16,sampleCount)||ratio<0.95)continue;
        budget.consumeCandidate();
        const coveragePenalty=Math.abs(count-expectedSlots)/Math.max(1,expectedSlots);
        candidates.push({addr,table,count,ratio,structurePairs:proven,score:ratio+proven*0.04-coveragePenalty*0.5});
      }
    });
    if(!complete)return bindingFail(meta,budget,'scan-budget-exhausted','IL2CPP binding scanはbudget内に全候補を検証できなかったため、自動bindingしません。');
    candidates.sort((a,b)=>b.score-a.score||(a.addr<b.addr?-1:1));
    const best=candidates[0],second=candidates[1];
    if(!best){meta.warnings.push('Codegen moduleを検証した後も、構造証明できるlegacy Method→address表は見つかりませんでした。');return{bound:0,candidate:null,modernTried:true,reason:'no-proven-legacy-table'};}
    const margin=o.legacyAmbiguityMargin??0.08;
    if(second&&best.score-second.score<margin){meta.warnings.push(`Legacy method pointer候補が曖昧です（上位差 ${Math.max(0,best.score-second.score).toFixed(3)}）。自動bindingしません。`);return{bound:0,candidate:null,modernTried:true,reason:'ambiguous-legacy-table',ambiguousCandidates:Math.min(candidates.length,2)};}
    const needed=meta.methods.map((m)=>Number(m.index)).filter((x)=>x>=0&&x<best.count);
    const values=await pointerValues(context,best.table,best.count,needed);if(!values)return{bound:0,candidate:null,modernTried:true,reason:'legacy-table-unreadable'};
    const resolved=[];
    for(const method of meta.methods){const raw=values.get(Number(method.index));if(raw==null)continue;const address=inExec(raw);if(address!=null)resolved.push({method,address});}
    const minResolved=Math.min(8,meta.methods.length),coverage=resolved.length/Math.max(1,meta.methods.length);
    if(resolved.length<minResolved||coverage<0.5){meta.warnings.push(`Legacy method pointer表の全体整合性が不足しています（${resolved.length}/${meta.methods.length}）。自動bindingしません。`);return{bound:0,candidate:null,modernTried:true,reason:'legacy-coverage-insufficient'};}
    for(const {method,address} of resolved){method.address=address;method.binding='code-registration';method.bindingVerified=true;}
    const bound=resolved.length;
    meta.methodBinding={kind:'code-registration',bound,count:best.count,table:best.table,verified:true,evidence:['slot-coverage','registration-neighbors','executable-pointer-ratio','unique-candidate'],executableRatio:best.ratio,structurePairs:best.structurePairs,budget:budget.snapshot()};
    return{bound,candidate:best,modernTried:true,preferred:'verified-legacy'};
  }catch(error){
    if(error?.code==='ABORT_ERR')return bindingFail(meta,budget,'cancelled','IL2CPP method bindingをキャンセルしました。');
    if(error?.code==='IL2CPP_BINDING_BUDGET')return bindingFail(meta,budget,'binding-budget-exhausted','IL2CPP bindingは安全budgetを超えたため、自動bindingしません。');
    throw error;
  }
}

async function bindCodeGenModules(meta,ctx,o={}){
  const {data,containing,inExec,budget}=ctx,images=meta.images||[];if(!images.length)return{bound:0,candidate:null};
  const raw=[],seen=new Set();
  const complete=await scanDataChunks(ctx,24,async(r,base,bytes)=>{
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let at=0;at+24<=bytes.length;at+=8){
      budget.check(1);const addr=r.vmAddr+base+BigInt(at);if(seen.has(addr.toString()))continue;seen.add(addr.toString());
      const namePtr=dv.getBigUint64(at,true)&0x00ffffffffffffffn,count=dv.getUint32(at+8,true),table=dv.getBigUint64(at+16,true)&0x00ffffffffffffffn;
      if(!count||count>meta.methods.length+4096||!containing(namePtr,1)||!containing(table,Math.min(count,32)*8))continue;
      budget.consumeCandidate();raw.push({addr,namePtr,count,table});
    }
  });
  if(!complete)return{...bindingFail(meta,budget,'scan-budget-exhausted','CodeGenModule候補をbudget内に全走査できなかったため、自動bindingしません。'),blocked:true};
  const wanted=new Map(images.map((x)=>[x.name.toLowerCase(),x])),groups=new Map();
  for(const c of raw){
    const nameBytes=await readExtra(ctx,c.namePtr,160);if(!nameBytes)continue;const zero=nameBytes.indexOf(0);if(zero<0)continue;
    const name=utf8(nameBytes.subarray(0,zero)),key=name?.toLowerCase();if(!key||!wanted.has(key))continue;
    const sampleCount=Math.min(c.count,64),sample=await readExtra(ctx,c.table,sampleCount*8);if(!sample)continue;
    const dv=new DataView(sample.buffer,sample.byteOffset,sample.byteLength);let nonzero=0,executable=0;
    for(let i=0;i<sampleCount;i++){budget.check(1);const p=dv.getBigUint64(i*8,true);if(p)nonzero++;if(inExec(p)!=null)executable++;}
    if(!nonzero)continue;const executableRatio=executable/nonzero;if(executableRatio<0.85)continue;
    const image=wanted.get(key),methods=meta.methods.filter((m)=>m.classIndex>=image.typeStart&&m.classIndex<image.typeStart+image.typeCount&&m.token);
    const rids=methods.map((m)=>(m.token&0x00ffffff)-1).filter((rid)=>rid>=0);
    const covered=rids.filter((rid)=>rid<c.count).length,tokenCoverage=covered/Math.max(1,rids.length),maxRid=rids.length?Math.max(...rids):-1;
    const tail=maxRid>=0?Math.max(0,c.count-(maxRid+1)):c.count;
    const tailPenalty=maxRid>=0?Math.min(1,tail/Math.max(1,maxRid+1)):0;
    const score=executableRatio+tokenCoverage*0.75-tailPenalty*0.2;
    const item={...c,name,key,executableRatio,tokenCoverage,score,maxRid};
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);
  }
  const selected=new Map(),ambiguous=[];const margin=o.moduleAmbiguityMargin??0.10;
  for(const image of images){
    const key=image.name.toLowerCase(),list=(groups.get(key)||[]).sort((a,b)=>b.score-a.score||(a.addr<b.addr?-1:1));if(!list.length)continue;
    const best=list[0],second=list[1];
    if(best.tokenCoverage<0.95){ambiguous.push({image:image.name,reason:'token-coverage',candidates:list.length});continue;}
    if(second&&best.score-second.score<margin){ambiguous.push({image:image.name,reason:'candidate-margin',candidates:list.length,margin:best.score-second.score});continue;}
    selected.set(image.index,best);
  }
  if(ambiguous.length){meta.warnings.push(`CodeGenModule候補が一意に証明できないimageがあります: ${ambiguous.map((x)=>x.image).join(', ')}`);}
  if(!selected.size){
    if(ambiguous.length){meta.methodBinding={kind:'codegen-modules',bound:0,modules:0,verified:false,ambiguousModules:ambiguous,budget:budget.snapshot()};return{bound:0,candidate:null,modules:0,blocked:true,reason:'ambiguous-codegen-modules',ambiguousModules:ambiguous};}
    return{bound:0,candidate:null,modules:0};
  }
  const staged=[];
  for(const image of images){
    const mod=selected.get(image.index);if(!mod)continue;
    const methods=meta.methods.filter((m)=>m.classIndex>=image.typeStart&&m.classIndex<image.typeStart+image.typeCount&&m.token);
    const pairs=methods.map((method)=>({method,rid:(method.token&0x00ffffff)-1})).filter((x)=>x.rid>=0&&x.rid<mod.count);
    const values=await pointerValues(ctx,mod.table,mod.count,pairs.map((x)=>x.rid));if(!values)continue;
    for(const {method,rid} of pairs){const raw=values.get(rid);if(raw==null)continue;const address=inExec(raw);if(address!=null)staged.push({method,address,image,mod});}
  }
  for(const {method,address,mod} of staged){method.address=address;method.binding='codegen-module';method.bindingVerified=true;method.bindingEvidence={module:mod.name,score:mod.score,executableRatio:mod.executableRatio,tokenCoverage:mod.tokenCoverage};}
  const verified=ambiguous.length===0;
  meta.methodBinding={kind:'codegen-modules',bound:staged.length,modules:selected.size,verified,evidence:['image-name','token-rid','executable-pointer','candidate-uniqueness'],ambiguousModules:ambiguous,budget:budget.snapshot()};
  return{bound:staged.length,candidate:null,modules:selected.size,verified,blocked:ambiguous.length>0&&staged.length===0,ambiguousModules:ambiguous};
}
'''
s=s[:start]+binder+'\n'
p.write_text(s)

# UI preflight before arrayBuffer; parser/binder share AbortSignal.
p=Path('js/tools.js')
s=p.read_text()
s=s.replace("import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses } from './il2cpp.js';","import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';")
old="""        const f = picker.files && picker.files[0];
        if (!f) return;
        body.replaceChildren(el('div', { class:'hint' }, ['読み込んでいます…']));
        try {
          const meta = parseMetadataAuto(await f.arrayBuffer());
          await bindMethodAddresses(meta, {
            regions: app.store.get('regions') || [],
            read: (addr, len) => app.backend.readAt(addr, len).then(x => x.bytes),
          });"""
new="""        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > MAX_IL2CPP_METADATA_BYTES) {
          body.replaceChildren(el('div', { class:'hint' }, [`global-metadata.dat が大きすぎます (${Math.ceil(f.size/1024/1024)} MiB)。安全上 ${MAX_IL2CPP_METADATA_BYTES/1024/1024} MiB までです。`]));
          return;
        }
        const controller = new AbortController();
        body.replaceChildren(el('div', { class:'hint' }, ['読み込んでいます…']));
        try {
          const meta = parseMetadataAuto(await f.arrayBuffer(), { signal:controller.signal });
          await bindMethodAddresses(meta, {
            regions: app.store.get('regions') || [], signal:controller.signal,
            read: (addr, len) => app.backend.readAt(addr, len).then(x => x.bytes),
          });"""
if old not in s: raise SystemExit('tools il2cpp picker anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
