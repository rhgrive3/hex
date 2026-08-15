from pathlib import Path

p=Path('js/binary/elf-dynamic.js')
text=p.read_text()
if "from './dynamic-symbol-budget.js'" not in text:
    text=text.replace("import { functionSeed } from './model.js';\n", "import { functionSeed } from './model.js';\nimport { createDynamicSymbolBudget } from './dynamic-symbol-budget.js';\n", 1)

old="""  let symbolCount = 0;
  let symbolCountSource = 'none';
  if (symtab != null && symentValid) {
    symbolCount = symbolCountFromHash(r, one(DT_HASH), image);
    if (symbolCount) symbolCountSource = 'sysv-hash';
    if (!symbolCount) { symbolCount = symbolCountFromGnuHash(r, one(DT_GNU_HASH), image, bits); if (symbolCount) symbolCountSource = 'gnu-hash'; }
    if (!symbolCount) { symbolCount = symbolCountFromRelocations(relocs); if (symbolCount) symbolCountSource = 'relocations'; }
    if (!symbolCount) {
      symbolCount = symbolCountFromLayout(symtab, strtab, syment, image, r);
      if (symbolCount) { symbolCountSource = 'layout-heuristic'; markExtendedPartial(image, 'dynamic symbol count was inferred from bounded SYMTAB/STRTAB layout'); }
    }
  }

  const versions = parseDynamicSymbolVersions(r, tags, image, symbolCount, stringAt);
  let symbols = [];
  if (opts.symbols !== false && symtab != null && symbolCount > 0) {
    symbols = parseDynamicSymbols(r, image, bits, symtab, syment, symbolCount, stringAt, versions);
  } else if (symtab != null && symbolCount > 0) {
    symbols = dynamicSymbolsFromImage(image);
  }

  applyVersionMetadata(image, versions);
"""
new="""  const symbolBudget = createDynamicSymbolBudget({
    limits: opts.dynamicSymbolLimits || {},
    onLimit(message) { markDynamicPartial(image, `dynamic symbol decode budget exceeded: ${message}`); },
  });
  let declaredSymbolCount = 0;
  let symbolCountSource = 'none';
  if (symtab != null && symentValid) {
    declaredSymbolCount = symbolCountFromHash(r, one(DT_HASH), image);
    if (declaredSymbolCount) symbolCountSource = 'sysv-hash';
    if (!declaredSymbolCount) { declaredSymbolCount = symbolCountFromGnuHash(r, one(DT_GNU_HASH), image, bits); if (declaredSymbolCount) symbolCountSource = 'gnu-hash'; }
    if (!declaredSymbolCount) { declaredSymbolCount = symbolCountFromRelocations(relocs); if (declaredSymbolCount) symbolCountSource = 'relocations'; }
    if (!declaredSymbolCount) {
      declaredSymbolCount = symbolCountFromLayout(symtab, strtab, syment, image, r);
      if (declaredSymbolCount) { symbolCountSource = 'layout-heuristic'; markExtendedPartial(image, 'dynamic symbol count was inferred from bounded SYMTAB/STRTAB layout'); }
    }
  }

  const symbolFileCapacity = symtab != null && symentValid
    ? dynamicSymbolFileCapacity(r, image, tags, symtab, syment)
    : 0;
  let symbolCount = Math.min(declaredSymbolCount, symbolFileCapacity, symbolBudget.limits.maxSymbolRecords);
  if (declaredSymbolCount > symbolFileCapacity) {
    markDynamicPartial(image, `dynamic symbol count ${declaredSymbolCount} exceeds file-backed SYMTAB capacity ${symbolFileCapacity}; clamped`);
  }
  if (declaredSymbolCount > symbolBudget.limits.maxSymbolRecords) {
    markDynamicPartial(image, `dynamic symbol count ${declaredSymbolCount} exceeds symbol record limit ${symbolBudget.limits.maxSymbolRecords}; clamped`);
  }

  const versions = parseDynamicSymbolVersions(r, tags, image, symbolCount, stringAt, { budget: symbolBudget });
  let symbols = [];
  if (!symbolBudget.stopped && opts.symbols !== false && symtab != null && symbolCount > 0) {
    symbols = parseDynamicSymbols(r, image, bits, symtab, syment, symbolCount, stringAt, versions, symbolBudget);
  } else if (symtab != null && symbolCount > 0) {
    symbols = dynamicSymbolsFromImage(image, symbolCount);
  }

  applyVersionMetadata(image, versions, symbolBudget);
  image.metadata.programDynamicSymbolBudget = symbolBudget.snapshot();
"""
if new not in text:
    if old not in text: raise SystemExit('dynamic symbol pipeline anchor not found')
    text=text.replace(old,new,1)

old="""  image.metadata.programDynamic = {
    entries: ordered.length,
    symbols: symbolCount,
    symbolCountSource,
    relocations: relocs.length,
"""
new="""  image.metadata.programDynamic = {
    entries: ordered.length,
    symbols: symbols.length,
    symbolsExpected: symbolCount,
    symbolsDeclared: declaredSymbolCount,
    symbolFileCapacity,
    symbolCountSource,
    relocations: relocs.length,
"""
if new not in text:
    if old not in text: raise SystemExit('programDynamic metadata anchor not found')
    text=text.replace(old,new,1)
old="return { parsed: true, tags, symbols: symbolCount, relocations: relocs.length };"
new="return { parsed: true, tags, symbols: symbols.length, relocations: relocs.length };"
if new not in text:
    if old not in text: raise SystemExit('parseProgramDynamic return anchor not found')
    text=text.replace(old,new,1)

start=text.index('function parseDynamicSymbols(r, image, bits, symtabVa, syment, count, stringAt, versions = new Map()) {')
end=text.index('\nfunction applyVersionMetadata(', start)
replacement=r'''function parseDynamicSymbols(r, image, bits, symtabVa, syment, count, stringAt, versions = new Map(), budget = null) {
  const off = vaToOffset(image, symtabVa);
  const ent = toSafeNumber(syment);
  if (off == null || ent == null || ent <= 0) return [];
  const max = Math.min(count, Math.floor((r.length - off) / ent));
  if (budget && !budget.claimInput(max * ent, 'DT_SYMTAB')) return [];
  const out = [];
  for (let i = 0; i < max; i++) {
    if (budget && !budget.step(1, 'DT_SYMTAB decode')) break;
    const p = off + i * ent;
    let nameOff, info, other, shndx, value, size;
    if (bits === 64) {
      if (p + 24 > r.length) break;
      nameOff = r.u32(p); info = r.u8(p + 4); other = r.u8(p + 5); shndx = r.u16(p + 6);
      value = r.u64(p + 8); size = r.u64(p + 16);
    } else {
      if (p + 16 > r.length) break;
      nameOff = r.u32(p); value = BigInt(r.u32(p + 4)); size = BigInt(r.u32(p + 8));
      info = r.u8(p + 12); other = r.u8(p + 13); shndx = r.u16(p + 14);
    }
    if (budget && !budget.claimOutput(1, 224, 'DT_SYMTAB symbols')) break;
    const name = stringAt(BigInt(nameOff));
    const bind = info >>> 4;
    const type = info & 0xf;
    const defined = shndx !== 0;
    const binding = bind === 0 ? 'local' : bind === 1 ? 'global' : bind === 2 ? 'weak' : `bind-${bind}`;
    const kind = type === 2 ? 'function' : type === 1 ? 'object' : type === 3 ? 'section' : type === 6 ? 'tls' : `type-${type}`;
    const ver = versions.get(i) || null;
    const sym = { name, address: value, size, kind, binding, defined, sectionIndex: shndx, visibility: other & 3, source: 'PT_DYNAMIC', index: i, tableIndex: -1, versionIndex: ver?.index ?? null, version: ver?.name ?? null, versionHidden: ver?.hidden ?? false, versionLibrary: ver?.library ?? null };
    out.push(sym);
    if (!name) continue;
    image.symbols.push(sym);
    if (!defined && (bind === 1 || bind === 2)) {
      if (budget && !budget.claimOutput(1, 160, 'PT_DYNAMIC imports')) break;
      image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, version: ver?.name ?? null, versionLibrary: ver?.library ?? null, versionIndex: ver?.index ?? null, symbolIndex: i, source: 'PT_DYNAMIC', sites: [] });
    }
    if (defined && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) {
      if (budget && !budget.claimOutput(1, 144, 'PT_DYNAMIC exports')) break;
      image.exports.push({ name, address: value, kind, version: ver?.name ?? null, versionIndex: ver?.index ?? null, symbolIndex: i, source: 'PT_DYNAMIC' });
    }
    if (defined && type === 2 && value !== 0n) {
      if (budget && !budget.claimOutput(1, 128, 'PT_DYNAMIC function seeds')) break;
      image.functions.push(functionSeed(value, { size: size || null, name, source: 'symbol', confidence: 0.995 }));
    }
  }
  return out;
}
'''
text=text[:start]+replacement+text[end:]

start=text.index('function applyVersionMetadata(image, versions) {')
end=text.index('\nfunction collectDynamicRelocations(', start)
replacement=r'''function applyVersionMetadata(image, versions, budget = null) {
  if (!versions?.size || budget?.stopped) return;
  const importByIndex = new Map();
  const exportByIndex = new Map();
  for (const imp of image.imports) {
    if (imp.symbolIndex == null) continue;
    if (budget && (!budget.step(1, 'version import index') || !budget.claimOutput(1, 48, 'version import index'))) return;
    if (!importByIndex.has(imp.symbolIndex)) importByIndex.set(imp.symbolIndex, imp);
  }
  for (const ex of image.exports) {
    if (ex.symbolIndex == null) continue;
    if (budget && (!budget.step(1, 'version export index') || !budget.claimOutput(1, 48, 'version export index'))) return;
    if (!exportByIndex.has(ex.symbolIndex)) exportByIndex.set(ex.symbolIndex, ex);
  }
  for (const sym of image.symbols) {
    if (budget && !budget.step(1, 'version metadata apply')) return;
    if (sym.source !== 'dynsym' && sym.source !== 'PT_DYNAMIC') continue;
    const ver = versions.get(sym.index);
    if (!ver) continue;
    sym.versionIndex = ver.index; sym.version = ver.name; sym.versionHidden = ver.hidden; sym.versionLibrary = ver.library;
    if (!sym.defined && sym.name) {
      const imp = importByIndex.get(sym.index);
      if (imp && imp.name === sym.name && imp.version == null) { imp.version = ver.name; imp.versionLibrary = ver.library; imp.versionIndex = ver.index; }
    } else if (sym.defined && sym.name) {
      const ex = exportByIndex.get(sym.index);
      if (ex && ex.name === sym.name && ex.address === sym.address && ex.version == null) { ex.version = ver.name; ex.versionIndex = ver.index; }
    }
  }
}
'''
text=text[:start]+replacement+text[end:]

old="""function dynamicSymbolsFromImage(image) {
  const dyn = image.symbols.filter((s) => s.source === 'dynsym' || s.source === 'PT_DYNAMIC');
  return dyn.map((s, i) => ({ ...s, index: s.index ?? i }));
}
"""
new="""function dynamicSymbolsFromImage(image, limit = Number.MAX_SAFE_INTEGER) {
  const out = [];
  for (const s of image.symbols) {
    if (s.source !== 'dynsym' && s.source !== 'PT_DYNAMIC') continue;
    if (out.length >= limit) break;
    if (s.index == null) s.index = out.length;
    out.push(s);
  }
  return out;
}
"""
if new not in text:
    if old not in text: raise SystemExit('dynamicSymbolsFromImage anchor not found')
    text=text.replace(old,new,1)

insert_before='function symbolCountFromHash(r, hashVa, image) {'
helper=r'''export function dynamicSymbolFileCapacity(r, image, tags, symtabVa, syment) {
  const off = vaToOffset(image, symtabVa);
  const ent = toSafeNumber(syment);
  if (off == null || ent == null || ent <= 0 || off >= r.length) return 0;
  let end = r.length;
  // Known pointer-valued PT_DYNAMIC tables provide a stronger boundary than EOF.
  const pointerTags = [
    4n, 5n, 7n, 17n, 23n, 36n,
    0x6000000fn, 0x60000011n,
    0x6ffffef5n, 0x6ffffff0n, 0x6ffffffcn, 0x6ffffffen,
  ];
  for (const tag of pointerTags) {
    for (const va of tags.get(tag) || []) {
      if (va === symtabVa) continue;
      const candidate = vaToOffset(image, va);
      if (candidate != null && candidate > off && candidate < end) end = candidate;
    }
  }
  return Math.max(0, Math.floor((end - off) / ent));
}

'''
if 'export function dynamicSymbolFileCapacity' not in text:
    if insert_before not in text: raise SystemExit('symbol capacity insertion anchor not found')
    text=text.replace(insert_before,helper+insert_before,1)
p.write_text(text)

p=Path('js/binary/elf-extended.js')
text=p.read_text()
if "from './dynamic-symbol-budget.js'" not in text:
    text=text.replace("import { createRelocationBudget } from './relocation-budget.js';\n", "import { createRelocationBudget } from './relocation-budget.js';\nimport { createDynamicSymbolBudget } from './dynamic-symbol-budget.js';\n",1)
start=text.index('export function parseDynamicSymbolVersions(r,tags,image,symbolCount,stringAt){')
replacement=r'''function symbolBudgetContext(image, context) {
  const c = context && typeof context === 'object' ? context : {};
  return c.budget || createDynamicSymbolBudget({
    limits:c.limits || {},
    onLimit(message){ partial(image, `dynamic symbol decode budget exceeded: ${message}`); },
  });
}

export function parseDynamicSymbolVersions(r,tags,image,symbolCount,stringAt,context=null){
  const out=new Map(), versym=one(tags,DT_VERSYM); if(versym==null||symbolCount<=0)return out;
  const budget=symbolBudgetContext(image,context);
  const count=Math.min(symbolCount,budget.limits.maxSymbolRecords);
  if(symbolCount>count)partial(image,`DT_VERSYM symbol count ${symbolCount} exceeds record limit ${count}; clamped`);
  const voff=vaToOffset(image,versym); if(voff==null||voff+count*2>r.length){partial(image,'DT_VERSYM table is truncated');return out;}
  if(!budget.claimInput(count*2,'DT_VERSYM'))return out;
  const names=new Map();
  const verdef=one(tags,DT_VERDEF), verdefnum=safe(one(tags,DT_VERDEFNUM)??0n);
  if(verdef!=null&&verdefnum){let p=vaToOffset(image,verdef);for(let i=0;p!=null&&i<Math.min(verdefnum,65536)&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERDEF decode'))break;
    if(p+20>r.length){partial(image,'DT_VERDEF is truncated');break;}
    if(!budget.claimInput(20,'DT_VERDEF'))break;
    const ndx=r.u16(p+4)&0x7fff,aux=r.u32(p+12),next=r.u32(p+16),ap=p+aux;
    if(ap+8>r.length){partial(image,'DT_VERDEF auxiliary entry is truncated');break;}
    if(!budget.claimInput(8,'DT_VERDEF auxiliary'))break;
    const name=stringAt(BigInt(r.u32(ap)));
    if(name){if(!budget.claimOutput(1,96,'DT_VERDEF names'))break;names.set(ndx,{name,definition:true,library:null});}
    if(!next)break;p+=next;
  }}
  const verneed=one(tags,DT_VERNEED), verneednum=safe(one(tags,DT_VERNEEDNUM)??0n);
  if(verneed!=null&&verneednum&&!budget.stopped){let p=vaToOffset(image,verneed);for(let i=0;p!=null&&i<Math.min(verneednum,65536)&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERNEED decode'))break;
    if(p+16>r.length){partial(image,'DT_VERNEED is truncated');break;}
    if(!budget.claimInput(16,'DT_VERNEED'))break;
    const cnt=r.u16(p+2),file=stringAt(BigInt(r.u32(p+4))),aux=r.u32(p+8),next=r.u32(p+12);let ap=p+aux;
    for(let j=0;j<cnt&&j<65536&&!budget.stopped;j++){
      if(!budget.step(1,'DT_VERNEED auxiliary decode'))break;
      if(ap+16>r.length){partial(image,'DT_VERNEED auxiliary entry is truncated');break;}
      if(!budget.claimInput(16,'DT_VERNEED auxiliary'))break;
      const other=r.u16(ap+6)&0x7fff,name=stringAt(BigInt(r.u32(ap+8))),anext=r.u32(ap+12);
      if(name){if(!budget.claimOutput(1,112,'DT_VERNEED names'))break;names.set(other,{name,definition:false,library:file||null});}
      if(!anext)break;ap+=anext;
    }
    if(!next)break;p+=next;
  }}
  for(let i=0;i<count&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERSYM decode'))break;
    const raw=r.u16(voff+i*2),index=raw&0x7fff;if(index<=1)continue;
    if(!budget.claimOutput(1,96,'DT_VERSYM entries'))break;
    const named=names.get(index);out.set(i,{index,hidden:!!(raw&0x8000),name:named?.name||null,library:named?.library||null,definition:named?.definition??null});
  }
  image.metadata.symbolVersions={entries:out.size,named:[...out.values()].filter(v=>v.name).length,complete:!budget.stopped};
  return out;
}
'''
text=text[:start]+replacement+'\n'
p.write_text(text)
