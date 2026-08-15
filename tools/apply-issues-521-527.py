from pathlib import Path
import re


def replace(path, old, new, label, count=1):
    p=Path(path);s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,count))

def replace_span(path, start_marker, end_marker, new, label):
    p=Path(path);s=p.read_text();a=s.find(start_marker)
    if a<0:raise SystemExit(f'{label} start missing in {path}')
    b=s.find(end_marker,a)
    if b<0:raise SystemExit(f'{label} end missing in {path}')
    p.write_text(s[:a]+new+s[b:])

# Exact fat-slice selection for canonical source parsing.
p=Path('js/binary/source-loaders.js');s=p.read_text()
s=s.replace("""  if (!fat) {
    const image = await parseSourceRanges(source, parseMachO, opts, withInitial(magic, ranges));
    return withStrings(image, source, opts);
  }""","""  if (!fat) {
    if (opts.sliceIndex != null && Number(opts.sliceIndex) !== 0) throw new Error(`Mach-O thin binary has no slice ${opts.sliceIndex}`);
    const image = await parseSourceRanges(source, parseMachO, opts, withInitial(magic, ranges));
    return withStrings(image, source, opts);
  }""",1)
s=s.replace("""  const valid = all.filter((slice) => slice.size > 0n && slice.offset <= source.size && slice.size <= source.size - slice.offset);
  const requested = opts.arch ? valid.find((slice) => sliceArchName(slice) === opts.arch) : null;
  if (opts.arch && !requested) throw new Error(`requested Mach-O architecture ${opts.arch} is not present in the universal binary`);
  const selected = requested || valid.find((slice) => sliceArchName(slice) === 'arm64e') || valid.find((slice) => sliceArchName(slice) === 'arm64') || valid.find((slice) => sliceArchName(slice) === 'x86_64') || valid[0];""","""  const valid = all.filter((slice) => slice.size > 0n && slice.offset <= source.size && slice.size <= source.size - slice.offset);
  const requestedIndex = opts.sliceIndex == null ? null : Number(opts.sliceIndex);
  if (requestedIndex != null && (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= all.length)) throw new Error(`invalid Mach-O slice index ${opts.sliceIndex}`);
  const indexed = requestedIndex == null ? null : all[requestedIndex];
  const selectedByIndex = indexed && indexed.size > 0n && indexed.offset <= source.size && indexed.size <= source.size - indexed.offset ? indexed : null;
  if (requestedIndex != null && !selectedByIndex) throw new Error(`Mach-O slice ${requestedIndex} is not readable`);
  const requested = opts.arch ? valid.find((slice) => sliceArchName(slice) === opts.arch) : null;
  if (opts.arch && !requested && requestedIndex == null) throw new Error(`requested Mach-O architecture ${opts.arch} is not present in the universal binary`);
  const selected = selectedByIndex || requested || valid.find((slice) => sliceArchName(slice) === 'arm64e') || valid.find((slice) => sliceArchName(slice) === 'arm64') || valid.find((slice) => sliceArchName(slice) === 'x86_64') || valid[0];""",1)
p.write_text(s)

# Platform worker performs canonical Mach-O linkage parsing off the main thread.
p=Path('js/platform/worker.js');s=p.read_text()
if "../macho-linkage.js" not in s:s=s.replace("import { hashByteSource } from './hash.js';","import { hashByteSource } from './hash.js';\nimport { normalizeMachOLinkage, MACHO_LINKAGE_LIMITS } from '../macho-linkage.js';",1)
s=s.replace("    case 'analyze': return analyzeImage();","    case 'analyze': return analyzeImage();\n    case 'machoAnalysis': return analyzeMachOFile(msg, signal);",1)
insert_at=s.index('\nfunction setRegions(list)')
helper=r'''
async function analyzeMachOFile(msg, signal) {
  const candidateFile=msg.file;
  if(!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size<=0) throw new Error('Mach-O canonical analysis requires a valid file.');
  const temporary=createSource(candidateFile);
  const cancellable={size:temporary.size,maxReadLength:temporary.maxReadLength,read:(offset,length,options={})=>temporary.read(offset,length,{...options,signal})};
  try {
    const selected=await openBinarySource(cancellable,{
      sliceIndex:msg.sliceIndex,
      ranges:{pageSize:64*1024,maxPageSize:2*1024*1024,maxCachedBytes:16*1024*1024,maxReads:4096},
    });
    if(signal.aborted)throw new Error('Canonical Mach-O analysis cancelled');
    if(selected?.format!=='macho')throw new Error('Canonical Mach-O parser did not return a Mach-O image');
    const result=analyzeImage(selected,{includeImportSites:true});
    result.linkage=normalizeMachOLinkage(selected);
    result.canonicalMetadata={machoMetadata:selected.metadata?.machoMetadata||null,chainedFixups:selected.metadata?.chainedFixups||null,dyldBindings:selected.metadata?.dyldBindings||null,exportTrie:selected.metadata?.exportTrie||null};
    result.architecture=selected.arch||null;
    return result;
  } finally { temporary.clear?.(); }
}
'''
s=s[:insert_at]+helper+s[insert_at:]
start=s.index('function analyzeImage() {');end=s.index('\nfunction emptyAnalysis()',start)
new_analyze=r'''function analyzeImage(sourceImage = image, options = {}) {
  if (!sourceImage) return emptyAnalysis();
  const entries = new Map();
  const addEntry=(address,name,kind=0,exported=false,source='binary-symbol')=>{
    if(address==null||!name)return;
    const addr=BigInt(address),key=addr.toString(),hit=entries.get(key);
    if(hit){
      if(!hit.name)hit.name=String(name);
      if(!hit.kind&&kind)hit.kind=kind;
      hit.exported=hit.exported||!!exported;
      if(hit.source==='binary-symbol'&&source!=='binary-symbol')hit.source=source;
      return;
    }
    if(entries.size>=MACHO_LINKAGE_LIMITS.mergedSymbols)return;
    entries.set(key,{address:addr,name:String(name),kind,exported:!!exported,source});
  };
  for (const symbol of sourceImage.symbols || []) addEntry(symbol?.address,symbol?.name,0,!!symbol?.exported,'binary-symbol');
  for (const exp of sourceImage.exports || []) if(exp?.address!=null&&BigInt(exp.address)!==0n)addEntry(exp.address,exp.name,0,true,exp.source||'export-table');
  if(options.includeImportSites){
    for(const imp of sourceImage.imports||[]){
      for(const site of imp?.sites||[])addEntry(site?.address,imp?.name,2,false,imp?.source||'macho-import');
    }
  }
  const sorted=[...entries.values()].sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:0);
  const addrs=new BigUint64Array(sorted.length),kinds=new Uint8Array(sorted.length),flags=new Uint8Array(sorted.length);
  for(let i=0;i<sorted.length;i++){addrs[i]=sorted[i].address;kinds[i]=sorted[i].kind||0;flags[i]=sorted[i].exported?1:0;}
  const seedByAddress=new Map();
  for(const seed of sourceImage.functions||[])if(seed?.address!=null)seedByAddress.set(BigInt(seed.address).toString(),seed);
  const functions=[...seedByAddress.keys()].map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);
  const funcs=new BigUint64Array(functions);
  const functionProvenance=functions.map((addr)=>{const seed=seedByAddress.get(addr.toString())||{};const confirmed=isExactFunctionSeed(seed);return{source:seed.source||'heuristic',confidence:Number(seed.confidence??(confirmed?1:0.5)),confirmed};});
  const nameProvenance=sorted.map((entry)=>({source:entry.source||'canonical-macho',confidence:1,confirmed:true}));
  const allSeedsExact=functions.length>0&&(sourceImage.functions||[]).every(isExactFunctionSeed);
  const discoveryComplete=sourceImage.metadata?.functionDiscovery?.complete===true;
  return {
    addrs,kinds,flags,names:sorted.map((x)=>String(x.name??'')),funcs,functionProvenance,nameProvenance,
    symbolCount:addrs.length,funcCount:funcs.length,capped:entries.size>=MACHO_LINKAGE_LIMITS.mergedSymbols,
    allSeedsExact,discoveryComplete,functionStartsExact:discoveryComplete&&allSeedsExact,
    functionDiscovery:{complete:discoveryComplete,capped:false,reasons:discoveryComplete?[]:['platform-function-seeds-not-exhaustive']},
    __transfer:[addrs.buffer,kinds.buffer,flags.buffer,funcs.buffer],
  };
}
'''
s=s[:start]+new_analyze+s[end:]
p.write_text(s)

# Backend merges canonical normalized truth with legacy ARM64 symbol/function transport.
p=Path('js/backend.js');s=p.read_text()
s=s.replace("import { augmentAnalysisResultWithChainedImports } from './chained.js';\n",'')
if "./macho-linkage.js" not in s:s=s.replace("import { AnalysisCache } from './cache/analysis-cache.js';","import { AnalysisCache } from './cache/analysis-cache.js';\nimport { mergeMachoAnalysisTruth, unavailableMachOLinkage } from './macho-linkage.js';",1)
old="""  analyze(sliceIndex) {
    const worker = this.formatId === 'macho' ? 'legacy' : 'platform';
    const file = this.file;
    return this._callTo(worker, 'analyze', { sliceIndex }).then((result) => {
      if (this.formatId !== 'macho') return result;
      return augmentAnalysisResultWithChainedImports(file, sliceIndex, result);
    });
  }"""
new="""  analyze(sliceIndex) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'analyze', { sliceIndex });
    const file=this.file;
    const legacy=this._callTo('legacy','analyze',{sliceIndex});
    const canonical=this._callTo('platform','machoAnalysis',{file,sliceIndex});
    return Promise.allSettled([legacy,canonical]).then(([l,c])=>{
      if(l.status==='rejected')throw l.reason;
      if(c.status==='rejected'){
        if(c.reason?.stale)throw c.reason;
        return {...l.value,linkage:unavailableMachOLinkage('canonical-macho-analysis-failed'),canonicalError:String(c.reason?.message||c.reason||'canonical analysis failed')};
      }
      return mergeMachoAnalysisTruth(l.value,c.value);
    });
  }"""
if old not in s:raise SystemExit('#521 Backend analyze anchor missing')
s=s.replace(old,new,1);p.write_text(s)

# SymbolIndex preserves normalized linkage/completeness rather than forcing it into legacy kinds only.
replace('js/symbols.js',"""    this.funcs = r.funcs || new BigUint64Array(0);
    /* Optional exact function ends.""","""    this.funcs = r.funcs || new BigUint64Array(0);
    this.linkage = r.linkage || null;
    this.linkageCompleteness = this.linkage?.completeness || { complete:false, importsComplete:false, exportsComplete:false, symbolSitesComplete:false, reasons:['linkage-unavailable'] };
    this.supplementalCompleteness = r.supplementalCompleteness || null;
    /* Optional exact function ends.""",'#521 SymbolIndex linkage')

# Linkage consumers prefer canonical records and union legacy stub/pointer evidence for call counts.
p=Path('js/linkage.js');s=p.read_text()
start=s.index('export function importList(');end=s.index('\n/** 借りている先を framework',start)
new_import=r'''export function importList(symbols, program, limit = 4000) {
  if (!symbols) return [];
  const cap=Math.max(1,Number(limit)||4000),seen=new Map();
  const add=(name,addr,{stub=false,library=null,source=null,siteKind=null}={})=>{
    if(!name)return;
    let e=seen.get(name);
    if(!e){const fw=frameworkOf(name);e={name,readable:readableName(name),addr:addr??null,stub,framework:library||fw?.label||null,library:library||null,cat:fw?.cat||null,calls:0,source,sites:0};seen.set(name,e);}
    if(library&&!e.library){e.library=library;e.framework=library;}
    if(addr!=null){e.sites++;if(program)e.calls+=program.callCountOf(BigInt(addr));if(stub||e.addr==null){e.addr=BigInt(addr);e.stub=e.stub||stub;}}
    if(siteKind)e.siteKind=siteKind;
  };
  for(const imp of symbols.linkage?.imports||[]){for(const site of imp.sites||[])add(imp.name,site.address,{library:imp.library,source:imp.source,siteKind:site.kind});if(!(imp.sites||[]).length)add(imp.name,null,{library:imp.library,source:imp.source});}
  if(symbols.symbolCount){
    for(const kind of [SYM_STUB,SYM_POINTER])for(const item of symbols.symbolList({kind,max:Math.max(cap,4000)}))add(item.name,item.addr,{stub:kind===SYM_STUB,source:'symbol-index'});
  }
  const out=Array.from(seen.values()).sort((a,b)=>b.calls-a.calls||a.name.localeCompare(b.name)).slice(0,cap);
  const truth=symbols.linkageCompleteness||symbols.linkage?.completeness||null;
  Object.defineProperties(out,{complete:{value:truth?.importsComplete===true&&seen.size<=cap,enumerable:false},completeness:{value:{complete:truth?.importsComplete===true&&seen.size<=cap,reasons:[...(truth?.reasons||[]),...(seen.size>cap?['result-limit']:[])]},enumerable:false},total:{value:seen.size,enumerable:false}});
  return out;
}
'''
s=s[:start]+new_import+s[end:]
start=s.index('export function exportList(');end=s.index('\n/* ── グローバル変数',start)
new_export=r'''export function exportList(symbols, limit = 4000) {
  if (!symbols) return [];
  const cap=Math.max(1,Number(limit)||4000),seen=new Map();
  for(const exp of symbols.linkage?.exports||[]){if(!exp?.name)continue;const key=exp.name+'@'+String(exp.address??'reexport');if(seen.has(key))continue;seen.set(key,{addr:exp.address==null||BigInt(exp.address)===0n?null:BigInt(exp.address),name:exp.name,readable:readableName(exp.name),kind:exp.kind||'export',source:exp.source||'canonical-macho',reexport:exp.kind==='reexport',imported:exp.imported||null});}
  if(symbols.symbolCount){for(let i=0;i<symbols.addrs.length;i++){if(symbols.kinds[i]!==0||!symbols.isExported(i))continue;const name=symbols.names[i];if(!name)continue;const key=name+'@'+symbols.addrs[i].toString();if(!seen.has(key))seen.set(key,{addr:symbols.addrs[i],name,readable:readableName(name),kind:'symbol',source:'symbol-index'});}}
  const out=Array.from(seen.values()).slice(0,cap);const truth=symbols.linkageCompleteness||symbols.linkage?.completeness||null;
  Object.defineProperties(out,{complete:{value:truth?.exportsComplete===true&&seen.size<=cap,enumerable:false},completeness:{value:{complete:truth?.exportsComplete===true&&seen.size<=cap,reasons:[...(truth?.reasons||[]),...(seen.size>cap?['result-limit']:[])]},enumerable:false},total:{value:seen.size,enumerable:false}});
  return out;
}
'''
s=s[:start]+new_export+s[end:];p.write_text(s)

# Classic worker supplemental budget: one bounded pool for ObjC recovery.
p=Path('js/worker-budget.js');s=p.read_text()
s=s.replace("    FUNCTION_AUX_SLOTS: 800_000,","    FUNCTION_AUX_SLOTS: 800_000,\n    SUPPLEMENTAL_READ_BYTES: 24 * MiB,\n    SUPPLEMENTAL_RESIDENT_BYTES: 12 * MiB,\n    SUPPLEMENTAL_REGIONS: 128,\n    SUPPLEMENTAL_NAMES: 100_000,\n    SUPPLEMENTAL_OPERATIONS: 2_000_000,\n    SUPPLEMENTAL_WALL_MS: 4_000,",1);p.write_text(s)

p=Path('js/worker-legacy.js');s=p.read_text()
s=s.replace('async function analyzeSlice({ sliceIndex }) {','async function analyzeSlice(msg) {\n  const { sliceIndex } = msg;\n  const supplementalBudget = createSupplementalBudget(msg);',1)
s=s.replace("""  try {
    for (const s of await objcStubNames(slice, entries)) {
      entries.push({ addr: s.addr, name: s.name, kind: 1 });
    }
  } catch { /* 読めなければ名前を足さないだけ */ }""","""  try {
    for (const s of await objcStubNames(slice, entries, supplementalBudget)) {
      entries.push({ addr: s.addr, name: s.name, kind: 1 });
    }
  } catch (error) { supplementalBudget.partial(error?.name==='AbortError'?'cancelled':'objc-stub-recovery-failed'); }""",1)
s=s.replace("""    functionDiscovery: { complete:functionStartsExact, capped:false,
      reasons:functionStartsExact ? [] : ['no-complete-lc-function-starts'] },
    capped,""","""    functionDiscovery: { complete:functionStartsExact, capped:false,
      reasons:functionStartsExact ? [] : ['no-complete-lc-function-starts'] },
    supplementalCompleteness: supplementalBudget.snapshot(),
    capped,""",1)
insert=s.index('\nconst MAX_OBJC_STUBS = 80_000;')
budget_code=r'''
function createSupplementalBudget(msg) {
  const started=Date.now(),reasons=[];let readBytes=0,residentBytes=0,regions=0,names=0,operations=0;
  const partial=(reason)=>{if(reason&&!reasons.includes(reason))reasons.push(reason);return false;};
  const alive=()=>{
    if(cancelled(msg?.id))return partial('cancelled');
    if(Date.now()-started>WORKER_BUDGET.SUPPLEMENTAL_WALL_MS)return partial('wall-clock-budget');
    return true;
  };
  return {
    partial,alive,
    take({read=0,resident=0,region=0,name=0,ops=0}={}){
      if(!alive())return false;
      if(readBytes+read>WORKER_BUDGET.SUPPLEMENTAL_READ_BYTES)return partial('read-byte-budget');
      if(residentBytes+resident>WORKER_BUDGET.SUPPLEMENTAL_RESIDENT_BYTES)return partial('resident-byte-budget');
      if(regions+region>WORKER_BUDGET.SUPPLEMENTAL_REGIONS)return partial('region-budget');
      if(names+name>WORKER_BUDGET.SUPPLEMENTAL_NAMES)return partial('name-budget');
      if(operations+ops>WORKER_BUDGET.SUPPLEMENTAL_OPERATIONS)return partial('operation-budget');
      readBytes+=Math.max(0,read);residentBytes+=Math.max(0,resident);regions+=Math.max(0,region);names+=Math.max(0,name);operations+=Math.max(0,ops);return true;
    },
    releaseResident(bytes){residentBytes=Math.max(0,residentBytes-Math.max(0,Number(bytes)||0));},
    snapshot(){return{complete:reasons.length===0,reasons:[...reasons],used:{readBytes,residentBytes,regions,names,operations},limits:{readBytes:WORKER_BUDGET.SUPPLEMENTAL_READ_BYTES,residentBytes:WORKER_BUDGET.SUPPLEMENTAL_RESIDENT_BYTES,regions:WORKER_BUDGET.SUPPLEMENTAL_REGIONS,names:WORKER_BUDGET.SUPPLEMENTAL_NAMES,operations:WORKER_BUDGET.SUPPLEMENTAL_OPERATIONS,wallClockMs:WORKER_BUDGET.SUPPLEMENTAL_WALL_MS}};},
  };
}
'''
s=s[:insert]+budget_code+s[insert:]
start=s.index('async function objcStubNames(');end=s.index('\nconst MAX_SELECTOR = 240;',start)
new_objc=r'''async function objcStubNames(slice, known, budget) {
  const regs=(slice&&slice.regions)||[];
  const validRegion=(r)=>{
    if(!r||r.size<=0n||r.fileOffset==null||r.vmAddr==null)return false;
    const off=BigInt(r.fileOffset),size=BigInt(r.size);return off>=0n&&size>0n&&off<=fileSize&&size<=fileSize-off;
  };
  const dedupe=(items)=>{const seen=new Set(),out=[];for(const r of items){if(!validRegion(r))continue;const key=`${r.fileOffset}:${r.size}:${r.vmAddr}:${r.section||''}`;if(seen.has(key))continue;if(!budget.take({region:1,ops:1}))break;seen.add(key);out.push(r);}return out;};
  const stubs=regs.find((r)=>r.section==='__objc_stubs'&&validRegion(r));
  if(!stubs)return [];
  const pointerRegions=dedupe(regs.filter((r)=>/^__objc_(selrefs|superrefs|classrefs)$/.test(r.section||'')));
  const textRegions=dedupe(regs.filter((r)=>r.cstrings||/^__objc_(methname|classname)$/.test(r.section||'')));
  if(!pointerRegions.length||!textRegions.length)return [];
  const owner=(list,addr,width=1n)=>{for(const r of list){const size=BigInt(r.size);if(addr>=r.vmAddr&&addr+width<=r.vmAddr+size)return r;}return null;};
  const readVm=async(r,addr,length)=>{
    const delta=addr-r.vmAddr,remain=BigInt(r.size)-delta,want=Math.min(Number(remain>BigInt(length)?BigInt(length):remain),length);
    if(want<=0||!budget.take({read:want,resident:want,ops:1}))return null;
    const bytes=await readRange(BigInt(r.fileOffset)+delta,want);budget.releaseResident(want);return bytes&&bytes.length===want?bytes:null;
  };
  const slotOf=async(addr)=>{const r=owner(pointerRegions,addr,8n);if(!r)return null;const b=await readVm(r,addr,8);if(!b)return null;let v=0n;for(let i=7;i>=0;i--)v=(v<<8n)|BigInt(b[i]);return v;};
  const textAt=async(addr)=>{const r=owner(textRegions,addr,1n);if(!r)return null;const max=Math.min(MAX_SELECTOR+1,Number(BigInt(r.size)-(addr-r.vmAddr)));const b=await readVm(r,addr,max);if(!b)return null;let out='';for(let i=0;i<b.length&&b[i]!==0&&out.length<MAX_SELECTOR;i++)out+=String.fromCharCode(b[i]);return out||null;};
  const gotName=new Map();
  for(const e of known||[]){if(e.kind!==2||!e.name)continue;if(!budget.take({name:1,ops:1}))break;gotName.set(e.addr.toString(),e.name);}
  const codeSize=Number(stubs.size);
  if(codeSize>OBJC_STUB_MAX_BYTES||!budget.take({read:codeSize,resident:codeSize,ops:1}))return [];
  const code=await readRange(stubs.fileOffset,codeSize);
  if(!code||!code.length){budget.releaseResident(codeSize);return [];}
  const words=Math.floor(code.length/4),dv=new DataView(code.buffer,code.byteOffset,words*4),out=[],pageOf=new Array(32).fill(null);
  const imageBase=slice.info&&slice.info.textVM!=null?slice.info.textVM:null;
  let start=null,selref=null,target=null;
  for(let i=0;i<words&&out.length<MAX_OBJC_STUBS;i++){
    if(!budget.take({ops:1}))break;
    const w=dv.getUint32(i*4,true),pc=stubs.vmAddr+BigInt(i*4),rel=Words.pcRelTarget(w,pc);
    if(rel){if(start===null)start=pc;pageOf[rel.reg]=rel.value;continue;}
    const pair=Words.pairedOffset(w);
    if(pair&&pair.load&&pageOf[pair.rn]!=null){const at=pageOf[pair.rn]+pair.imm;if(pair.rd===1)selref=at;else target=at;pageOf[pair.rd]=null;continue;}
    if(Words.classifyWord(w)===Words.KIND.BRANCH||Words.classifyWord(w)===Words.KIND.RET){
      if(start!==null&&selref!=null&&budget.alive()){
        const p=sanitizeStubPointer(await slotOf(selref),imageBase),sel=p==null?null:await textAt(p);
        if(sel&&budget.take({name:1,ops:2})){const via=target==null?null:gotName.get(target.toString()),send=via&&/msgSend/.test(via)?via.replace(/^_/,''):'objc_msgSend';out.push({addr:start,name:'_'+send+'$'+sel});}
      }
      start=null;selref=null;target=null;pageOf.fill(null);
    }
  }
  budget.releaseResident(codeSize);
  return out;
}
'''
s=s[:start]+new_objc+s[end:];p.write_text(s)

# Deprecated chained fast recovery is still safe when called directly: ByteSource chunking,
# active-slice range validation and a single hard recovery budget.
p=Path('js/chained.js');s=p.read_text()
if "./binary/source.js" not in s:s="import { BlobByteSource } from './binary/source.js';\n"+s
start=s.index('async function bytes(');end=s.index('\nfunction ascii',start)
reader=r'''const CHAINED_RECOVERY_LIMITS=Object.freeze({readBytes:24*1024*1024,residentBytes:8*1024*1024,imports:100_000,operations:1_000_000,wallClockMs:4000,chunkBytes:512*1024});
function createRecoveryReader(file,{signal=null}={}){
  const source=new BlobByteSource(file,{maxReadLength:CHAINED_RECOVERY_LIMITS.chunkBytes});const started=Date.now(),reasons=[];let readBytes=0,operations=0;
  const partial=(reason)=>{if(reason&&!reasons.includes(reason))reasons.push(reason);return false;};
  return {source,signal,partial,get complete(){return reasons.length===0;},snapshot(){return{complete:reasons.length===0,reasons:[...reasons],used:{readBytes,operations},limits:{...CHAINED_RECOVERY_LIMITS}};},
    async read(start,length){
      const off=BigInt(start),n=Number(length);if(signal?.aborted){partial('cancelled');const e=new Error('recovery aborted');e.name='AbortError';throw e;}
      if(!Number.isSafeInteger(n)||n<0||n>CHAINED_RECOVERY_LIMITS.residentBytes||readBytes+n>CHAINED_RECOVERY_LIMITS.readBytes||Date.now()-started>CHAINED_RECOVERY_LIMITS.wallClockMs){partial('read-budget');return null;}
      if(off<0n||off>source.size||BigInt(n)>source.size-off){partial('range');return null;}
      const out=new Uint8Array(n);let done=0;
      while(done<n){if(signal?.aborted){partial('cancelled');const e=new Error('recovery aborted');e.name='AbortError';throw e;}const take=Math.min(CHAINED_RECOVERY_LIMITS.chunkBytes,n-done);const b=await source.readExactly(off+BigInt(done),take,{signal});out.set(b,done);done+=take;readBytes+=take;operations++;if(operations>CHAINED_RECOVERY_LIMITS.operations){partial('operation-budget');return null;}}
      return out;
    }};
}
'''
s=s[:start]+reader+s[end:]
# Replace sliceOffset + parseImage with active-slice-aware variants.
start=s.index('async function sliceOffset(');end=s.index('\nfunction parseImportNames',start)
parse=r'''async function sliceRange(reader, sliceIndex) {
  const head=await reader.read(0n,8);if(!head||head.length<4)return null;const dv=new DataView(head.buffer,head.byteOffset,head.byteLength),le=dv.getUint32(0,true);
  if(le===MH_MAGIC_64)return{offset:0n,size:reader.source.size};
  const be=dv.getUint32(0,false);if(be!==FAT_MAGIC&&be!==FAT_MAGIC_64||head.length<8)return null;const n=u32be(dv,4),idx=Math.max(0,Number(sliceIndex)||0);if(idx>=n||n>64)return null;
  const wide=be===FAT_MAGIC_64,entry=wide?32:20,table=await reader.read(0n,8+n*entry);if(!table)return null;const tdv=new DataView(table.buffer,table.byteOffset,table.byteLength),p=8+idx*entry;
  const offset=wide?tdv.getBigUint64(p+8,false):BigInt(tdv.getUint32(p+8,false)),size=wide?tdv.getBigUint64(p+16,false):BigInt(tdv.getUint32(p+12,false));
  if(offset>reader.source.size||size<=0n||size>reader.source.size-offset){reader.partial('slice-range');return null;}return{offset,size};
}

async function parseImage(reader, sliceIndex) {
  const range=await sliceRange(reader,sliceIndex);if(!range)return null;const base=range.offset,sliceSize=range.size,h=await reader.read(base,32);if(!h||h.length<32)return null;
  let dv=new DataView(h.buffer,h.byteOffset,h.byteLength);if(dv.getUint32(0,true)!==MH_MAGIC_64)return null;const ncmds=dv.getUint32(16,true),sizeofcmds=dv.getUint32(20,true);
  if(!ncmds||ncmds>10000||sizeofcmds>4*1024*1024||32n+BigInt(sizeofcmds)>sliceSize){reader.partial('load-command-budget');return null;}
  const raw=await reader.read(base,32+sizeofcmds);if(!raw||raw.length<32)return null;dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const segments=[],stubs=[];let fixups=null,p=32;const end=Math.min(raw.length,32+sizeofcmds);
  for(let ci=0;ci<ncmds&&p+8<=end;ci++){
    const cmd=dv.getUint32(p,true),size=dv.getUint32(p+4,true);if(size<8||p+size>end)break;
    if(cmd===LC_SEGMENT_64&&size>=72){const name=ascii(raw,p+8,16),vmaddr=dv.getBigUint64(p+24,true),vmsize=dv.getBigUint64(p+32,true),fileoff=dv.getBigUint64(p+40,true),filesize=dv.getBigUint64(p+48,true),nsects=dv.getUint32(p+64,true),segIndex=segments.length;
      if(fileoff>sliceSize||filesize>sliceSize-fileoff){reader.partial('segment-range');p+=size;continue;}segments.push({name,vmaddr,vmsize,fileoff,filesize});let q=p+72;
      for(let si=0;si<nsects&&q+80<=p+size;si++,q+=80){const section=ascii(raw,q,16),addr=dv.getBigUint64(q+32,true),secSize=dv.getBigUint64(q+40,true),offset=BigInt(dv.getUint32(q+48,true)),flags=dv.getUint32(q+64,true),reserved2=dv.getUint32(q+72,true);if((flags&0xff)===S_SYMBOL_STUBS&&secSize>0n&&offset<=sliceSize&&secSize<=sliceSize-offset)stubs.push({section,addr,size:secSize,fileoff:offset,stubSize:reserved2||12,segIndex});}
    }else if(cmd===LC_DYLD_CHAINED_FIXUPS&&size>=16){const dataoff=BigInt(dv.getUint32(p+8,true)),datasize=dv.getUint32(p+12,true);if(dataoff<=sliceSize&&BigInt(datasize)<=sliceSize-dataoff&&datasize<=CHAINED_RECOVERY_LIMITS.residentBytes)fixups={dataoff,datasize};else reader.partial('fixup-range-or-size');}
    p+=size;
  }
  return{base,sliceSize,segments,stubs,fixups};
}
'''
s=s[:start]+parse+s[end:]
s=s.replace('if (version !== 0 || count > 1_000_000 || startsOffset >= raw.length ||','if (version !== 0 || count > CHAINED_RECOVERY_LIMITS.imports || startsOffset >= raw.length ||',1)
s=s.replace('function makeBlockReader(file) {','function makeBlockReader(reader) {',1).replace('b = await bytes(file, bi * BLOCK, BLOCK);','b = await reader.read(BigInt(bi * BLOCK), Math.min(BLOCK, Number(reader.source.size-BigInt(bi*BLOCK))));',1).replace('const exact = await bytes(file, n, 8);','const exact = await reader.read(BigInt(n), 8);',1)
old="""export async function chainedImportSymbols(file, sliceIndex = 0) {
  if (!file || typeof file.slice !== 'function') return [];
  const image = await parseImage(file, sliceIndex);
  if (!image || !image.fixups || !image.stubs.length) return [];
  const raw = await bytes(file, image.base + image.fixups.dataoff, image.fixups.datasize);
  const imports = parseImportNames(raw);
  if (!imports || !imports.names.length) return [];

  const read64 = makeBlockReader(file);"""
new="""export async function chainedImportSymbols(file, sliceIndex = 0, options = {}) {
  if (!file || typeof file.slice !== 'function') return [];
  const reader=createRecoveryReader(file,options),image=await parseImage(reader,sliceIndex);
  const empty=()=>{const out=[];Object.defineProperty(out,'completeness',{value:reader.snapshot(),enumerable:false});return out;};
  if (!image || !image.fixups || !image.stubs.length) return empty();
  const raw = await reader.read(image.base + image.fixups.dataoff, image.fixups.datasize);
  if(!raw)return empty();
  const imports = parseImportNames(raw);
  if (!imports || !imports.names.length) return empty();

  const read64 = makeBlockReader(reader);"""
if old not in s:raise SystemExit('#527 chained entry anchor missing')
s=s.replace(old,new,1)
s=s.replace('const code = await bytes(file, image.base + sec.fileoff, sec.size);','const code = await reader.read(image.base + sec.fileoff, Number(sec.size));\n    if(!code){reader.partial(\'stub-code-budget\');break;}',1)
s=s.replace('      out.push({ addr: stubAddr, name, kind: 1 });','      if(out.length>=CHAINED_RECOVERY_LIMITS.imports){reader.partial(\'output-budget\');break;}\n      out.push({ addr: stubAddr, name, kind: 1 });',1)
s=s.replace('  return out;\n}\n\n/** Merge recovered names',"  Object.defineProperty(out,'completeness',{value:reader.snapshot(),enumerable:false});\n  return out;\n}\n\n/** Merge recovered names",1)
s=s.replace('export async function augmentAnalysisResultWithChainedImports(file, sliceIndex, result) {','export async function augmentAnalysisResultWithChainedImports(file, sliceIndex, result, options = {}) {',1)
s=s.replace('  try { extra = await chainedImportSymbols(file, sliceIndex); }','  try { extra = await chainedImportSymbols(file, sliceIndex, options); }',1)
s=s.replace('  if (!extra.length) return result;','  if (!extra.length) return Object.assign({}, result, { supplementalCompleteness: extra.completeness || { complete:true,reasons:[] } });',1)
s=s.replace('  return Object.assign({}, result, { addrs, kinds, flags, names });','  return Object.assign({}, result, { addrs, kinds, flags, names, supplementalCompleteness: extra.completeness || { complete:true,reasons:[] } });',1)
p.write_text(s)

print('applied issues #521/#527')
