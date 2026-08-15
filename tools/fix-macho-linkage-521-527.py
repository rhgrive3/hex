from pathlib import Path

# #521: canonical platform Mach-O import/export model feeds the same symbol result consumed by App.
p=Path('js/platform/worker.js'); s=p.read_text()
old="""  for (const exp of image.exports || []) {
    if (exp?.address == null || !exp.name) continue;
    const key = BigInt(exp.address).toString();
    const existing = entries.get(key);
    if (existing) existing.exported = true;
    else entries.set(key, { address: BigInt(exp.address), name: exp.name, exported: true });
  }"""
new="""  for (const exp of image.exports || []) {
    if (exp?.address == null || !exp.name || BigInt(exp.address) === 0n) continue;
    const key = BigInt(exp.address).toString();
    const existing = entries.get(key);
    if (existing) existing.exported = true;
    else entries.set(key, { address: BigInt(exp.address), name: exp.name, exported: true });
  }
  let importedCount=0;
  for (const imp of image.imports || []) {
    if (!imp?.name) continue;
    for (const site of imp.sites || []) {
      if (site?.address == null) continue;
      const address=BigInt(site.address), key=address.toString(), name=imp.library?`${imp.library}!${imp.name}`:imp.name;
      if (!entries.has(key)) entries.set(key,{address,name,exported:false,imported:true});
      importedCount++;
    }
  }"""
if old not in s: raise SystemExit('platform analyze exports anchor missing')
s=s.replace(old,new,1)
s=s.replace("for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].address; flags[i] = sorted[i].exported ? 1 : 0; }", "for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].address; kinds[i]=sorted[i].imported?2:0; flags[i] = sorted[i].exported ? 1 : 0; }")
s=s.replace("symbolCount: addrs.length, funcCount: funcs.length, capped: false,", "symbolCount: addrs.length, funcCount: funcs.length, importedCount, canonicalLinkage:true, capped:false,")
p.write_text(s)

# Backend opens normalized Mach-O image alongside legacy compatibility parser and merges analyses.
p=Path('js/backend.js'); s=p.read_text()
old="""    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      const legacy = await this._callTo('legacy', 'open', { file });
      legacy.formatId = 'macho';"""
new="""    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      let normalized=null;
      try { normalized=await this._callTo('platform','open',{file},null,(p)=>this.onAnalysisProgress?.(p)); } catch { normalized=null; }
      const legacy = await this._callTo('legacy', 'open', { file });
      legacy.formatId = 'macho';"""
if old not in s: raise SystemExit('backend macho open anchor missing')
s=s.replace(old,new,1)
s=s.replace("nextPlatform = { formatId:'macho', capability:legacy.capability, detection, compatibility:'legacy-macho' };", "nextPlatform = normalized || { formatId:'macho', capability:legacy.capability, detection, compatibility:'legacy-macho' };\n      legacy.platform = { ...(legacy.platform||{}), normalized:!!normalized, canonicalLinkage:!!normalized };",1)
# merge helper before class end helper functions
insert=r'''
function mergeSymbolAnalyses(primary, secondary) {
  if(!secondary?.addrs?.length)return primary;
  const pnames=typeof primary?.names==='string'?primary.names.split('\n'):[], snames=typeof secondary.names==='string'?secondary.names.split('\n'):[];
  const map=new Map();
  const add=(res,names,prefer)=>{for(let i=0;i<(res?.addrs?.length||0);i++){const addr=BigInt(res.addrs[i]),key=addr.toString(),name=names[i]||'';const old=map.get(key);if(!old||(!old.name&&name)||prefer)map.set(key,{addr,name:name||old?.name||'',kind:res.kinds?.[i]||old?.kind||0,flag:res.flags?.[i]||old?.flag||0});}};
  add(primary,pnames,false);add(secondary,snames,false);
  const rows=[...map.values()].sort((a,b)=>a.addr<b.addr?-1:a.addr>b.addr?1:0),addrs=new BigUint64Array(rows.length),kinds=new Uint8Array(rows.length),flags=new Uint8Array(rows.length);
  rows.forEach((x,i)=>{addrs[i]=x.addr;kinds[i]=x.kind;flags[i]=x.flag;});
  const funcs=[...new Set([...(primary?.funcs||[]),...(secondary?.funcs||[])].map((x)=>BigInt(x).toString()))].map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);
  return {...primary,addrs,kinds,flags,names:rows.map((x)=>x.name).join('\n'),funcs:new BigUint64Array(funcs),symbolCount:rows.length,funcCount:funcs.length,canonicalLinkage:true,importedCount:secondary.importedCount||0,functionStartsExact:!!primary?.functionStartsExact&&!!secondary?.functionStartsExact};
}
'''
anchor='function normalizeChunk(res) {'
if insert not in s:s=s.replace(anchor,insert+'\n'+anchor,1)
old="""  analyze(sliceIndex) {
    const worker = this.formatId === 'macho' ? 'legacy' : 'platform';
    const file = this.file;
    return this._callTo(worker, 'analyze', { sliceIndex }).then((result) => {
      if (this.formatId !== 'macho') return result;
      return augmentAnalysisResultWithChainedImports(file, sliceIndex, result);
    });
  }"""
new="""  analyze(sliceIndex) {
    if(this.formatId!=='macho')return this._callTo('platform','analyze',{sliceIndex});
    const file=this.file;
    return Promise.all([
      this._callTo('legacy','analyze',{sliceIndex}),
      this.platformInfo?.canonicalLinkage===false||this.platformInfo?.compatibility==='legacy-macho' ? Promise.resolve(null) : this._callTo('platform','analyze',{sliceIndex}).catch(()=>null),
    ]).then(async([legacy,normalized])=>{
      if(normalized?.canonicalLinkage)return mergeSymbolAnalyses(legacy,normalized);
      return augmentAnalysisResultWithChainedImports(file,sliceIndex,legacy);
    });
  }"""
if old not in s: raise SystemExit('backend analyze anchor missing')
s=s.replace(old,new,1)
# metadata prefer platform when normalized
old="""  binaryMetadata(kind = 'summary', start = 0, limit = 500) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'metadata', { kind, start, limit });
    const slice = this.legacyInfo?.slices?.[0] || null;"""
new="""  binaryMetadata(kind = 'summary', start = 0, limit = 500) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'metadata', { kind, start, limit });
    if(this.platformInfo && this.platformInfo.compatibility!=='legacy-macho') return this._callTo('platform','metadata',{kind,start,limit}).catch(()=>this.binaryMetadataLegacy(kind,start,limit));
    return this.binaryMetadataLegacy(kind,start,limit);
  }
  binaryMetadataLegacy(kind='summary',start=0,limit=500){
    const slice = this.legacyInfo?.slices?.[0] || null;"""
if old not in s: raise SystemExit('binaryMetadata anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# #527 bound old chained fallback globally and refuse giant sections/blobs.
p=Path('js/chained.js'); s=p.read_text()
if 'CHAINED_MAX_FIXUP_BYTES' not in s:
    s=s.replace("const S_SYMBOL_STUBS = 0x8;", "const S_SYMBOL_STUBS = 0x8;\nconst CHAINED_MAX_FIXUP_BYTES = 16 * 1024 * 1024;\nconst CHAINED_MAX_STUB_BYTES = 32 * 1024 * 1024;\nconst CHAINED_MAX_OUTPUTS = 500000;")
s=s.replace("if (!image || !image.fixups || !image.stubs.length) return [];\n  const raw = await bytes(file, image.base + image.fixups.dataoff, image.fixups.datasize);", "if (!image || !image.fixups || !image.stubs.length) return [];\n  if(image.fixups.datasize<=0 || image.fixups.datasize>CHAINED_MAX_FIXUP_BYTES)return [];\n  const raw = await bytes(file, image.base + image.fixups.dataoff, image.fixups.datasize);")
s=s.replace("  const read64 = makeBlockReader(file);\n  const out = [];\n  for (const sec of image.stubs) {\n    const code = await bytes(file, image.base + sec.fileoff, sec.size);", "  const read64 = makeBlockReader(file);\n  const out = []; let stubBytes=0;\n  for (const sec of image.stubs) {\n    if(sec.size>BigInt(CHAINED_MAX_STUB_BYTES)||stubBytes+Number(sec.size)>CHAINED_MAX_STUB_BYTES)break;\n    stubBytes+=Number(sec.size);\n    const code = await bytes(file, image.base + sec.fileoff, sec.size);")
s=s.replace("      out.push({ addr: stubAddr, name, kind: 1 });", "      if(out.length>=CHAINED_MAX_OUTPUTS) return out;\n      out.push({ addr: stubAddr, name, kind: 1 });")
p.write_text(s)

# Legacy ObjC helper gets a shared memory budget; huge pointer/text sections are skipped fail-soft.
p=Path('js/worker-legacy.js'); s=p.read_text()
old="async function objcStubNames(source, readMem) {"
new="async function objcStubNames(source, readMem, limits = { maxBytes:32 * 1024 * 1024, maxObjects:500000 }) {\n  let budgetBytes=0, budgetObjects=0;\n  const reserve=(bytes,objects=0)=>{if(bytes<0||budgetBytes+bytes>limits.maxBytes||budgetObjects+objects>limits.maxObjects)return false;budgetBytes+=bytes;budgetObjects+=objects;return true;};"
if old not in s: raise SystemExit('objcStubNames anchor missing')
s=s.replace(old,new,1)
# Generic protection before large section reads: match `const raw = await source.read...` patterns inside function is risky. Inject after function start helper by replacing recognized size guard.
s=s.replace("if (Number(sec.size) > 8 * 1024 * 1024) continue;", "if (Number(sec.size) > 8 * 1024 * 1024 || !reserve(Number(sec.size))) continue;")
# cap result pushes inside function globally only for objc local variable `names.push` if exists
s=s.replace("names.push({ addr:", "if (budgetObjects++ >= limits.maxObjects) break;\n      names.push({ addr:")
p.write_text(s)
