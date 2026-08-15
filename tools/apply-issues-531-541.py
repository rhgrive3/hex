from pathlib import Path


def replace(path, old, new, label, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,count))

# App lifecycle: Swift/recognition state is slice-scoped and must be invalidated.
replace('js/app.js', """      this.objcModel = null;
      this.objcRuntime = null;
      this.program = null;""", """      this.objcModel = null;
      this.objcRuntime = null;
      this.swiftModel = null;
      this.swiftRuntime = null;
      this.swiftBusy = null;
      this.swiftBusyEpoch = -1;
      this.recognition = null;
      this.recognitionBusy = null;
      this.program = null;""", '#531 slice scoped caches')

# Building symbols is the point where all metadata intelligence may safely attach.
replace('js/app.js', """        this.viewer.setSymbols(this.symbols);
        this.updateChrome();
        return this.ensureObjc(sliceIndex);""", """        this.viewer.setSymbols(this.symbols);
        this.updateChrome();
        return Promise.allSettled([
          this.ensureObjc(sliceIndex),
          this.ensureSwift(),
          this.ensureRecognition({ maxFunctions: 350000 }),
        ]);""", '#531/#541 open pipeline')

# Recognition: keep the whole function-set pass bounded, enrich with Swift metadata,
# then apply a second independent bounded KnowledgeDB reidentification budget.
p=Path('js/app.js'); s=p.read_text()
start=s.index('  async ensureRecognition(options={}) {')
end=s.index('\n  /** その関数がどのクラスのメソッドか。', start)
new="""  async ensureRecognition(options={}) {
    const sym=this.symbols;
    if(!sym || sym===EMPTY_INDEX) return null;
    if(this.recognition && this.recognition.gen===sym.gen) return this.recognition;
    if(this.recognitionBusy) return this.recognitionBusy;
    const epoch=this.backend.gen;
    const max=Math.min(500000,Math.max(1000,Number(options.maxFunctions)||350000));
    const knowledgeLimit=Math.min(2048,Math.max(0,Number(options.knowledgeLimit ?? 512)));
    this.recognitionBusy=(async()=>{
      try { await this.ensureSwift(); } catch { /* Swift metadata is optional */ }
      if(epoch!==this.backend.gen || sym!==this.symbols) return null;
      const total=sym?.addrs?.length||0, count=Math.min(total,max), functions=new Array(count);
      for(let i=0;i<count;i++){
        if(epoch!==this.backend.gen || sym!==this.symbols) return null;
        const address=sym.addrs[i], name=sym.names?.[i]||null;
        const next=i+1<total?sym.addrs[i+1]:null;
        const owner=this.fields?.ownerOf?.(address)||null;
        const swiftName=name&&/^(.*)::method_(\\d+)$/.exec(name);
        functions[i]={
          address,name,size:next!=null&&next>address?Number(next-address):0,
          objc:owner?.className?{class:owner.className}:{},
          swift:swiftName?{typeDescriptor:swiftName[1]}:{},
          strings:[],calls:[],imports:[],semantic:{writes:[],thresholds:[]},fieldAccessShape:[],
        };
        if((i&8191)===8191) await Promise.resolve();
      }
      const ranked=rankApplicationFunctions(functions,()=>({notKnownVendor:true}));
      const knowledgeCount=Math.min(knowledgeLimit,ranked.length);
      let knowledgeMatches=0, knowledgeAmbiguous=0;
      for(let i=0;i<knowledgeCount;i++){
        if(epoch!==this.backend.gen || sym!==this.symbols) return null;
        try {
          const propagated=await this.knowledge.propagate(ranked[i].function,{threshold:0.84,ambiguityWindow:0.035});
          if(propagated?.propagated){ranked[i].knowledge=propagated;knowledgeMatches++;}
          else if(propagated?.ambiguous || propagated?.truncated) knowledgeAmbiguous++;
        } catch { /* local knowledge must never block binary analysis */ }
        if((i&63)===63) await Promise.resolve();
      }
      const records=ranked.map((x)=>{
        const known=x.knowledge?.candidate||null;
        return {
          address:x.function.address,
          name:known?.names?.[0]||x.function.name||null,
          originalName:x.function.name||null,
          score:x.score,classification:x.classification.classification,
          confidence:x.classification.confidence,evidence:x.classification.evidence,
          fingerprint:x.function,knowledge:known,knowledgeConfidence:x.knowledge?.confidence||0,
          knowledgeSourceId:x.knowledge?.sourceId||null,
        };
      });
      const state={
        gen:sym.gen,records,total,scannedCount:count,complete:count===total,
        truncationReason:count===total?null:'function-budget',binaryHash:this.backend.contentHash||null,
        knowledge:this.knowledge,knowledgeScanned:knowledgeCount,knowledgeMatches,knowledgeAmbiguous,
        knowledgeComplete:knowledgeCount===ranked.length,
      };
      if(epoch===this.backend.gen && sym===this.symbols)this.recognition=state;
      return state;
    })().finally(()=>{this.recognitionBusy=null;});
    return this.recognitionBusy;
  }
"""
s=s[:start]+new+s[end:]
p.write_text(s)

# Auto Analysis uses the global recognition ranking as another candidate source.
replace('js/auto.js', """  progress({ phase: 'notable', done: 0, all: 1 });
  report.notable = notableFunctions(program, symbols, region);
  if (report.notable.sampled) report.notes.push('notable-functions-sampled');""", """  progress({ phase: 'notable', done: 0, all: 1 });
  const recognized = Array.isArray(o.recognition?.records) ? o.recognition.records : [];
  const recognizedNotable = recognized
    .filter((item) => item && (item.classification === 'APPLICATION' || item.classification === 'UNKNOWN'))
    .slice(0, 24)
    .map((item) => ({ addr:item.address, name:item.name||null, score:Math.round((item.score||0)*100), reasons:[{code:'recognition',points:Math.round((item.score||0)*100),detail:{classification:item.classification,confidence:item.confidence,knowledge:!!item.knowledge}}], recognition:item }));
  const structuralNotable = notableFunctions(program, symbols, region);
  const seen = new Set();
  report.notable = [...recognizedNotable, ...structuralNotable].filter((item) => {
    const key=item?.addr==null?'':item.addr.toString(); if(!key||seen.has(key))return false; seen.add(key); return true;
  }).slice(0, 24);
  Object.defineProperties(report.notable, {
    complete:{value:o.recognition ? o.recognition.complete===true && structuralNotable.complete!==false : structuralNotable.complete!==false,enumerable:false},
    sampled:{value:o.recognition?.complete===false || structuralNotable.sampled===true,enumerable:false},
  });
  report.stats.recognition = o.recognition ? { scanned:o.recognition.scannedCount||0,total:o.recognition.total||0,complete:o.recognition.complete===true,knowledgeMatches:o.recognition.knowledgeMatches||0 } : null;
  if (report.notable.sampled) report.notes.push('notable-functions-sampled');""", '#541 auto recognition')

# Overview prepares Recognition before Auto Analysis, without making a failed optional
# classifier abort the rest of the report.
replace('js/panels.js', """      const report = await autoAnalyze({
        strings, program, symbols: app.symbols, region, fields: app.fields,
        shapes,""", """      let recognition=null;
      try { recognition=await app.ensureRecognition?.({maxFunctions:350000,knowledgeLimit:512}); } catch { recognition=null; }
      const report = await autoAnalyze({
        strings, program, symbols: app.symbols, region, fields: app.fields,
        shapes, recognition,""", '#541 auto caller')

# AI context: ranked function search/candidates + KnowledgeDB + Swift runtime dispatch.
replace('js/ai/ui/hex-context.js', """    get symbols() { return app.symbols; },
    get program() { return app.program; },""", """    get symbols() { return app.symbols; },
    get program() { return app.program; },
    get knowledge() { return app.knowledge || null; },
    get functions() { return (app.recognition?.records || []).map((item)=>item.fingerprint).filter(Boolean).slice(0,5000); },""", '#541 AI knowledge')
replace('js/ai/ui/hex-context.js', """    searchFunctions(query, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 40));
      const sym = app.symbols;
      if (!sym || !Array.isArray(sym.names)) return [];
      const q = String(query || '').toLowerCase();
      const maxScan=Math.min(sym.names.length,1_000_000), out=[];
      let matches=0;
      for (let i = 0; i < maxScan; i++) {
        const name = String(sym.names[i] || '');
        if (q && !name.toLowerCase().includes(q)) continue;
        matches++;
        if(out.length<limit) out.push({ addr: sym.addrs[i], name });
      }
      out.complete=maxScan===sym.names.length && matches<=limit;
      out.scannedCount=maxScan; out.total=sym.names.length; out.matchCount=matches;
      out.truncationReason=maxScan<sym.names.length?'scan-budget':matches>limit?'result-limit':null;
      out.coverage=sym.names.length?maxScan/sym.names.length:1;
      return out;
    },""", """    async searchFunctions(query, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 40));
      const q = String(query || '').toLowerCase();
      try { await app.ensureRecognition?.({maxFunctions:350000,knowledgeLimit:512}); } catch { /* fallback below */ }
      const ranked=app.recognition?.records || [];
      if(ranked.length){
        const out=[]; let matches=0;
        for(const item of ranked){
          const name=String(item.name||item.originalName||'');
          const cls=String(item.classification||'');
          const knowledge=(item.knowledge?.names||[]).concat(item.knowledge?.roles||[]).join(' ');
          if(q && !(`${name} ${cls} ${knowledge}`.toLowerCase().includes(q)))continue;
          matches++; if(out.length<limit)out.push({addr:item.address,name:name||null,score:item.score||0,classification:item.classification,confidence:item.confidence,knowledge:item.knowledge||null});
        }
        out.complete=app.recognition.complete===true && matches<=limit;
        out.scannedCount=app.recognition.scannedCount;out.total=app.recognition.total;out.matchCount=matches;
        out.truncationReason=app.recognition.complete!==true?(app.recognition.truncationReason||'recognition-incomplete'):matches>limit?'result-limit':null;
        out.coverage=app.recognition.total?app.recognition.scannedCount/app.recognition.total:1;
        return out;
      }
      const sym = app.symbols;
      if (!sym || !Array.isArray(sym.names)) return [];
      const maxScan=Math.min(sym.names.length,1_000_000), out=[]; let matches=0;
      for (let i = 0; i < maxScan; i++) {
        const name = String(sym.names[i] || '');
        if (q && !name.toLowerCase().includes(q)) continue;
        matches++; if(out.length<limit) out.push({ addr: sym.addrs[i], name });
      }
      out.complete=maxScan===sym.names.length && matches<=limit; out.scannedCount=maxScan;out.total=sym.names.length;out.matchCount=matches;
      out.truncationReason=maxScan<sym.names.length?'scan-budget':matches>limit?'result-limit':null;out.coverage=sym.names.length?maxScan/sym.names.length:1;
      return out;
    },""", '#541 AI ranked search')
replace('js/ai/ui/hex-context.js', """    async resolveObjcDispatch(receiverClass, selector, kind = 'instance') {
      try { await app.ensureObjc?.(); } catch { /* ObjC metadata is optional */ }
      const index = app.objcRuntime || app.objcModel?.runtimeIndex || null;
      if (!index) return { resolved: null, reason: 'objc-runtime-unavailable', candidates: [], requirements: [], confidence: 0 };
      const result = resolveObjcDispatch(index, {
        receiverType: String(receiverClass || ''), selector: String(selector || ''), classMethod: kind === 'class',
      });
      return { ...result, candidates: (result.candidates || []).slice(0, 32), requirements: (result.requirements || []).slice(0, 32) };
    },""", """    async resolveObjcDispatch(receiverClass, selector, kind = 'instance') {
      try { await app.ensureObjc?.(); } catch { /* ObjC metadata is optional */ }
      const index = app.objcRuntime || app.objcModel?.runtimeIndex || null;
      if (!index) return { resolved: null, reason: 'objc-runtime-unavailable', candidates: [], requirements: [], confidence: 0 };
      const result = resolveObjcDispatch(index, {
        receiverType: String(receiverClass || ''), selector: String(selector || ''), classMethod: kind === 'class',
      });
      return { ...result, candidates: (result.candidates || []).slice(0, 32), requirements: (result.requirements || []).slice(0, 32) };
    },

    async resolveSwiftDispatch(call = {}) {
      try { await app.ensureSwift?.(); } catch { /* Swift metadata is optional */ }
      const result=app.resolveSwiftCall?.(call) || {resolved:null,candidates:[],confidence:0,reason:'swift-runtime-unavailable'};
      return { ...result, candidates:(result?.candidates||[]).slice(0,32), requirements:(result?.requirements||[]).slice(0,32), complete:result?.complete!==false && app.swiftModel?.complete!==false };
    },""", '#531 AI Swift dispatch')
replace('js/ai/ui/hex-context.js', """    objcModel: app.objcModel || null,
    objcRuntimeIndex: app.objcRuntime || null,
    notes: app.notes,""", """    objcModel: app.objcModel || null,
    objcRuntimeIndex: app.objcRuntime || null,
    swiftModel: app.swiftModel || null,
    swiftRuntimeIndex: app.swiftRuntime || null,
    resolveSwiftDispatch: (call) => app.resolveSwiftCall?.(call) || null,
    notes: app.notes,""", '#531 decompiler context')

# Deterministic Swift dispatch tool mirrors the Objective-C tool and keeps partial
# metadata/ambiguity explicit.
replace('js/ai/tools/registry.js', """  register('resolve_objc_dispatch', 'Resolve an Objective-C receiver/selector through parsed class/category/protocol metadata. Ambiguous or partial metadata remains unresolved.', {
    type: 'object', additionalProperties: false,
    properties: { receiverClass: { type: 'string', minLength: 1, maxLength: 256 }, selector: { type: 'string', minLength: 1, maxLength: 512 }, kind: { type: 'string', enum: ['instance', 'class'] } },
    required: ['receiverClass', 'selector'],
  }, async ({ receiverClass, selector, kind = 'instance' }) => {
    if (typeof context.resolveObjcDispatch !== 'function') return { resolved: null, reason: 'objc-runtime-unavailable', candidates: [], requirements: [], confidence: 0 };
    const result = await context.resolveObjcDispatch(receiverClass, selector, kind);
    return { ...result, candidates: (result?.candidates || []).slice(0, 32), requirements: (result?.requirements || []).slice(0, 32) };
  }, { cost: 'cheap', scopeSupport: broadScopes });""", """  register('resolve_objc_dispatch', 'Resolve an Objective-C receiver/selector through parsed class/category/protocol metadata. Ambiguous or partial metadata remains unresolved.', {
    type: 'object', additionalProperties: false,
    properties: { receiverClass: { type: 'string', minLength: 1, maxLength: 256 }, selector: { type: 'string', minLength: 1, maxLength: 512 }, kind: { type: 'string', enum: ['instance', 'class'] } },
    required: ['receiverClass', 'selector'],
  }, async ({ receiverClass, selector, kind = 'instance' }) => {
    if (typeof context.resolveObjcDispatch !== 'function') return { resolved: null, reason: 'objc-runtime-unavailable', candidates: [], requirements: [], confidence: 0 };
    const result = await context.resolveObjcDispatch(receiverClass, selector, kind);
    return { ...result, candidates: (result?.candidates || []).slice(0, 32), requirements: (result?.requirements || []).slice(0, 32) };
  }, { cost: 'cheap', scopeSupport: broadScopes });
  if (typeof context.resolveSwiftDispatch === 'function') register('resolve_swift_dispatch', 'Resolve a Swift vtable/witness/metadata dispatch through the active Swift runtime index. Ambiguity and partial metadata remain explicit.', {
    type:'object', additionalProperties:true,
    properties:{ kind:{type:'string',maxLength:64}, type:{type:'string',maxLength:512}, protocol:{type:'string',maxLength:512}, requirement:{}, slot:{type:'integer',minimum:0,maximum:1000000}, target:addressProperty() },
  }, async (args) => {
    const result=await context.resolveSwiftDispatch(args||{});
    return { ...result, candidates:(result?.candidates||[]).slice(0,32), requirements:(result?.requirements||[]).slice(0,32) };
  }, {cost:'cheap',scopeSupport:broadScopes});""", '#531 Swift tool')

print('applied #531/#541 product intelligence integration')
