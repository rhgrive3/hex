from pathlib import Path


def replace(path, old, new, label, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,count))

# ---------------------------------------------------------------------------
# elf.js — ET_REL address domain + shared section/unwind metadata budget.
# ---------------------------------------------------------------------------
p=Path('js/binary/elf.js'); s=p.read_text()
s=s.replace("import { parseProgramDynamic } from './elf-dynamic.js';", "import { parseProgramDynamic } from './elf-dynamic.js';\nimport { createELFMetadataBudget } from './elf-budget.js';\nimport { executableELFRange } from './elf-mapping.js';",1)
s=s.replace("const PT_LOAD = 1;", "const ET_REL = 1;\nconst PT_LOAD = 1;",1)
s=s.replace("const SHN_UNDEF = 0;\nconst SHN_XINDEX = 0xffff;", "const SHN_UNDEF = 0;\nconst SHN_LORESERVE = 0xff00;\nconst SHN_ABS = 0xfff1;\nconst SHN_COMMON = 0xfff2;\nconst SHN_XINDEX = 0xffff;",1)
s=s.replace('export function parseELF(input) {','export function parseELF(input, options = {}) {',1)
old="""  const rawSections = parseSectionHeaders(r, h, bits, image);
  nameSections(r, rawSections, h);
  for (const s of rawSections) {
    image.addSection({
      name: s.name || `section_${s.index}`, segment: null,
      address: s.addr, size: s.size, fileOffset: s.offset,
      fileSize: s.type === 8 ? 0n : s.size,
      perms: { read: !!(s.flags & SHF_ALLOC), write: !!(s.flags & SHF_WRITE), execute: !!(s.flags & SHF_EXECINSTR) },
      flags: s.flags, type: s.type, index: s.index, source: 'section-header',
    });
  }

  image.imageBase = findImageBase(image);
  if (image.entrypoint && image.entrypoint !== 0n) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));

  const symbolTables = rawSections.filter((s) => s.type === SHT_SYMTAB || s.type === SHT_DYNSYM);
  for (const s of symbolTables) parseSymbols(r, s, rawSections, image, bits);
  for (const s of rawSections) {
    if (s.type === SHT_REL || s.type === SHT_RELA) parseRelocations(r, s, rawSections, image, bits);
    else if (s.type === SHT_DYNAMIC) parseDynamic(r, s, rawSections, image, bits);
  }"""
new="""  const rawSections = parseSectionHeaders(r, h, bits, image);
  nameSections(r, rawSections, h);
  if (h.type === ET_REL) assignRelocatableSectionAddresses(rawSections, image);
  for (const s of rawSections) {
    image.addSection({
      name: s.name || `section_${s.index}`, segment: null,
      address: h.type === ET_REL ? (s.syntheticAddr ?? 0n) : s.addr, size: s.size, fileOffset: s.offset,
      fileSize: s.type === 8 ? 0n : s.size,
      perms: { read: !!(s.flags & SHF_ALLOC), write: !!(s.flags & SHF_WRITE), execute: !!(s.flags & SHF_EXECINSTR) },
      flags: s.flags, type: s.type, index: s.index, source: h.type === ET_REL ? 'ET_REL-synthetic-section' : 'section-header',
    });
  }

  image.imageBase = h.type === ET_REL ? 0n : findImageBase(image);
  if (h.type !== ET_REL && image.entrypoint && image.entrypoint !== 0n) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));
  const metadataBudget = createELFMetadataBudget(image, { signal: options.signal, limits: options.metadataLimits });

  const symbolTables = rawSections.filter((s) => s.type === SHT_SYMTAB || s.type === SHT_DYNSYM);
  for (const s of symbolTables) parseSymbols(r, s, rawSections, image, bits, h.type, metadataBudget);
  for (const s of rawSections) {
    if (s.type === SHT_REL || s.type === SHT_RELA) parseRelocations(r, s, rawSections, image, bits, h.type, metadataBudget);
    else if (s.type === SHT_DYNAMIC) parseDynamic(r, s, rawSections, image, bits, metadataBudget);
  }"""
if old not in s: raise SystemExit('ELF main parse anchor missing')
s=s.replace(old,new,1)
s=s.replace('if (ehFrameHdr) parseEhFrameHeader(r, ehFrameHdr, image, bits);\n\n  return image.finalize();', "if (ehFrameHdr) parseEhFrameHeader(r, ehFrameHdr, image, bits, metadataBudget);\n  image.metadata.elfMetadata = metadataBudget.snapshot();\n\n  return image.finalize();",1)
anchor='function readHeader(r, bits) {'
helpers=r'''function alignUp(value, alignment) {
  const a = alignment > 0n ? alignment : 1n;
  const rem = value % a;
  return rem === 0n ? value : value + (a - rem);
}

function assignRelocatableSectionAddresses(sections, image) {
  let cursor = 0x100000000n;
  const MAX_ALIGN = 0x1000000n;
  for (const sec of sections) {
    if (sec.index === 0 || sec.size <= 0n) { sec.syntheticAddr = 0n; continue; }
    const requested = sec.addralign > 0n ? sec.addralign : 1n;
    const alignment = requested > MAX_ALIGN ? MAX_ALIGN : requested;
    cursor = alignUp(cursor, alignment);
    sec.syntheticAddr = cursor;
    cursor += sec.size > 0n ? sec.size : 1n;
  }
  image.metadata.relocatableAddressModel = {
    kind:'synthetic-section-layout', base:'0x100000000', sections:sections.filter((s)=>s.syntheticAddr).length,
  };
}

function normalSectionIndex(index, sections) {
  return Number.isInteger(index) && index > 0 && index < sections.length && index < SHN_LORESERVE;
}

function symbolAddressForELF(elfType, value, sectionIndex, sections) {
  if (elfType !== ET_REL) return value;
  if (sectionIndex === SHN_ABS) return value;
  if (sectionIndex === SHN_COMMON || sectionIndex === SHN_UNDEF) return null;
  if (!normalSectionIndex(sectionIndex, sections)) return null;
  const sec = sections[sectionIndex];
  if (value > sec.size) return null;
  return (sec.syntheticAddr ?? 0n) + value;
}

'''
if anchor not in s: raise SystemExit('ELF helper insertion anchor missing')
s=s.replace(anchor,helpers+anchor,1)
p.write_text(s)

p=Path('js/binary/elf.js'); s=p.read_text(); a=s.index('function parseSymbols('); b=s.index('\nfunction parseRelocations(',a)
new_symbols=r'''function parseSymbols(r, table, sections, image, bits, elfType, budget) {
  const str = sections[table.link];
  if (!str || str.type !== SHT_STRTAB || !table.entsize) return;
  const minEnt = BigInt(bits === 64 ? 24 : 16);
  if (table.entsize < minEnt) { budget.partial(`symbols:${table.index}:entry-size`, `ELF symbol table ${table.index} entry size ${table.entsize} is smaller than ${minEnt}`); return; }
  const tableStart = safeOffset(table.offset), ent = safeOffset(table.entsize);
  const strStart = safeOffset(str.offset), strBytes = safeOffset(str.size);
  if (tableStart == null || ent == null || strStart == null || strBytes == null || tableStart > r.length || strStart > r.length || strBytes > r.length-strStart) {
    budget.partial(`symbols:${table.index}:file-span`, `ELF symbol/string table ${table.index} exceeds the file`); return;
  }
  const declaredBig = table.size / table.entsize;
  const fileCapacity = Math.floor((r.length-tableStart)/ent);
  const declared = declaredBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(declaredBig);
  const count = Math.min(declared,fileCapacity);
  if (declaredBig > BigInt(fileCapacity)) budget.partial(`symbols:${table.index}:truncated`, `ELF symbol table ${table.index} exceeds its file-backed capacity`);
  const xindex = sections.find((sec) => sec.type === SHT_SYMTAB_SHNDX && sec.link === table.index) || null;
  const xindexValid = !!xindex && (!xindex.entsize || xindex.entsize === 4n)
    && xindex.offset <= BigInt(r.length) && xindex.size <= BigInt(r.length) - xindex.offset;
  if (xindex && !xindexValid) budget.partial(`symbols:${table.index}:xindex-malformed`, `ELF SHT_SYMTAB_SHNDX for table ${table.index} is malformed`);

  for (let i=0;i<count;i++) {
    if (!budget.take({inputBytes:ent,records:1,objects:1,operations:2,estimatedHeapBytes:224},`symbols-${table.index}`)) break;
    const p=tableStart+i*ent;
    let nameOff,info,other,shndx,value,size;
    if(bits===64){nameOff=r.u32(p);info=r.u8(p+4);other=r.u8(p+5);shndx=r.u16(p+6);value=r.u64(p+8);size=r.u64(p+16);}
    else{nameOff=r.u32(p);value=BigInt(r.u32(p+4));size=BigInt(r.u32(p+8));info=r.u8(p+12);other=r.u8(p+13);shndx=r.u16(p+14);}
    if (BigInt(nameOff) >= str.size || nameOff >= strBytes) continue;
    const maxName=Math.min(strBytes-nameOff,1<<20,Math.max(1,Math.floor(budget.remainingStringBytes/2)+1));
    const name=r.cstring(strStart+nameOff,maxName);
    if(!name)continue;
    if(!budget.take({inputBytes:Math.min(maxName,name.length+1),stringBytes:name.length*2,estimatedHeapBytes:name.length*2+32},'symbol-name'))break;
    const bind=info>>>4,type=info&0xf;
    let resolvedShndx=shndx,sectionIdentityKnown=true;
    if(shndx===SHN_XINDEX){
      resolvedShndx=null;sectionIdentityKnown=false;
      const xoff=xindexValid?safeOffset(xindex.offset+BigInt(i*4)):null;
      if(xoff==null||xoff+4>r.length||BigInt((i+1)*4)>xindex.size){image.warnings.push(`ELF symbol ${i} uses SHN_XINDEX without a valid SHT_SYMTAB_SHNDX entry`);}
      else{const candidate=r.u32(xoff);if(candidate===SHN_UNDEF||candidate===SHN_ABS||candidate===SHN_COMMON||candidate<sections.length){resolvedShndx=candidate;sectionIdentityKnown=true;}else image.warnings.push(`ELF symbol ${i} has out-of-range extended section index ${candidate}`);}
    }
    const normal=sectionIdentityKnown&&normalSectionIndex(resolvedShndx,sections);
    const specialKnown=resolvedShndx===SHN_UNDEF||resolvedShndx===SHN_ABS||resolvedShndx===SHN_COMMON;
    if(sectionIdentityKnown&&!normal&&!specialKnown){sectionIdentityKnown=false;image.warnings.push(`ELF symbol ${i} uses unsupported reserved section index ${resolvedShndx}`);}
    const defined=sectionIdentityKnown?(resolvedShndx!==SHN_UNDEF):null;
    const address=sectionIdentityKnown?symbolAddressForELF(elfType,value,resolvedShndx,sections):null;
    const binding=bind===0?'local':bind===1?'global':bind===2?'weak':`bind-${bind}`;
    const kind=type===2?'function':type===1?'object':type===3?'section':type===6?'tls':`type-${type}`;
    const sym={name,address:address??0n,originalValue:value,size,kind,binding,defined,sectionIndex:sectionIdentityKnown?resolvedShndx:null,visibility:other&3,source:table.type===SHT_DYNSYM?'dynsym':'symtab',index:i,tableIndex:table.index,
      sectionRelative:elfType===ET_REL&&normal?{sectionIndex:resolvedShndx,offset:value}:null,addressDomain:elfType===ET_REL&&normal?'section-relative-synthetic':'virtual'};
    image.symbols.push(sym);
    if(defined===false&&(bind===1||bind===2)){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:160},'symbol-import'))break;image.imports.push({name,library:null,ordinal:null,weak:bind===2,symbolIndex:i,tableIndex:table.index,source:'elf-dynsym',sites:[]});}
    if(defined===true&&address!=null&&(bind===1||bind===2)&&(sym.visibility===0||sym.visibility===3)){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:144},'symbol-export'))break;image.exports.push({name,address,kind,symbolIndex:i,tableIndex:table.index,source:sym.source});}
    if(defined===true&&type===2&&address!=null&&address!==0n){
      const owner=executableELFRange(image,address,size||0n,normal?resolvedShndx:null);
      if(owner){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:128},'symbol-function'))break;image.functions.push(functionSeed(address,{size:size||null,name,source:'symbol',confidence:0.995,exactFunctionStart:true,functionStartEvidence:elfType===ET_REL?'ELF ET_REL STT_FUNC with validated executable section-relative extent':'ELF STT_FUNC with validated executable section extent'}));}
      else image.warnings.push(`Ignored ELF STT_FUNC ${name} outside its canonical executable extent`);
    }
  }
}
'''
p.write_text(s[:a]+new_symbols+s[b:])

p=Path('js/binary/elf.js'); s=p.read_text(); a=s.index('function parseRelocations('); b=s.index('\nfunction parseDynamic(',a)
new_reloc=r'''function parseRelocations(r, sec, sections, image, bits, elfType, budget) {
  if(!sec.entsize)return;
  const minEnt=BigInt(bits===64?(sec.type===SHT_RELA?24:16):(sec.type===SHT_RELA?12:8));
  if(sec.entsize<minEnt){budget.partial(`relocations:${sec.index}:entry-size`,`ELF relocation section ${sec.index} entry size ${sec.entsize} is smaller than ${minEnt}`);return;}
  const tableStart=safeOffset(sec.offset),ent=safeOffset(sec.entsize);if(tableStart==null||ent==null||tableStart>r.length){budget.partial(`relocations:${sec.index}:file-span`,`ELF relocation section ${sec.index} has an invalid file span`);return;}
  const declaredBig=sec.size/sec.entsize,fileCapacity=Math.floor((r.length-tableStart)/ent),declared=declaredBig>BigInt(Number.MAX_SAFE_INTEGER)?Number.MAX_SAFE_INTEGER:Number(declaredBig),count=Math.min(declared,fileCapacity);
  if(declaredBig>BigInt(fileCapacity))budget.partial(`relocations:${sec.index}:truncated`,`ELF relocation section ${sec.index} exceeds its file-backed capacity`);
  const symbols=image.symbols.filter((x)=>x.tableIndex===sec.link);
  if(!budget.take({objects:symbols.length,operations:symbols.length,estimatedHeapBytes:symbols.length*48},'relocation-symbol-index'))return;
  const byIndex=new Map(symbols.map((x)=>[x.index,x]));
  const target=elfType===ET_REL?sections[sec.info]:null;
  if(elfType===ET_REL&&!normalSectionIndex(sec.info,sections)){budget.partial(`relocations:${sec.index}:target-section`,`ELF ET_REL relocation section ${sec.index} has invalid sh_info target section ${sec.info}`);return;}
  for(let i=0;i<count;i++){
    if(!budget.take({inputBytes:ent,records:1,objects:1,operations:2,estimatedHeapBytes:144},`relocations-${sec.index}`))break;
    const p=tableStart+i*ent;let offset,addend=null,symIndex,type;
    if(bits===64){offset=r.u64(p);const info=r.u64(p+8);symIndex=Number(info>>32n);type=Number(info&0xffffffffn);if(sec.type===SHT_RELA)addend=r.i64(p+16);}
    else{offset=BigInt(r.u32(p));const raw=r.u32(p+4);symIndex=raw>>>8;type=raw&0xff;if(sec.type===SHT_RELA)addend=BigInt(r.i32(p+8));}
    let address=offset,fileOffset=image.addressToOffset(offset),addressDomain='virtual';
    if(elfType===ET_REL){
      if(offset>=target.size){budget.partial(`relocations:${sec.index}:offset-range`,`ELF ET_REL relocation offset ${offset} is outside target section ${target.index}`);continue;}
      address=(target.syntheticAddr??0n)+offset;addressDomain='section-relative-synthetic';fileOffset=target.type===8||offset>=target.size?null:target.offset+offset;
    }
    const sym=byIndex.get(symIndex)||null;
    image.relocations.push({address,fileOffset,type,symbol:sym?sym.name:null,symbolIndex:symIndex,addend,section:sec.name,source:sec.type===SHT_RELA?'RELA':'REL',sectionRelative:elfType===ET_REL?{sectionIndex:sec.info,offset}:null,addressDomain});
    if(sym&&sym.defined===false){const imp=image.imports.find((x)=>x.name===sym.name&&x.library==null);if(imp){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:96},'relocation-import-site'))break;imp.sites.push({address,offset:fileOffset,kind:'relocation',type,sectionRelative:elfType===ET_REL?{sectionIndex:sec.info,offset}:null});}}
  }
}
'''
p.write_text(s[:a]+new_reloc+s[b:])

p=Path('js/binary/elf.js'); s=p.read_text(); a=s.index('function parseDynamic('); b=s.index('\nfunction findImageBase',a)
new_dyn=r'''function parseDynamic(r, sec, sections, image, bits, budget) {
  const str=sections[sec.link];if(!str||str.type!==SHT_STRTAB)return;const ent=Number(sec.entsize||(bits===64?16n:8n));if(!ent)return;
  const start=safeOffset(sec.offset),strStart=safeOffset(str.offset),strSize=safeOffset(str.size);if(start==null||strStart==null||strSize==null||start>r.length||strStart>r.length||strSize>r.length-strStart){budget.partial(`dynamic-section:${sec.index}:span`,`ELF SHT_DYNAMIC/string table exceeds the file`);return;}
  const fileCapacity=Math.floor((r.length-start)/ent),declared=Math.floor(Number(sec.size)/ent),count=Math.min(declared,fileCapacity);
  if(declared>fileCapacity)budget.partial(`dynamic-section:${sec.index}:truncated`,`ELF SHT_DYNAMIC exceeds its file-backed capacity`);
  for(let i=0;i<count;i++){
    if(!budget.take({inputBytes:ent,records:1,operations:1,estimatedHeapBytes:32},'SHT_DYNAMIC'))break;
    const p=start+i*ent,tag=bits===64?r.i64(p):BigInt(r.i32(p)),val=bits===64?r.u64(p+8):BigInt(r.u32(p+4));if(tag===0n)break;
    if((tag===1n||tag===14n)&&val<str.size){const off=Number(val),max=Math.min(strSize-off,1<<20,Math.max(1,Math.floor(budget.remainingStringBytes/2)+1)),name=r.cstring(strStart+off,max);if(name&&!budget.take({inputBytes:Math.min(max,name.length+1),stringBytes:name.length*2,estimatedHeapBytes:name.length*2+32},'SHT_DYNAMIC-string'))break;if(tag===1n&&name)image.libraries.push(name);else if(tag===14n&&name)image.metadata.soname=name;}
  }
}
'''
p.write_text(s[:a]+new_dyn+s[b:])

p=Path('js/binary/elf-unwind.js'); s=p.read_text()
s=s.replace('export function parseEhFrameHeader(r, sec, image, bits) {','export function parseEhFrameHeader(r, sec, image, bits, budget = null) {',1)
s=s.replace("    const count = Number(countX.raw);\n    if (!Number.isSafeInteger(count) || count < 0 || count > 10000000) return;", "    const count = Number(countX.raw);\n    if (!Number.isSafeInteger(count) || count < 0) return;",1)
old="""    for (let i = 0; i < count && p < end; i++) {
      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (image.sectionAt(initial.value)?.perms.execute || image.segmentAt(initial.value)?.perms.execute) {
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
      }
      void fde;
    }"""
new="""    for (let i = 0; i < count && p < end; i++) {
      if (budget && !budget.take({ records:1, operations:2, inputBytes:2, estimatedHeapBytes:32 }, 'eh-frame-table')) break;
      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (image.sectionAt(initial.value)?.perms.execute || image.segmentAt(initial.value)?.perms.execute) {
        if (budget && !budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'eh-frame-function')) break;
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
      }
      void fde;
    }"""
if old not in s: raise SystemExit('eh frame loop anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/binary/elf-dynamic.js'); s=p.read_text()
s=s.replace("import { collectAndroidPackedRelocations, collectRelrRelocations, parseDynamicSymbolVersions } from './elf-extended.js';", "import { collectAndroidPackedRelocations, collectRelrRelocations, parseDynamicSymbolVersions } from './elf-extended.js';\nimport { mappedELFFileRangeForVa, mappedELFFileSpanForVa } from './elf-mapping.js';",1)
old="""  const strOff = strtab == null ? null : vaToOffset(image, strtab);
  const strSize = strsz == null ? 0 : toSafeNumber(strsz);

  const stringAt = (offset) => {
    if (strOff == null || strSize == null) return '';
    const n = Number(offset);
    if (!Number.isSafeInteger(n) || n < 0 || n >= strSize || strOff + n >= r.length) return '';
    return r.cstring(strOff + n, Math.min(strSize - n, r.length - strOff - n, 1 << 20));
  };"""
new="""  const strSize = strsz == null ? 0 : toSafeNumber(strsz);
  const strSpan = strtab == null || strSize == null ? null : mappedELFFileSpanForVa(image, strtab, strSize);
  if (strtab != null && strSize > 0 && !strSpan) markDynamicPartial(image, 'DT_STRTAB/DT_STRSZ crosses a file-backed PT_LOAD boundary');
  const strOff = strSpan?.start ?? null;

  const stringAt = (offset) => {
    if (strOff == null || strSize == null || !strSpan) return '';
    const n = Number(offset);
    if (!Number.isSafeInteger(n) || n < 0 || n >= strSize || strOff + n >= strSpan.spanEnd) return '';
    return r.cstring(strOff + n, Math.min(strSize - n, strSpan.spanEnd - strOff - n, 1 << 20));
  };"""
if old not in s: raise SystemExit('dynamic strtab anchor missing')
s=s.replace(old,new,1)
s=s.replace("""  const off = vaToOffset(image, symtabVa);
  const ent = toSafeNumber(syment);
  if (off == null || ent == null || ent <= 0) return [];
  const max = Math.min(count, Math.floor((r.length - off) / ent));""", """  const ent = toSafeNumber(syment);
  if (ent == null || ent <= 0) return [];
  const requested = count * ent;
  const span = Number.isSafeInteger(requested) ? mappedELFFileSpanForVa(image, symtabVa, requested) : null;
  if (!span) { markDynamicPartial(image, 'DT_SYMTAB records cross a file-backed PT_LOAD boundary'); return []; }
  const off = span.start;
  const max = count;""",1)
old="""      const section = typeof image.sectionAt === 'function' ? image.sectionAt(value) : null;
      const segment = typeof image.segmentAt === 'function' ? image.segmentAt(value) : null;
      const exactFunctionStart = !!(section || segment)?.perms?.execute;
      image.functions.push(functionSeed(value, {
        size: size || null, name, source: 'symbol', confidence: exactFunctionStart ? 0.995 : 0.8,
        exactFunctionStart, functionStartEvidence: exactFunctionStart ? 'ELF STT_FUNC in validated executable mapping' : null,
      }));"""
new="""      const owner = (() => {
        const start=value, extent=size||0n;
        const section=typeof image.sectionAt==='function'?image.sectionAt(start):null;
        if(section?.perms?.execute && (extent===0n || extent<=section.address+section.size-start))return section;
        const segment=typeof image.segmentAt==='function'?image.segmentAt(start):null;
        if(segment?.perms?.execute && (extent===0n || extent<=segment.address+segment.size-start))return segment;
        return null;
      })();
      if (owner) image.functions.push(functionSeed(value, {
        size: size || null, name, source: 'symbol', confidence: 0.995,
        exactFunctionStart: true, functionStartEvidence: 'ELF PT_DYNAMIC STT_FUNC in validated executable mapping and extent',
      }));
      else markDynamicPartial(image, `ignored PT_DYNAMIC STT_FUNC ${name} outside executable mapping/extent`);"""
if old not in s: raise SystemExit('dynamic STT_FUNC anchor missing')
s=s.replace(old,new,1)
old="""    const off = vaToOffset(image, va);
    const n = toSafeNumber(size);
    const minimum = BigInt(bits === 64 ? (rela ? 24 : 16) : (rela ? 12 : 8));
    const requested = ent ?? minimum;
    if (requested < minimum) { markDynamicPartial(image, `${source} entry size ${requested} is smaller than ${minimum}`); return; }
    const e = toSafeNumber(requested);
    if (off == null || n == null || e == null || e <= 0 || off + n > r.length) return;"""
new="""    const n = toSafeNumber(size);
    const minimum = BigInt(bits === 64 ? (rela ? 24 : 16) : (rela ? 12 : 8));
    const requested = ent ?? minimum;
    if (requested < minimum) { markDynamicPartial(image, `${source} entry size ${requested} is smaller than ${minimum}`); return; }
    const e = toSafeNumber(requested);
    const span = n == null ? null : mappedELFFileSpanForVa(image, va, n);
    if (!span || e == null || e <= 0) { markDynamicPartial(image, `${source} table crosses a file-backed PT_LOAD boundary`); return; }
    const off = span.start;"""
if old not in s: raise SystemExit('dynamic relocation span anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/binary/elf-dynamic.js'); s=p.read_text(); a=s.index('export function dynamicSymbolFileCapacity'); b=s.index('\nfunction symbolCountFromHash',a)
new_capacity=r'''export function dynamicSymbolFileCapacity(r, image, tags, symtabVa, syment) {
  const range=mappedELFFileRangeForVa(image,symtabVa),ent=toSafeNumber(syment);if(!range||ent==null||ent<=0)return 0;
  let end=range.end;
  const pointerTags=[4n,5n,7n,17n,23n,36n,0x6000000fn,0x60000011n,0x6ffffef5n,0x6ffffff0n,0x6ffffffcn,0x6ffffffen];
  for(const tag of pointerTags)for(const va of tags.get(tag)||[]){if(va===symtabVa)continue;const candidate=mappedELFFileRangeForVa(image,va);if(candidate&&candidate.segment===range.segment&&candidate.start>range.start&&candidate.start<end)end=candidate.start;}
  return Math.max(0,Math.floor((end-range.start)/ent));
}
'''
s=s[:a]+new_capacity+s[b:]
a=s.index('function symbolCountFromHash'); b=s.index('\nfunction symbolCountFromGnuHash',a)
new_hash=r'''function symbolCountFromHash(r, hashVa, image) {
  if(hashVa==null)return 0;const range=mappedELFFileRangeForVa(image,hashVa);if(!range||range.start+8>range.end)return 0;
  const nbucket=r.u32(range.start),nchain=r.u32(range.start+4);if(!nchain||nchain>10_000_000)return 0;
  const bytes=8n+BigInt(nbucket+nchain)*4n;if(bytes>BigInt(range.end-range.start)){markDynamicPartial(image,'DT_HASH table crosses a file-backed PT_LOAD boundary');return 0;}return nchain;
}
'''
s=s[:a]+new_hash+s[b:]
a=s.index('function symbolCountFromGnuHash'); b=s.index('\nfunction symbolCountFromRelocations',a)
new_gnu=r'''function symbolCountFromGnuHash(r, hashVa, image, bits) {
  if(hashVa==null)return 0;const range=mappedELFFileRangeForVa(image,hashVa);if(!range||range.start+16>range.end)return 0;const off=range.start;
  const nbuckets=r.u32(off),symOffset=r.u32(off+4),bloomSize=r.u32(off+8);if(!nbuckets||nbuckets>10_000_000||bloomSize>10_000_000)return 0;const word=bits===64?8:4;
  const bucketsOff=off+16+bloomSize*word,chainsOff=bucketsOff+nbuckets*4;if(!Number.isSafeInteger(bucketsOff)||!Number.isSafeInteger(chainsOff)||chainsOff>range.end){markDynamicPartial(image,'DT_GNU_HASH header/buckets cross a file-backed PT_LOAD boundary');return 0;}
  let max=symOffset,remainingSteps=Math.min(10_000_000,Math.max(4096,nbuckets*64));
  for(let i=0;i<nbuckets;i++){const bucket=r.u32(bucketsOff+i*4);if(!bucket||bucket<symOffset)continue;let idx=bucket,p=chainsOff+(idx-symOffset)*4;for(;p+4<=range.end;idx++,p+=4){if(--remainingSteps<0){markDynamicPartial(image,'GNU hash chain traversal exceeded the global budget');return 0;}const chain=r.u32(p);if(idx>max)max=idx;if(chain&1)break;}if(p+4>range.end){markDynamicPartial(image,'DT_GNU_HASH chain crosses a file-backed PT_LOAD boundary');return 0;}}
  return max>=symOffset?max+1:0;
}
'''
s=s[:a]+new_gnu+s[b:]
old="""  const symOff = vaToOffset(image, symtab), strOff = vaToOffset(image, strtab);
  if (symOff == null || strOff == null || strOff <= symOff || strOff > r.length) return 0;
  if (BigInt(strOff - symOff) !== delta) return 0;"""
new="""  const symRange=mappedELFFileRangeForVa(image,symtab),strRange=mappedELFFileRangeForVa(image,strtab);
  const symOff=symRange?.start??null,strOff=strRange?.start??null;
  if(symOff==null||strOff==null||symRange.segment!==strRange.segment||strOff<=symOff||strOff>symRange.end)return 0;
  if(BigInt(strOff-symOff)!==delta)return 0;"""
if old not in s: raise SystemExit('dynamic layout anchor missing')
s=s.replace(old,new,1)
old="""function vaToOffset(image, va) {
  const off = image.addressToOffset(va);
  return off == null ? null : toSafeNumber(off);
}"""
new="""function vaToOffset(image, va) {
  return mappedELFFileRangeForVa(image,va)?.start ?? null;
}"""
if old not in s: raise SystemExit('dynamic vaToOffset anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/binary/elf-extended.js'); s=p.read_text()
s=s.replace("import { createDynamicSymbolBudget } from './dynamic-symbol-budget.js';", "import { createDynamicSymbolBudget } from './dynamic-symbol-budget.js';\nimport { mappedELFFileRangeForVa, mappedELFFileSpanForVa } from './elf-mapping.js';",1)
s=s.replace("function vaToOffset(image, va) { const off=image.addressToOffset(va); return off == null ? null : safe(off); }", "function vaToOffset(image, va) { return mappedELFFileRangeForVa(image,va)?.start ?? null; }",1)
old="""  const off=vaToOffset(image,va), size=safe(size64);
  if (off==null||size==null||off+size>r.length) { partial(image,'DT_RELR table is outside the file'); return out; }"""
new="""  const size=safe(size64), span=size==null?null:mappedELFFileSpanForVa(image,va,size), off=span?.start??null;
  if(off==null||size==null){partial(image,'DT_RELR table crosses a file-backed PT_LOAD boundary');return out;}"""
if old not in s: raise SystemExit('RELR span anchor missing')
s=s.replace(old,new,1)
old="""  const off=vaToOffset(image,va), size=safe(size64);
  if(off==null||size==null||off+size>r.length){partial(image,`${source} table is outside the file`);return out;}"""
new="""  const size=safe(size64), span=size==null?null:mappedELFFileSpanForVa(image,va,size), off=span?.start??null;
  if(off==null||size==null){partial(image,`${source} table crosses a file-backed PT_LOAD boundary`);return out;}"""
if old not in s: raise SystemExit('Android relocation span anchor missing')
s=s.replace(old,new,1)
a=s.index('export function parseDynamicSymbolVersions'); b=len(s)
new_versions=r'''export function parseDynamicSymbolVersions(r,tags,image,symbolCount,stringAt,context=null){
  const out=new Map(),versym=one(tags,DT_VERSYM);if(versym==null||symbolCount<=0)return out;const budget=symbolBudgetContext(image,context);const count=Math.min(symbolCount,budget.limits.maxSymbolRecords);if(symbolCount>count)partial(image,`DT_VERSYM symbol count ${symbolCount} exceeds record limit ${count}; clamped`);
  const vspan=mappedELFFileSpanForVa(image,versym,count*2);if(!vspan){partial(image,'DT_VERSYM table crosses a file-backed PT_LOAD boundary');return out;}const voff=vspan.start;if(!budget.claimInput(count*2,'DT_VERSYM'))return out;const names=new Map();
  const verdef=one(tags,DT_VERDEF),verdefnum=safe(one(tags,DT_VERDEFNUM)??0n);
  if(verdef!=null&&verdefnum){const range=mappedELFFileRangeForVa(image,verdef);let p=range?.start??null;for(let i=0;p!=null&&i<Math.min(verdefnum,65536)&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERDEF decode'))break;if(p+20>range.end){partial(image,'DT_VERDEF crosses a file-backed PT_LOAD boundary');break;}if(!budget.claimInput(20,'DT_VERDEF'))break;const ndx=r.u16(p+4)&0x7fff,aux=r.u32(p+12),next=r.u32(p+16),ap=p+aux;
    if(ap<p||ap+8>range.end){partial(image,'DT_VERDEF auxiliary entry crosses a file-backed PT_LOAD boundary');break;}if(!budget.claimInput(8,'DT_VERDEF auxiliary'))break;const name=stringAt(BigInt(r.u32(ap)));if(name){if(!budget.claimOutput(1,96,'DT_VERDEF names'))break;names.set(ndx,{name,definition:true,library:null});}if(!next)break;if(next<20||p+next<=p||p+next>range.end){partial(image,'DT_VERDEF next pointer leaves its mapped table');break;}p+=next;
  }}
  const verneed=one(tags,DT_VERNEED),verneednum=safe(one(tags,DT_VERNEEDNUM)??0n);
  if(verneed!=null&&verneednum&&!budget.stopped){const range=mappedELFFileRangeForVa(image,verneed);let p=range?.start??null;for(let i=0;p!=null&&i<Math.min(verneednum,65536)&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERNEED decode'))break;if(p+16>range.end){partial(image,'DT_VERNEED crosses a file-backed PT_LOAD boundary');break;}if(!budget.claimInput(16,'DT_VERNEED'))break;const cnt=r.u16(p+2),file=stringAt(BigInt(r.u32(p+4))),aux=r.u32(p+8),next=r.u32(p+12);let ap=p+aux;
    if(ap<p||ap>range.end){partial(image,'DT_VERNEED auxiliary pointer leaves its mapped table');break;}
    for(let j=0;j<cnt&&j<65536&&!budget.stopped;j++){
      if(!budget.step(1,'DT_VERNEED auxiliary decode'))break;if(ap+16>range.end){partial(image,'DT_VERNEED auxiliary entry crosses a file-backed PT_LOAD boundary');break;}if(!budget.claimInput(16,'DT_VERNEED auxiliary'))break;const other=r.u16(ap+6)&0x7fff,name=stringAt(BigInt(r.u32(ap+8))),anext=r.u32(ap+12);if(name){if(!budget.claimOutput(1,112,'DT_VERNEED names'))break;names.set(other,{name,definition:false,library:file||null});}if(!anext)break;if(anext<16||ap+anext<=ap||ap+anext>range.end){partial(image,'DT_VERNEED auxiliary next pointer leaves its mapped table');break;}ap+=anext;
    }
    if(!next)break;if(next<16||p+next<=p||p+next>range.end){partial(image,'DT_VERNEED next pointer leaves its mapped table');break;}p+=next;
  }}
  for(let i=0;i<count&&!budget.stopped;i++){if(!budget.step(1,'DT_VERSYM decode'))break;const raw=r.u16(voff+i*2),index=raw&0x7fff;if(index<=1)continue;if(!budget.claimOutput(1,96,'DT_VERSYM entries'))break;const named=names.get(index);out.set(i,{index,hidden:!!(raw&0x8000),name:named?.name||null,library:named?.library||null,definition:named?.definition??null});}
  image.metadata.symbolVersions={entries:out.size,named:[...out.values()].filter((v)=>v.name).length,complete:!budget.stopped&&!image.metadata.programDynamicPartial};return out;
}
'''
s=s[:a]+new_versions+'\n'
p.write_text(s)

print('applied ELF #566/#567/#568 trust-boundary fixes')
