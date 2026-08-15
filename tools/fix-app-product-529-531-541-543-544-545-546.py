from pathlib import Path

# App lifecycle: canonical platform capability, Apple runtime models, executable-function containment,
# and bounded recognition state over the whole discovered function inventory.
p=Path('js/app.js'); s=p.read_text()
# imports
s=s.replace("import { buildObjcModel } from './objc.js';", "import { buildObjcModel, buildObjcRuntimeIndex } from './objc.js';\nimport { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from './swift.js';\nimport { classifyFunction, rankApplicationFunctions } from './recognition/classifier.js';\nimport { KnowledgeDB } from './knowledge/index.js';")
# constructor state
anchor="    this.objcBusyEpoch = -1;\n"
if 'this.swiftModel = null;' not in s:
    s=s.replace(anchor,anchor+"    this.objcRuntime = null;\n    this.swiftModel = null;\n    this.swiftRuntime = null;\n    this.swiftBusy = null;\n    this.swiftBusyEpoch = -1;\n    this.recognition = null;\n    this.recognitionBusy = null;\n    this.knowledge = new KnowledgeDB();\n",1)
# reset lifecycle
s=s.replace("      this.objcModel = null;\n      this.program = null;", "      this.objcModel = null;\n      this.objcRuntime = null;\n      this.swiftModel = null;\n      this.swiftRuntime = null;\n      this.swiftBusy = null;\n      this.swiftBusyEpoch = -1;\n      this.recognition = null;\n      this.recognitionBusy = null;\n      this.program = null;",1)

# replace ensureObjc with extended runtime integration while keeping legacy class/ivar parser.
a=s.index('  async ensureObjc(sliceIndex) {')
b=s.index('\n  /** その関数がどのクラスのメソッドか。',a)
objc=r'''  async ensureObjc(sliceIndex) {
    const epoch = this.backend.gen;
    if (this.objcModel && this.objcRuntime) return this.fields;
    if (this.objcBusy && this.objcBusyEpoch === epoch) return this.objcBusy;
    const regions = this.store.get('regions') || [];
    const list = regions.find((r) => r.section === '__objc_classlist' && r.size > 0n) || null;
    const protocolList = regions.find((r) => r.section === '__objc_protolist' && r.size > 0n) || null;
    const categoryList = regions.find((r) => r.section === '__objc_catlist' && r.size > 0n) || null;
    if (!list && !protocolList && !categoryList) { this.fields = EMPTY_FIELDS; this.objcModel=null; this.objcRuntime=null; return this.fields; }
    const slice = sliceIndex != null ? sliceIndex : this.store.get('sliceIndex');
    this.objcBusyEpoch = epoch;
    this.objcBusy = (async () => {
      const read = (addr, len) => this.backend.readAt(addr, len).then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
      try {
        const info = this.store.get('fileInfo');
        const sl = info && info.slices ? info.slices[slice] : null;
        const imageBase = sl && sl.info ? sl.info.textVM : null;
        const model = list ? await buildObjcModel(read, list, null, imageBase, { protocolList, categoryList, sections:{protocolList,categoryList} }) : {classes:[],names:[],protocols:[],categories:[],count:0};
        if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== slice) return this.fields;
        model.runtimeIndex = model.runtimeIndex || buildObjcRuntimeIndex(model);
        this.objcModel = model;
        this.objcRuntime = model.runtimeIndex;
        this.fields = new FieldIndex(model);
        if (model.names?.length) {
          const exec = this.executableRegions();
          const verifiedNames = model.names.filter((n) => n?.addr != null && exec.some((r)=>n.addr>=r.vmAddr && n.addr<r.vmAddr+r.size));
          const added = this.symbols.addNames(verifiedNames);
          this.symbols.addFunctions(verifiedNames.map((n) => n.addr));
          this.viewer.setSymbols(this.symbols); this.updateChrome();
          if (added) toast(pick(`Objective-C metadataから ${added} 個の関数名を復元しました`, `Recovered ${added} Objective-C function names`));
        }
      } catch { /* fail-soft on partial Apple metadata */ }
      finally { if (this.objcBusyEpoch === epoch) { this.objcBusy=null; this.objcBusyEpoch=-1; } }
      return epoch === this.backend.gen ? this.fields : EMPTY_FIELDS;
    })();
    return this.objcBusy;
  }

  async ensureSwift() {
    const epoch=this.backend.gen;
    if (this.swiftModel && this.swiftRuntime) return this.swiftModel;
    if (this.swiftBusy && this.swiftBusyEpoch===epoch) return this.swiftBusy;
    const regions=this.store.get('regions') || [];
    if (!regions.some((r)=>/^__swift5_/.test(r.section||''))) return null;
    const slice=this.store.get('sliceIndex');
    this.swiftBusyEpoch=epoch;
    this.swiftBusy=(async()=>{
      const read=(addr,len)=>this.backend.readAt(addr,len).then((r)=>(r&&r.found?r.bytes:null)).catch(()=>null);
      try {
        const model=await buildSwiftMetadataModel(read,regions,{budget:20000});
        if(epoch!==this.backend.gen || this.store.get('sliceIndex')!==slice) return null;
        this.swiftModel=model; this.swiftRuntime=buildSwiftRuntimeIndex(model);
        const exec=this.executableRegions(); const names=[];
        for(const type of model.types||[]) for(const method of type.methods||type.vtable||[]) {
          if(method?.impl!=null && exec.some((r)=>method.impl>=r.vmAddr&&method.impl<r.vmAddr+r.size)) names.push({addr:method.impl,name:`${type.name||'SwiftType'}::method_${method.index}`,source:'swift-metadata'});
        }
        if(names.length){this.symbols.addNames(names);this.symbols.addFunctions(names.map((x)=>x.addr));this.viewer.setSymbols(this.symbols);}
        return model;
      } catch { return null; }
      finally { if(this.swiftBusyEpoch===epoch){this.swiftBusy=null;this.swiftBusyEpoch=-1;} }
    })();
    return this.swiftBusy;
  }

  resolveSwiftCall(call) { return this.swiftRuntime ? resolveSwiftDispatch(this.swiftRuntime, call || {}) : {resolved:null,candidates:[],confidence:0,reason:'swift-runtime-unavailable'}; }

  executableRegions() { return (this.store.get('regions') || []).filter((r)=>r?.exec===true && r.size>0n); }
  executableRegionFor(addr) { const a=BigInt(addr); return this.executableRegions().find((r)=>a>=r.vmAddr && a<r.vmAddr+r.size) || null; }
  validatedFunctionRange(addr) {
    const fn=this.symbols?.functionAt?.(BigInt(addr)); if(!fn) return {ok:false,reason:'function-symbol-missing'};
    const region=this.executableRegionFor(fn.start); if(!region) return {ok:false,reason:'function-start-not-executable',function:fn};
    const regionEnd=region.vmAddr+region.size;
    let end=fn.end!=null?BigInt(fn.end):regionEnd;
    let complete=true,reason=null;
    if(end<=fn.start){return {ok:false,reason:'invalid-function-range',function:fn,region};}
    if(end>regionEnd){end=regionEnd;complete=false;reason='symbol-range-crosses-executable-region';}
    return {ok:true,start:fn.start,end,region,function:fn,complete,reason,provenance:'executable-region+symbol-boundary'};
  }

  async ensureRecognition(options={}) {
    if(this.recognition && this.recognition.gen===this.symbols.gen) return this.recognition;
    if(this.recognitionBusy) return this.recognitionBusy;
    const epoch=this.backend.gen, sym=this.symbols, max=Math.min(500000,Math.max(1000,Number(options.maxFunctions)||350000));
    this.recognitionBusy=(async()=>{
      const total=sym?.addrs?.length||0, count=Math.min(total,max), functions=[];
      for(let i=0;i<count;i++){
        if(epoch!==this.backend.gen) return null;
        const address=sym.addrs[i], name=sym.names?.[i]||null;
        const objc=name&&/^[+-]\[([^ ]+)/.exec(name);
        functions.push({address,name,size:0,objc:objc?{class:objc[1]}:{},strings:[],calls:[],imports:[],semantic:{writes:[],thresholds:[]},fieldAccessShape:[]});
        if((i&8191)===8191) await Promise.resolve();
      }
      const ranked=rankApplicationFunctions(functions,()=>({notKnownVendor:true}));
      // Preserve obfuscated/unknown functions after application candidates instead of hiding them.
      const records=ranked.map((x)=>({address:x.function.address,name:x.function.name||null,score:x.score,classification:x.classification.classification,confidence:x.classification.confidence,evidence:x.classification.evidence}));
      const state={gen:sym.gen,records,total,scannedCount:count,complete:count===total,truncationReason:count===total?null:'function-budget',binaryHash:this.backend.contentHash||null,knowledge:this.knowledge};
      if(epoch===this.backend.gen)this.recognition=state; return state;
    })().finally(()=>{this.recognitionBusy=null;});
    return this.recognitionBusy;
  }
'''
s=s[:a]+objc+s[b:]

# Capability application replaces arm64-only truth.
old="""    const arch = slice && slice.info
      ? slice.info.cpu + (slice.info.cpuSub && slice.info.cpuSub !== 'all' ? ' (' + slice.info.cpuSub + ')' : '')
      : null;
    const canDisassemble = slice && slice.info ? !!slice.info.isArm64 : true;

    this.store.set({ sliceIndex, regions, architecture: arch, canDisassemble });"""
new="""    const capability = slice?.capability || info?.capability || { architecture:slice?.info?.architecture || (slice?.info?.isArm64?'arm64':'unknown'), canDisassemble:!!slice?.info?.isArm64, analysisLevel:!!slice?.info?.isArm64?'full':'data-only', limitations:[], instructionAlignment:slice?.info?.isArm64?4:1 };
    const arch = capability.architecture || slice?.info?.architecture || slice?.info?.cpu || null;
    const canDisassemble = capability.canDisassemble === true || capability.viewerCanDisassemble === true;
    this.store.set({ sliceIndex, regions, architecture: arch, canDisassemble, capability, analysisLevel:capability.analysisLevel||'data-only', limitations:capability.limitations||[], instructionAlignment:Math.max(1,Number(capability.instructionAlignment||capability.fixedInstructionSize||1)) });"""
if old not in s: raise SystemExit('applySlice capability anchor changed')
s=s.replace(old,new,1)
# generic status label instead of ARM64 hardcode
s=s.replace("(this.store.get('canDisassemble') ? 'ARM64' : (arch || t('status.data'))) + ' · '", "(this.store.get('canDisassemble') ? (arch || 'code') : (arch || t('status.data'))) + ' · '")
# analyze function strict executable containment/alignment
a=s.index('  async analyzeFunctionAt(addr) {')
b=s.index('\n  /* ── ファイルを開く',a)
new_an=r'''  async analyzeFunctionAt(addr) {
    const sym=this.symbols, range=this.validatedFunctionRange(addr);
    if(!range.ok || !this.store.get('canDisassemble') || !sym.functionCount) return null;
    const region=range.region, alignment=Math.max(1,Number(this.store.get('instructionAlignment')||this.store.get('capability')?.instructionAlignment||4));
    const width=BigInt(alignment);
    if((range.start-region.vmAddr)%width!==0n) return null;
    const startRow=Number((range.start-region.vmAddr)/width);
    const endRow=Math.min(Number((range.end-region.vmAddr+width-1n)/width)-1, Math.max(0,Number(region.size/width)-1));
    if(endRow<startRow)return null;
    try {
      const res=await analyzeFunctionCached(this.backend,region,startRow,endRow,sym);
      if(this.store.get('sliceIndex')<0 || this.executableRegionFor(range.start)!==region)return null;
      res.completeness={complete:range.complete!==false,reason:range.reason||null,provenance:range.provenance,regionId:region.id};
      this.semantic={regionId:region.id,model:res.model,result:res};
      if(this.store.get('currentRegion')===region)this.viewer.setBlockOverlay(region.id,buildOverlay(res.model));
      return res;
    } catch { return null; }
  }
'''
s=s[:a]+new_an+s[b:]
p.write_text(s)

# objc facade: merge extended protocols/categories into the application model correctly.
p=Path('js/objc.js'); s=p.read_text()
if "parseObjcExtendedMetadata" not in s:
    s=s.replace("export * from './objc-legacy.js';", "export * from './objc-legacy.js';\nimport { parseObjcExtendedMetadata } from './apple/objc-metadata.js';\nimport { buildObjcRuntimeIndex } from './apple/objc-runtime.js';")
# if current buildObjcModel is just re-exported legacy, wrap it. Current facade may already contain wrappers; only inject compatible helper by renaming import.
if 'export async function buildObjcRuntimeModel' not in s:
    s += r'''

export async function buildObjcRuntimeModel(read, classList, onProgress=null, imageBase=null, options={}) {
  const base = await buildObjcModel(read,classList,onProgress,imageBase);
  let extended={protocols:[],categories:[]};
  try { extended=await parseObjcExtendedMetadata(read,{protocolList:options.protocolList||options.sections?.protocolList,categoryList:options.categoryList||options.sections?.categoryList},{imageBase,classes:base.classes||[]}); } catch { /* partial metadata */ }
  base.protocols=extended.protocols||[]; base.categories=extended.categories||[]; base.runtimeIndex=buildObjcRuntimeIndex(base); return base;
}
'''
p.write_text(s)

# AI: capability-aware instruction alignment + whole symbol inventory search with completeness metadata.
p=Path('js/ai/ui/hex-context.js'); s=p.read_text()
old="""function fixedRows(app) {
  const arch = String(app.store.get('architecture') || 'arm64').toLowerCase();
  return /arm64|aarch64/.test(arch) || !!app.store.get('canDisassemble');
}"""
new="""function fixedRows(app) { return !!app.store.get('canDisassemble') && Number(app.store.get('instructionAlignment') || app.store.get('capability')?.instructionAlignment || 0) > 0; }
function instructionBytes(app) { return Math.max(1, Number(app.store.get('instructionAlignment') || app.store.get('capability')?.instructionAlignment || 4)); }"""
if old not in s: raise SystemExit('fixedRows anchor changed')
s=s.replace(old,new,1)
s=s.replace("const startRow = Number((start - region.vmAddr) / 4n);", "const step=BigInt(instructionBytes(app));\n  const startRow = Number((start - region.vmAddr) / step);")
s=s.replace("const totalRows = Number(region.size / 4n);", "const totalRows = Number(region.size / step);")
# replace searchFunctions implementation by locating method
start=s.index('    async searchFunctions(')
end=s.index('\n    async searchStrings(',start)
new_search=r'''    async searchFunctions(query, { limit = 50 } = {}) {
      const q=String(query||'').toLowerCase(), sym=app.symbols;
      if(!q||!sym)return {items:[],complete:true,scannedCount:0,total:0,truncationReason:null};
      const maxScan=1_000_000,total=sym.names?.length||0,scan=Math.min(total,maxScan),items=[];
      for(let i=0;i<scan;i++){
        const name=sym.names[i]; if(!name||!String(name).toLowerCase().includes(q))continue;
        items.push({address:sym.addrs[i],name,index:i}); if(items.length>=Math.min(500,Math.max(1,limit))) break;
      }
      // A full-set match scan is intentionally independent of the returned item cap.
      let complete=scan===total, truncationReason=complete?null:'scan-budget';
      if(items.length>=limit && scan===total) truncationReason='result-limit';
      return {items:items.slice(0,limit),complete:complete&&items.length<limit,scannedCount:scan,total,truncationReason,coverage:total?scan/total:1};
    },
'''
s=s[:start]+new_search+s[end:]
p.write_text(s)

# Product: ranked function view, bounded inventories with explicit completeness, and function-range evidence.
p=Path('js/ui/product.js'); s=p.read_text()
# bounded helper near top
anchor="const PAGE_SIZE = 100;\n" if "const PAGE_SIZE = 100;" in s else None
helper="""
const EXPLORER_SOURCE_LIMIT = 50000;
function boundedItems(items, limit = EXPLORER_SOURCE_LIMIT, meta = {}) {
  const source=Array.isArray(items)?items:[], out=source.slice(0,limit);
  out.complete = meta.complete !== false && source.length <= limit;
  out.total = meta.total ?? source.length;
  out.scannedCount = meta.scannedCount ?? Math.min(source.length,limit);
  out.truncationReason = out.complete ? null : (meta.truncationReason || (source.length>limit?'explorer-source-budget':'upstream-incomplete'));
  out.provenance = meta.provenance || 'canonical-app-state';
  return out;
}
"""
if 'function boundedItems' not in s:
    pos=s.index('\n',s.index('const '))+1 if 'const ' in s else 0
    s=s[:pos]+helper+s[pos:]
# functionSource
start=s.index('function functionSource(app) {')
end=s.index('\nasync function stringSource',start)
new_fn=r'''async function functionSource(app) {
  const recognition=await app.ensureRecognition?.({maxFunctions:350000});
  if(recognition?.records?.length) return boundedItems(recognition.records.map((r)=>({kind:'function',addr:r.address,address:r.address,name:r.name||`sub_${r.address.toString(16)}`,classification:r.classification,recognitionScore:r.score,recognitionConfidence:r.confidence})),EXPLORER_SOURCE_LIMIT,{complete:recognition.complete,total:recognition.total,scannedCount:recognition.scannedCount,truncationReason:recognition.truncationReason,provenance:'recognition/classifier+knowledge'});
  const sym=app.symbols, total=sym?.addrs?.length||0, n=Math.min(total,EXPLORER_SOURCE_LIMIT),out=[];
  for(let i=0;i<n;i++)out.push({kind:'function',addr:sym.addrs[i],address:sym.addrs[i],name:sym.names?.[i]||`sub_${sym.addrs[i].toString(16)}`,classification:'UNKNOWN'});
  return boundedItems(out,EXPLORER_SOURCE_LIMIT,{complete:n===total,total,scannedCount:n,provenance:'symbol-index'});
}
'''
s=s[:start]+new_fn+s[end:]
# cap string/data source by slicing before mapping; preserve upstream completeness
s=s.replace("return (app.stringIndex || []).map((item) =>", "const source=app.stringIndex || [];\n  return boundedItems(source.slice(0,EXPLORER_SOURCE_LIMIT).map((item) =>")
# this replacement needs close parens; find first stringSource return block likely ends `));` change first after source.
idx=s.index("const source=app.stringIndex || [];")
close=s.find(" ));",idx)
if close!=-1: s=s[:close+3]+",EXPLORER_SOURCE_LIMIT,{complete:source.complete!==false,total:source.length,scannedCount:Math.min(source.length,EXPLORER_SOURCE_LIMIT),truncationReason:source.complete===false?'upstream-incomplete':null,provenance:'decoded-string-index'});"+s[close+3:]
# data source safer with simple replacement if anchor exists
old="return (app.store.get('dataItems') || []).map((item) =>"
if old in s:
    s=s.replace(old,"const source=app.store.get('dataItems') || [];\n  return boundedItems(source.slice(0,EXPLORER_SOURCE_LIMIT).map((item) =>",1)
    idx=s.index("const source=app.store.get('dataItems') || [];")
    close=s.find(" ));",idx)
    if close!=-1: s=s[:close+3]+",EXPLORER_SOURCE_LIMIT,{complete:source.complete!==false,total:source.length,scannedCount:Math.min(source.length,EXPLORER_SOURCE_LIMIT),truncationReason:source.complete===false?'upstream-incomplete':null,provenance:'data-items'});"+s[close+3:]
# render function must validate executable containment before analysis
needle="const fn = app.symbols?.functionAt?.(addr) || null;"
if needle in s: s=s.replace(needle,"const fn = app.symbols?.functionAt?.(addr) || null;\n  const verifiedRange = app.validatedFunctionRange?.(addr) || {ok:!!fn,complete:true,reason:null};",1)
# before analyzeFunctionAt call, guard
s=s.replace("const analysis = await app.analyzeFunctionAt(address);", "const range=app.validatedFunctionRange?.(address);\n  if(range && !range.ok) return {analysis:null,range};\n  const analysis = await app.analyzeFunctionAt(address);",1)
p.write_text(s)
