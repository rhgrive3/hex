import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseEhFrameHeader } from './elf-unwind.js';
import { parseProgramDynamic } from './elf-dynamic.js';
import { createELFMetadataBudget } from './elf-budget.js';
import { executableELFRange } from './elf-mapping.js';
import { parseRiscvAttributes, parseRiscvMappingSymbol } from './riscv-isa.js';

const ET_REL = 1;
const PT_LOAD = 1;
const PT_GNU_EH_FRAME = 0x6474e550;
const PN_XNUM = 0xffff;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_DYNSYM = 11;
const SHT_REL = 9;
const SHT_SYMTAB_SHNDX = 18;
const SHN_UNDEF = 0;
const SHN_LORESERVE = 0xff00;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;
const SHN_XINDEX = 0xffff;
const STT_GNU_IFUNC = 10;
const SHF_WRITE = 0x1n;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const EM_RISCV = 243;
export const STO_RISCV_VARIANT_CC = 0x80;

export function parseELF(input, options = {}) {
  const initial = new ByteView(input, { littleEndian: true });
  const bytes = initial.bytes;
  if (initial.length < 16 || initial.u8(0) !== 0x7f || initial.u8(1) !== 0x45 || initial.u8(2) !== 0x4c || initial.u8(3) !== 0x46) throw new Error('not an ELF file');
  const cls = initial.u8(4);
  const data = initial.u8(5);
  if (cls !== 1 && cls !== 2) throw new Error(`unsupported ELF class ${cls}`);
  if (data !== 1 && data !== 2) throw new Error(`unsupported ELF data encoding ${data}`);
  const bits = cls === 2 ? 64 : 32;
  const littleEndian = data === 1;
  const r = new ByteView(bytes, { littleEndian });
  const h = readHeader(r, bits);
  validateHeaderTableSizes(r, h, bits);
  resolveExtendedProgramHeaderCount(r, h, bits);
  const image = new BinaryImage(bytes, {
    format: 'elf', arch: elfMachineName(h.machine, bits), bits,
    endian: littleEndian ? 'little' : 'big', platform: elfOsAbi(r.u8(7)),
    entrypoint: h.entry, imageBase: 0n,
    metadata: { type: h.type, machine: h.machine, flags: h.flags, osabi: r.u8(7), abiVersion: r.u8(8), extendedProgramHeaderCount: h.extendedPhnum ?? null },
  });

  const programHeaders = parseProgramHeaders(r, h, image, bits);
  const rawSections = parseSectionHeaders(r, h, bits, image);
  nameSections(r, rawSections, h);
  let riscvFileIsa = null;
  if (image.arch === 'riscv64') {
    const attributes = rawSections.find((section) => section.name === '.riscv.attributes') || null;
    if (attributes) {
      const start = safeOffset(attributes.offset), size = safeOffset(attributes.size);
      if (start == null || size == null || size > 1024 * 1024 || start > r.length || size > r.length - start) {
        image.warnings.push('RISC-V attributes section is outside the bounded file span');
      } else {
        riscvFileIsa = parseRiscvAttributes(r.bytes.subarray(start, start + size), { littleEndian });
        if (!riscvFileIsa) image.warnings.push('RISC-V Tag_RISCV_arch is missing or malformed');
      }
    }
  }
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
  if (h.type !== ET_REL && image.entrypoint != null) {
    const zeroResetVector = image.entrypoint === 0n && image.arch === 'arm64' && !!image.segmentAt(0n)?.perms?.execute;
    if (image.entrypoint !== 0n || zeroResetVector) {
      image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));
      if (zeroResetVector) image.metadata.entrypointZeroEvidence = 'aarch64-executable-pt-load-at-zero';
    } else {
      image.metadata.entrypointZeroEvidence = 'zero-sentinel-unproven';
    }
  }
  const metadataBudget = createELFMetadataBudget(image, { signal: options.signal, limits: options.metadataLimits });

  const symbolTables = rawSections.filter((s) => s.type === SHT_SYMTAB || s.type === SHT_DYNSYM);
  for (const s of symbolTables) parseSymbols(r, s, rawSections, image, bits, h.type, metadataBudget);
  if (image.arch === 'riscv64') {
    const mappings = image.symbols
      .filter((symbol) => symbol?.defined === true && typeof symbol.name === 'string')
      .map((symbol) => {
        const parsed = parseRiscvMappingSymbol(symbol.name);
        return parsed ? { address:symbol.address, sectionIndex:symbol.sectionIndex, ...parsed } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
    const sections = rawSections
      .filter((section) => (section.flags & SHF_EXECINSTR) !== 0n && section.size > 0n)
      .map((section) => ({
        sectionIndex:section.index,
        start:h.type === ET_REL ? (section.syntheticAddr ?? 0n) : section.addr,
        end:(h.type === ET_REL ? (section.syntheticAddr ?? 0n) : section.addr) + section.size,
      }));
    image.metadata.riscvIsa = {
      file:riscvFileIsa,
      mappings,
      sections,
      evidence:riscvFileIsa ? 'elf-attribute' : 'missing',
    };
  }
  for (const s of rawSections) {
    if (s.type === SHT_REL || s.type === SHT_RELA) parseRelocations(r, s, rawSections, image, bits, h.type, metadataBudget);
    else if (s.type === SHT_DYNAMIC) parseDynamic(r, s, rawSections, image, bits, metadataBudget);
  }
  const hasDynsym = rawSections.some((s) => s.type === SHT_DYNSYM);
  const hasRelocations = rawSections.some((s) => s.type === SHT_REL || s.type === SHT_RELA);
  const hasDynamic = rawSections.some((s) => s.type === SHT_DYNAMIC);
  parseProgramDynamic(r, programHeaders, image, bits, {
    symbols: !hasDynsym,
    relocations: !hasRelocations,
    sectionDynamicPresent: hasDynamic,
  });
  let ehFrameHdr = rawSections.find((s) => s.name === '.eh_frame_hdr') || null;
  if (!ehFrameHdr) {
    const ph = programHeaders.find((item) => item.type === PT_GNU_EH_FRAME && item.filesz > 0n);
    if (ph) ehFrameHdr = { name: 'PT_GNU_EH_FRAME', addr: ph.vaddr, offset: ph.offset, size: ph.filesz };
  }
  if (ehFrameHdr) parseEhFrameHeader(r, ehFrameHdr, image, bits, metadataBudget);
  image.metadata.elfMetadata = metadataBudget.snapshot();

  return image.finalize();
}

function alignUp(value, alignment) {
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

function readHeader(r, bits) {
  if (bits === 64) {
    r.check(0, 64);
    return {
      type: r.u16(16), machine: r.u16(18), version: r.u32(20), entry: r.u64(24),
      phoff: r.u64(32), shoff: r.u64(40), flags: r.u32(48), ehsize: r.u16(52),
      phentsize: r.u16(54), phnum: r.u16(56), shentsize: r.u16(58), shnum: r.u16(60), shstrndx: r.u16(62),
    };
  }
  r.check(0, 52);
  return {
    type: r.u16(16), machine: r.u16(18), version: r.u32(20), entry: BigInt(r.u32(24)),
    phoff: BigInt(r.u32(28)), shoff: BigInt(r.u32(32)), flags: r.u32(36), ehsize: r.u16(40),
    phentsize: r.u16(42), phnum: r.u16(44), shentsize: r.u16(46), shnum: r.u16(48), shstrndx: r.u16(50),
  };
}

function validateHeaderTableSizes(r, h, bits) {
  const minHeader = bits === 64 ? 64 : 52;
  const minProgram = bits === 64 ? 56 : 32;
  const minSection = bits === 64 ? 64 : 40;
  if (h.ehsize < minHeader) throw new Error(`ELF e_ehsize ${h.ehsize} is smaller than ${minHeader}`);
  if (h.phoff !== 0n && h.phnum !== 0 && h.phentsize < minProgram) throw new Error(`ELF e_phentsize ${h.phentsize} is smaller than ${minProgram}`);
  if (h.shoff !== 0n && h.shentsize < minSection) throw new Error(`ELF e_shentsize ${h.shentsize} is smaller than ${minSection}`);
  if (h.phnum === PN_XNUM && h.shoff === 0n) throw new Error('ELF PN_XNUM requires section header 0');
  void r;
}

function resolveExtendedProgramHeaderCount(r, h, bits) {
  if (h.phnum !== PN_XNUM) return;
  const off = safeOffset(h.shoff);
  const minSection = bits === 64 ? 64 : 40;
  if (off == null || off <= 0 || off + minSection > r.length) throw new Error('ELF PN_XNUM section header 0 is truncated');
  const actual = r.u32(off + (bits === 64 ? 44 : 28));
  if (actual > 1_000_000) throw new Error(`invalid ELF extended program header count ${actual}`);
  h.extendedPhnum = actual;
  h.phnum = actual;
}

function parseProgramHeaders(r, h, image, bits) {
  const out = [];
  const off = safeOffset(h.phoff);
  if (off == null) { image.warnings.push('ELF program header offset is not safely representable'); return out; }
  if (!h.phnum || !h.phentsize || off <= 0) return out;
  if (off + h.phnum * h.phentsize > r.length) { image.warnings.push('ELF program header table is truncated'); return out; }
  for (let i = 0; i < h.phnum; i++) {
    const p = off + i * h.phentsize;
    let ph;
    if (bits === 64) {
      ph = { type: r.u32(p), flags: r.u32(p + 4), offset: r.u64(p + 8), vaddr: r.u64(p + 16), filesz: r.u64(p + 32), memsz: r.u64(p + 40), align: r.u64(p + 48) };
    } else {
      ph = { type: r.u32(p), offset: BigInt(r.u32(p + 4)), vaddr: BigInt(r.u32(p + 8)), filesz: BigInt(r.u32(p + 16)), memsz: BigInt(r.u32(p + 20)), flags: r.u32(p + 24), align: BigInt(r.u32(p + 28)) };
    }
    if (ph.type === PT_LOAD) {
      const fileLength = BigInt(r.length);
      const invalidSize = ph.filesz > ph.memsz;
      const invalidRange = ph.offset > fileLength || ph.filesz > fileLength - ph.offset;
      if (invalidSize || invalidRange) {
        image.warnings.push(`invalid ELF PT_LOAD ${i}: ${invalidSize ? 'p_filesz > p_memsz' : 'file range exceeds input'}`);
        continue;
      }
    }
    out.push(ph);
    if (ph.type === PT_LOAD) {
      image.addSegment({
        name: `LOAD${i}`, address: ph.vaddr, size: ph.memsz, fileOffset: ph.offset, fileSize: ph.filesz,
        perms: { read: !!(ph.flags & 4), write: !!(ph.flags & 2), execute: !!(ph.flags & 1) }, flags: ph.flags, source: 'PT_LOAD',
      });
    }
  }
  return out;
}

function parseSectionHeaders(r, h, bits, image) {
  const off = safeOffset(h.shoff);
  let count = h.shnum;
  if (off == null) { image.warnings.push('ELF section header offset is not safely representable'); return []; }
  if (!off || !h.shentsize) return [];
  if (off + h.shentsize > r.length) { image.warnings.push('ELF section header table is truncated'); return []; }
  if (count === 0) count = bits === 64 ? Number(r.u64(off + 32)) : r.u32(off + 20);
  if (count > 100000 || off + count * h.shentsize > r.length) { image.warnings.push(`invalid ELF section count ${count}`); return []; }
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = off + i * h.shentsize;
    if (bits === 64) {
      out.push({ index: i, nameOffset: r.u32(p), type: r.u32(p + 4), flags: r.u64(p + 8), addr: r.u64(p + 16), offset: r.u64(p + 24), size: r.u64(p + 32), link: r.u32(p + 40), info: r.u32(p + 44), addralign: r.u64(p + 48), entsize: r.u64(p + 56), name: '' });
    } else {
      out.push({ index: i, nameOffset: r.u32(p), type: r.u32(p + 4), flags: BigInt(r.u32(p + 8)), addr: BigInt(r.u32(p + 12)), offset: BigInt(r.u32(p + 16)), size: BigInt(r.u32(p + 20)), link: r.u32(p + 24), info: r.u32(p + 28), addralign: BigInt(r.u32(p + 32)), entsize: BigInt(r.u32(p + 36)), name: '' });
    }
  }
  if (h.shstrndx === 0xffff && out[0]) h.shstrndx = out[0].link;
  return out;
}

function nameSections(r, sections, h) {
  const str = sections[h.shstrndx];
  if (!str || str.type !== SHT_STRTAB || str.offset + str.size > BigInt(r.length)) return;
  for (const s of sections) {
    if (BigInt(s.nameOffset) >= str.size) continue;
    try { s.name = r.cstring(Number(str.offset) + s.nameOffset, Number(str.size) - s.nameOffset); }
    catch (error) {
      if (error?.code === 'BINARY_SOURCE_RANGE_MISSING') throw error;
      s.name = '';
    }
  }
}

function parseSymbols(r, table, sections, image, bits, elfType, budget) {
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
    const kind=type===2?'function':type===1?'object':type===3?'section':type===6?'tls':type===STT_GNU_IFUNC?'indirect-function':`type-${type}`;
    const ifunc=type===STT_GNU_IFUNC&&defined===true;
    const riscvVariantCc=image.metadata.machine===EM_RISCV&&type===2&&(other&STO_RISCV_VARIANT_CC)!==0;
    const sym={name,address:address??0n,originalValue:value,size,kind,binding,defined,sectionIndex:sectionIdentityKnown?resolvedShndx:null,visibility:other&3,stOther:other,processorSpecificOther:other&~3,riscvVariantCc,callingConvention:riscvVariantCc?'riscv-vector-variant':null,source:table.type===SHT_DYNSYM?'dynsym':'symtab',index:i,tableIndex:table.index,...(ifunc?{resolverAddress:address??value,resolution:'runtime-resolver'}:{}),
      sectionRelative:elfType===ET_REL&&normal?{sectionIndex:resolvedShndx,offset:value}:null,addressDomain:elfType===ET_REL&&normal?'section-relative-synthetic':'virtual'};
    image.symbols.push(sym);
    if(defined===false&&(bind===1||bind===2)){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:160},'symbol-import'))break;image.imports.push({name,library:null,ordinal:null,weak:bind===2,symbolIndex:i,tableIndex:table.index,source:'elf-dynsym',sites:[]});}
    if(defined===true&&address!=null&&(bind===1||bind===2)&&(sym.visibility===0||sym.visibility===3)){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:144},'symbol-export'))break;image.exports.push({name,address,kind,symbolIndex:i,tableIndex:table.index,source:sym.source});}
    if(defined===true&&(type===2||type===STT_GNU_IFUNC)&&address!=null&&address!==0n){
      const owner=executableELFRange(image,address,size||0n,normal?resolvedShndx:null);
      if(owner){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:128},'symbol-function'))break;image.functions.push(functionSeed(address,{size:size||null,name:type===STT_GNU_IFUNC?`${name}$resolver`:name,source:type===STT_GNU_IFUNC?'ifunc-resolver':'symbol',confidence:0.995,exactFunctionStart:true,functionStartEvidence:type===STT_GNU_IFUNC?'ELF STT_GNU_IFUNC resolver with validated executable section extent':elfType===ET_REL?'ELF ET_REL STT_FUNC with validated executable section-relative extent':'ELF STT_FUNC with validated executable section extent',callingConvention:riscvVariantCc?'riscv-vector-variant':null,abiMetadata:riscvVariantCc?{riscvVariantCc:true,stOther:other}:null}));if(riscvVariantCc){if(!Array.isArray(image.metadata.riscvVariantCcFunctions))image.metadata.riscvVariantCcFunctions=[];image.metadata.riscvVariantCcFunctions.push({name,address,symbolIndex:i,tableIndex:table.index,stOther:other,callingConvention:'riscv-vector-variant'});}}
      else image.warnings.push(`Ignored ELF ${type===STT_GNU_IFUNC?'STT_GNU_IFUNC resolver':'STT_FUNC'} ${name} outside its canonical executable extent`);
    }
  }
}

function parseRelocations(r, sec, sections, image, bits, elfType, budget) {
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

function parseDynamic(r, sec, sections, image, bits, budget) {
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

function findImageBase(image) {
  const loads = image.segments.filter((s) => s.address != null);
  if (!loads.length) return 0n;
  let base = loads[0].address - loads[0].fileOffset;
  for (const s of loads) {
    const b = s.address - s.fileOffset;
    if (b < base) base = b;
  }
  return base;
}

/*
 * EM_RISCV does not encode the register width: the same e_machine value is used
 * by RV32 and RV64, and only ELFCLASS separates them. Emitting a bare `riscv`
 * would create an architecture identity that no plugin, ABI, or capability
 * profile can resolve, so the width is folded in here and the canonical ids
 * `riscv32`/`riscv64` are the only ones this loader produces.
 */
function elfMachineName(m, bits) {
  if (m === 243) return bits === 64 ? 'riscv64' : 'riscv32';
  return ({ 3: 'x86', 8: 'mips', 20: 'ppc', 21: 'ppc64', 40: 'arm', 62: 'x86_64', 183: 'arm64' })[m] || `machine-${m}`;
}
function elfOsAbi(v) {
  return ({ 0: 'sysv', 1: 'hpux', 2: 'netbsd', 3: 'linux', 6: 'solaris', 9: 'freebsd', 12: 'openbsd' })[v] || `elf-osabi-${v}`;
}

function safeOffset(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
