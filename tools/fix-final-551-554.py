from pathlib import Path

# #552: normalized, format-neutral Product descriptor.
p=Path('js/platform/describe.js'); s=p.read_text()
old="""  const info = {
    cpu: image.arch || 'unknown',"""
new="""  const dependencies=[...new Set((image.libraries || []).map(String).filter(Boolean))];
  const importItems=(image.imports || []).slice(0,50000).map((item)=>({name:item?.name||null,library:item?.library||null,kind:item?.kind||'import'}));
  const exportItems=(image.exports || []).slice(0,50000).map((item)=>({name:item?.name||null,address:item?.address??null,kind:item?.kind||'export',forwarder:item?.forwarder||null}));
  const formatDescriptor={
    format:image.format || 'raw', architecture:image.arch || 'unknown', bits:image.bits || null, endian:image.endian || null,
    imageBase:image.imageBase ?? 0n, entryPoint:image.entryPoint ?? null, regions,
    dependencies,
    imports:{items:importItems,total:(image.imports||[]).length,complete:importItems.length===(image.imports||[]).length},
    exports:{items:exportItems,total:(image.exports||[]).length,complete:exportItems.length===(image.exports||[]).length},
    formatMetadata:{...image.metadata, sourceReads:image.metadata?.sourceReads||null},
  };
  const info = {
    cpu: image.arch || 'unknown',"""
if old not in s: raise SystemExit('describe info anchor changed')
s=s.replace(old,new,1)
s=s.replace("    capability,\n  };", "    capability,\n    dependencies, imports:formatDescriptor.imports, exports:formatDescriptor.exports, formatMetadata:formatDescriptor.formatMetadata, formatDescriptor,\n  };",1)
s=s.replace("slices: [{ name: image.arch || 'unknown', offset: image.fileOffset || 0n, size: image.fileSize, info, capability, regions }],", "slices: [{ name: image.arch || 'unknown', offset: image.fileOffset || 0n, size: image.fileSize, info, capability, regions, descriptor:formatDescriptor }],",1)
s=s.replace("    capability,\n    platform: {", "    capability,\n    descriptor:formatDescriptor,\n    platform: {",1)
p.write_text(s)

# #551/#553: slice generation event and globally bounded string materialization.
p=Path('js/app.js'); s=p.read_text()
# Replace ensureStrings wholesale with a bounded implementation.
a=s.index('  async ensureStrings(')
# next method declaration
b=s.find('\n  async ',a+20)
if b<0: raise SystemExit('next app async method missing')
new_strings=r'''  async ensureStrings(onProgress) {
    if (this.stringIndex) return this.stringIndex;
    const epoch=this.backend.gen;
    if(this.stringsBusy&&this.stringsBusyEpoch===epoch)return this.stringsBusy;
    this.stringsBusyEpoch=epoch;
    this.stringsBusy=(async()=>{
      const regions=this.store.get('regions')||[];
      const priority=(r)=>r.cstrings?0:/cstring|objc_methname|objc_classname|swift5_reflstr/i.test(r.section||'')?1:/string|const|ustring/i.test(r.section||'')?2:3;
      const targets=regions.filter((r)=>r.size>0n&&(r.cstrings||/string|cstring|objc_methname|objc_method|objc_classname|objc_class|oslogstring|const|ustring|swift5_reflstr/i.test(r.section||''))).sort((x,y)=>priority(x)-priority(y));
      const current=this.store.get('currentRegion'); if(!targets.length&&current?.size>0n)targets.push(current);
      const INPUT_LIMIT=64*1024*1024, RESULT_LIMIT=100000, DECODED_LIMIT=16*1024*1024, HEAP_LIMIT=48*1024*1024;
      let inputRemaining=INPUT_LIMIT, decodedBytes=0, estimatedHeap=0, complete=true, truncationReason=null, resume=null;
      const out=[]; let scannedRegions=0;
      for(let regionIndex=0;regionIndex<targets.length;regionIndex++){
        const r=targets[regionIndex];
        if(epoch!==this.backend.gen){complete=false;truncationReason='stale-generation';break;}
        if(inputRemaining<=0){complete=false;truncationReason='input-budget';resume={regionIndex,regionId:r.id,offset:0};break;}
        const remainingResults=RESULT_LIMIT-out.length;
        if(remainingResults<=0||decodedBytes>=DECODED_LIMIT||estimatedHeap>=HEAP_LIMIT){complete=false;truncationReason='result-budget';resume={regionIndex,regionId:r.id,offset:0};break;}
        const maxBytes=Math.min(inputRemaining,Number(r.size));
        const requestLimit=Math.min(25000,remainingResults);
        const res=await this.backend.strings({regionId:r.id,min:4,limit:requestLimit,maxBytes},onProgress);
        inputRemaining-=maxBytes; scannedRegions++;
        for(const item of res?.results||[]){
          const text=String(item.text||''), bytes=text.length*2, heap=96+bytes;
          if(out.length>=RESULT_LIMIT||decodedBytes+bytes>DECODED_LIMIT||estimatedHeap+heap>HEAP_LIMIT){complete=false;truncationReason='result-budget';resume={regionIndex,regionId:r.id,offset:item.offset??null};break;}
          out.push({addr:item.addr,text,region:r}); decodedBytes+=bytes; estimatedHeap+=heap;
        }
        if(!complete)break;
        if(res?.capped||res?.complete===false){complete=false;truncationReason=res?.truncationReason||'region-result-limit';resume={regionIndex,regionId:r.id,offset:res?.resumeOffset??null};break;}
      }
      if(scannedRegions<targets.length&&complete){complete=false;truncationReason='input-budget';}
      Object.defineProperties(out,{
        complete:{value:complete,configurable:true}, truncated:{value:!complete,configurable:true}, truncationReason:{value:truncationReason,configurable:true},
        resume:{value:resume,configurable:true}, scannedRegions:{value:scannedRegions,configurable:true}, totalRegions:{value:targets.length,configurable:true},
        decodedBytes:{value:decodedBytes,configurable:true}, estimatedHeapBytes:{value:estimatedHeap,configurable:true}, inputBytes:{value:INPUT_LIMIT-inputRemaining,configurable:true}
      });
      if(epoch===this.backend.gen)this.stringIndex=out;
      return out;
    })().finally(()=>{if(this.stringsBusyEpoch===epoch){this.stringsBusy=null;this.stringsBusyEpoch=-1;}});
    return this.stringsBusy;
  }
'''
s=s[:a]+new_strings+s[b:]
# Emit slice-generation event after applySlice in selectSlice.
a=s.index('  async selectSlice(index) {')
b=s.find('\n  ',a+5)
# locate exact method end through next selectRegion method
b=s.index('\n  selectRegion(',a)
method=s[a:b]
if "hex:slice-changed" not in method:
    needle='    this.applySlice(index,info);'
    repl="""    this.applySlice(index,info);
    document.dispatchEvent(new CustomEvent('hex:slice-changed',{detail:{sliceIndex:index,generation:this.backend.gen,identity:`${info?.name||'binary'}:${index}:${info?.slices?.[index]?.info?.uuid||info?.slices?.[index]?.name||''}`}}));"""
    if needle not in method: raise SystemExit('selectSlice apply anchor changed')
    method=method.replace(needle,repl,1);s=s[:a]+method+s[b:]
# Canonical format descriptor helper for UI.
anchor='  currentSlice() {'
pos=s.index(anchor)
if '  currentFormatDescriptor() {' not in s:
    insert=r'''  currentFormatDescriptor() {
    const info=this.store.get('fileInfo')||{}, slice=this.currentSlice(), capability=this.store.get('capability')||slice?.capability||{};
    const descriptor=slice?.descriptor||slice?.info?.formatDescriptor||info.descriptor||{};
    return {
      format:descriptor.format||info.formatId||slice?.info?.format||info.format||'raw', architecture:descriptor.architecture||capability.architecture||slice?.info?.cpu||'unknown',
      bits:descriptor.bits||capability.bits||null,endian:descriptor.endian||capability.endianness||slice?.info?.endian||null,
      entryPoint:descriptor.entryPoint??slice?.info?.entry??null,regions:descriptor.regions||slice?.regions||this.store.get('regions')||[],
      dependencies:descriptor.dependencies||slice?.info?.dependencies||slice?.info?.dylibs||[],imports:descriptor.imports||slice?.info?.imports||{items:[],total:0,complete:true},
      exports:descriptor.exports||slice?.info?.exports||{items:[],total:0,complete:true},formatMetadata:descriptor.formatMetadata||slice?.info?.formatMetadata||{}, capability,
    };
  }

'''
    s=s[:pos]+insert+s[pos:]
p.write_text(s)

# #551/#552 Product lifecycle + dependencies.
p=Path('js/ui/product.js'); s=p.read_text()
# dependencies: format-neutral descriptor first.
old="return ((slice && slice.info && slice.info.dylibs) || []).filter((x) =>"
if old in s:s=s.replace(old,"return (app.currentFormatDescriptor?.().dependencies || []).filter((x) =>",1)
# slice changed safely invalidates route.
listener="document.addEventListener('hex:slice-changed', () => router.navigate('/code'));"
if listener not in s:
    file_listener="document.addEventListener('hex:file-opened', () => router.navigate('/code'));"
    if file_listener in s:s=s.replace(file_listener,file_listener+'\n  '+listener,1)
    else:
        # insert near router start if current syntax differs
        marker='router.start();'
        if marker not in s: raise SystemExit('product router anchor changed')
        s=s.replace(marker,listener+'\n  '+marker,1)
# async function workspace commit guard: after analysis await, stale result must not render.
needle='const res = await app.analyzeFunctionAt(addr);'
if needle in s and 'viewGeneration' not in s:
    s=s.replace(needle,"const viewGeneration=app.backend.gen, viewSlice=app.store.get('sliceIndex');\n  const res = await app.analyzeFunctionAt(addr);\n  if(viewGeneration!==app.backend.gen || viewSlice!==app.store.get('sliceIndex')) return {root:screen(text('解析対象が切り替わりました','Analysis target changed'),{id:'stale-function'}).root};",1)
p.write_text(s)

# #552 Panels use generic regions for non-Mach-O and never dereference missing segments.
p=Path('js/panels.js'); s=p.read_text()
# Guard Mach-O block.
s=s.replace('  if (slice && slice.info) {\n    const m = slice.info;', "  if (slice && slice.info && Array.isArray(slice.info.segments)) {\n    const m = slice.info;",1)
# Replace else raw-only branch of file info with generic descriptor display.
old="""  } else {
    const li = el('li');
    li.append(el('span', 'sub', t('file.rawOnly')));
    ul.append(li);
  }

  if (info.warnings"""
new="""  } else if (slice) {
    const d=app.currentFormatDescriptor?.()||{};
    ul.append(groupRow(pick('バイナリ情報','Binary information')));
    ul.append(kvRow(pick('形式','Format'),String(d.format||info.format||'unknown')));
    ul.append(kvRow(pick('アーキテクチャ','Architecture'),String(d.architecture||'unknown')));
    if(d.bits)ul.append(kvRow('Bits',String(d.bits)));
    if(d.endian)ul.append(kvRow(pick('エンディアン','Endianness'),String(d.endian)));
    if(d.entryPoint!=null)ul.append(tapRow(pick('エントリポイント','Entry point'),{right:addrHex(d.entryPoint),onTap:()=>{sheet.close();app.goToAddress(d.entryPoint,{announce:true});}}));
    const deps=d.dependencies||[]; if(deps.length){ul.append(groupRow(pick('依存ライブラリ','Dependencies')+' ('+deps.length+')'));for(const dep of deps.slice(0,500))ul.append(kvRow(String(dep).split('/').pop(),'',String(dep)));}
  } else {
    const li=el('li');li.append(el('span','sub',t('file.rawOnly')));ul.append(li);
  }

  if (info.warnings"""
if old not in s: raise SystemExit('file info generic anchor changed')
s=s.replace(old,new,1)
# showSections: only Mach-O segment loop when present, otherwise canonical regions.
old='''  const slice = app.currentSlice();
  if (slice && slice.info) {
    for (const seg of slice.info.segments) {'''
new='''  const slice = app.currentSlice();
  if (slice && slice.info && Array.isArray(slice.info.segments)) {
    for (const seg of slice.info.segments) {'''
if old not in s: raise SystemExit('sections MachO anchor changed')
s=s.replace(old,new,1)
# Add generic region list before raw group.
marker="  ul.append(groupRow(t('sections.raw')));"
generic="""  if (!(slice?.info && Array.isArray(slice.info.segments))) {
    const genericRegions=app.currentFormatDescriptor?.().regions || app.store.get('regions') || [];
    ul.append(groupRow(pick('領域 / セクション','Regions / Sections')));
    for(const region of genericRegions){
      ul.append(tapRow(region.name||region.section||region.id,{sub:addrHex(region.vmAddr)+' – '+addrHex(region.vmAddr+region.declaredSize)+' · '+sizeText(region.declaredSize),tag:region.exec?t('sections.tagCode'):'',tagClass:region.exec?'exec':'',disabled:region.size===0n,onTap:()=>{sheet.close();app.selectRegion(region);}}));
    }
  }

"""+marker
if marker not in s: raise SystemExit('sections raw marker changed')
s=s.replace(marker,generic,1)
p.write_text(s)

# #554: shared byte budget and capacity+count transfer (no completion slice copies).
p=Path('js/worker-legacy.js'); s=p.read_text()
s=s.replace('const MAX_EDGES = 8_000_000;         // bl の辺\nconst MAX_REFS = 8_000_000;          // データへの参照', "const MAX_EDGES = 8_000_000;         // logical ceiling; byte budget is authoritative\nconst MAX_REFS = 8_000_000;          // logical ceiling; byte budget is authoritative\nconst PROGRAM_INDEX_MEMORY_BUDGET = 96 * 1024 * 1024; // iPad-safe shared typed-array peak budget")
# no completion slice copies
old="""  const outCallFrom = callFrom.slice(0, nCalls);
  const outCallTo = callTo.slice(0, nCalls);
  const outRefFrom = refFrom.slice(0, nRefs);
  const outRefTo = refTo.slice(0, nRefs);
  const outRefKind = refKind.slice(0, nRefs);
  return {
    regionId,
    vmAddr: region.vmAddr,
    words,
    callFrom: outCallFrom, callTo: outCallTo,
    refFrom: outRefFrom, refTo: outRefTo, refKind: outRefKind,
    kinds,
    kindsCovered: Math.min(words, kinds.length),
    callsCapped, refsCapped,
    cancelled: false,
    __transfer: [outCallFrom.buffer, outCallTo.buffer, outRefFrom.buffer,
      outRefTo.buffer, outRefKind.buffer, kinds.buffer],
  };"""
new="""  return {
    regionId, vmAddr: region.vmAddr, words,
    callFrom, callTo, callCount:nCalls,
    refFrom, refTo, refKind, refCount:nRefs,
    kinds, kindsCovered:Math.min(words,kinds.length),
    callsCapped, refsCapped, memoryBudgetBytes:PROGRAM_INDEX_MEMORY_BUDGET,
    residentBytes:programResidentBytes(), cancelled:false,
    __transfer:[callFrom.buffer,callTo.buffer,refFrom.buffer,refTo.buffer,refKind.buffer,kinds.buffer],
  };"""
if old not in s: raise SystemExit('program completion slice anchor changed')
s=s.replace(old,new,1)
# budget-aware grows
old="""  function growCalls() {
    const size = Math.min(callFrom.length * 2, MAX_EDGES);
    if (size <= callFrom.length) return false;
    callFrom = grow64(callFrom, size);
    callTo = grow64(callTo, size);
    return true;
  }
  function growRefs() {
    const size = Math.min(refFrom.length * 2, MAX_REFS);
    if (size <= refFrom.length) return false;
    refFrom = grow64(refFrom, size);
    refTo = grow64(refTo, size);
    const k = new Uint8Array(size);
    k.set(refKind); refKind = k;
    return true;
  }"""
new="""  function programResidentBytes(){return callFrom.byteLength+callTo.byteLength+refFrom.byteLength+refTo.byteLength+refKind.byteLength+kinds.byteLength;}
  function growCalls() {
    const size=Math.min(callFrom.length*2,MAX_EDGES); if(size<=callFrom.length)return false;
    const allocation=size*16; if(programResidentBytes()+allocation>PROGRAM_INDEX_MEMORY_BUDGET){callsCapped=true;return false;}
    callFrom=grow64(callFrom,size);callTo=grow64(callTo,size);return true;
  }
  function growRefs() {
    const size=Math.min(refFrom.length*2,MAX_REFS);if(size<=refFrom.length)return false;
    const allocation=size*17;if(programResidentBytes()+allocation>PROGRAM_INDEX_MEMORY_BUDGET){refsCapped=true;return false;}
    refFrom=grow64(refFrom,size);refTo=grow64(refTo,size);const k=new Uint8Array(size);k.set(refKind);refKind=k;return true;
  }"""
if old not in s: raise SystemExit('program grow anchor changed')
s=s.replace(old,new,1)
p.write_text(s)

# ProgramIndex honors transfer capacity counts without a copy.
p=Path('js/program.js'); s=p.read_text()
old="""    this.callFrom = s.callFrom || new BigUint64Array(0);
    this.callTo = s.callTo || new BigUint64Array(0);
    this.refFrom = s.refFrom || new BigUint64Array(0);
    this.refTo = s.refTo || new BigUint64Array(0);
    this.refKind = s.refKind || new Uint8Array(0);"""
new="""    const rawCallFrom=s.callFrom||new BigUint64Array(0),rawCallTo=s.callTo||new BigUint64Array(0),callCount=Math.max(0,Math.min(rawCallFrom.length,rawCallTo.length,Number.isInteger(s.callCount)?s.callCount:rawCallFrom.length));
    const rawRefFrom=s.refFrom||new BigUint64Array(0),rawRefTo=s.refTo||new BigUint64Array(0),rawRefKind=s.refKind||new Uint8Array(0),refCount=Math.max(0,Math.min(rawRefFrom.length,rawRefTo.length,rawRefKind.length,Number.isInteger(s.refCount)?s.refCount:rawRefFrom.length));
    this.callFrom=rawCallFrom.subarray(0,callCount);this.callTo=rawCallTo.subarray(0,callCount);
    this.refFrom=rawRefFrom.subarray(0,refCount);this.refTo=rawRefTo.subarray(0,refCount);this.refKind=rawRefKind.subarray(0,refCount);"""
if old not in s: raise SystemExit('ProgramIndex arrays anchor changed')
s=s.replace(old,new,1)
s=s.replace("    this.refsCapped = !!s.refsCapped;", "    this.refsCapped = !!s.refsCapped;\n    this.memoryBudgetBytes=s.memoryBudgetBytes||null;this.residentBytes=s.residentBytes||null;")
p.write_text(s)
