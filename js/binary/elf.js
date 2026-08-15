import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseEhFrameHeader } from './elf-unwind.js';
import { parseProgramDynamic } from './elf-dynamic.js';

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
const SHN_XINDEX = 0xffff;
const SHF_WRITE = 0x1n;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;

export function parseELF(input) {
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
    format: 'elf', arch: elfMachineName(h.machine), bits,
    endian: littleEndian ? 'little' : 'big', platform: elfOsAbi(r.u8(7)),
    entrypoint: h.entry, imageBase: 0n,
    metadata: { type: h.type, machine: h.machine, flags: h.flags, osabi: r.u8(7), abiVersion: r.u8(8), extendedProgramHeaderCount: h.extendedPhnum ?? null },
  });

  const programHeaders = parseProgramHeaders(r, h, image, bits);
  const rawSections = parseSectionHeaders(r, h, bits, image);
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
  if (ehFrameHdr) parseEhFrameHeader(r, ehFrameHdr, image, bits);

  return image.finalize();
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

function parseSymbols(r, table, sections, image, bits) {
  const str = sections[table.link];
  if (!str || str.type !== SHT_STRTAB || !table.entsize) return;
  const minEnt = BigInt(bits === 64 ? 24 : 16);
  if (table.entsize < minEnt) { image.warnings.push(`ELF symbol table ${table.index} entry size ${table.entsize} is smaller than ${minEnt}`); return; }
  const xindex = sections.find((s) => s.type === SHT_SYMTAB_SHNDX && s.link === table.index) || null;
  const xindexValid = !!xindex && (!xindex.entsize || xindex.entsize === 4n)
    && xindex.offset <= BigInt(r.length) && xindex.size <= BigInt(r.length) - xindex.offset;
  if (xindex && !xindexValid) image.warnings.push(`ELF SHT_SYMTAB_SHNDX for table ${table.index} is malformed`);
  const count = Number(table.size / table.entsize);
  const ent = Number(table.entsize);
  if (count > 10000000 || Number(table.offset) + count * ent > r.length) return;
  for (let i = 0; i < count; i++) {
    const p = Number(table.offset) + i * ent;
    let nameOff, info, other, shndx, value, size;
    if (bits === 64) {
      nameOff = r.u32(p); info = r.u8(p + 4); other = r.u8(p + 5); shndx = r.u16(p + 6); value = r.u64(p + 8); size = r.u64(p + 16);
    } else {
      nameOff = r.u32(p); value = BigInt(r.u32(p + 4)); size = BigInt(r.u32(p + 8)); info = r.u8(p + 12); other = r.u8(p + 13); shndx = r.u16(p + 14);
    }
    if (BigInt(nameOff) >= str.size) continue;
    const name = r.cstring(Number(str.offset) + nameOff, Math.min(Number(str.size) - nameOff, 1 << 20));
    if (!name) continue;
    const bind = info >>> 4, type = info & 0xf;
    let resolvedShndx = shndx;
    let sectionIdentityKnown = true;
    if (shndx === SHN_XINDEX) {
      resolvedShndx = null;
      sectionIdentityKnown = false;
      const xoff = xindexValid ? safeOffset(xindex.offset + BigInt(i * 4)) : null;
      if (xoff == null || xoff + 4 > r.length || BigInt((i + 1) * 4) > xindex.size) {
        image.warnings.push(`ELF symbol ${i} uses SHN_XINDEX without a valid SHT_SYMTAB_SHNDX entry`);
      } else {
        const candidate = r.u32(xoff);
        if (candidate === SHN_UNDEF || candidate < sections.length) {
          resolvedShndx = candidate;
          sectionIdentityKnown = true;
        } else {
          image.warnings.push(`ELF symbol ${i} has out-of-range extended section index ${candidate}`);
        }
      }
    }
    const defined = sectionIdentityKnown ? resolvedShndx !== SHN_UNDEF : null;
    const binding = bind === 0 ? 'local' : bind === 1 ? 'global' : bind === 2 ? 'weak' : `bind-${bind}`;
    const kind = type === 2 ? 'function' : type === 1 ? 'object' : type === 3 ? 'section' : type === 6 ? 'tls' : `type-${type}`;
    const sym = { name, address: value, size, kind, binding, defined, sectionIndex: sectionIdentityKnown ? resolvedShndx : null, visibility: other & 3, source: table.type === SHT_DYNSYM ? 'dynsym' : 'symtab', index: i, tableIndex: table.index };
    image.symbols.push(sym);
    if (defined === false && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, symbolIndex: i, tableIndex: table.index, source: 'elf-dynsym', sites: [] });
    if (defined === true && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) image.exports.push({ name, address: value, kind, symbolIndex: i, tableIndex: table.index, source: sym.source });
    if (defined === true && type === 2 && value !== 0n) {
      const section = Number.isInteger(resolvedShndx) ? sections[resolvedShndx] : null;
      if (section && !!(section.flags & SHF_EXECINSTR)) image.functions.push(functionSeed(value, {
        size: size || null, name, source: 'symbol', confidence: 0.995, exactFunctionStart: true,
        functionStartEvidence: 'ELF STT_FUNC with validated executable section identity',
      }));
    }
  }
}

function parseRelocations(r, sec, sections, image, bits) {
  if (!sec.entsize) return;
  const minEnt = BigInt(bits === 64 ? (sec.type === SHT_RELA ? 24 : 16) : (sec.type === SHT_RELA ? 12 : 8));
  if (sec.entsize < minEnt) { image.warnings.push(`ELF relocation section ${sec.index} entry size ${sec.entsize} is smaller than ${minEnt}`); return; }
  const symbols = image.symbols.filter((s) => s.tableIndex === sec.link);
  const byIndex = new Map(symbols.map((s) => [s.index, s]));
  const count = Number(sec.size / sec.entsize);
  const ent = Number(sec.entsize);
  if (count > 10000000 || Number(sec.offset) + count * ent > r.length) return;
  for (let i = 0; i < count; i++) {
    const p = Number(sec.offset) + i * ent;
    let offset, addend = null, symIndex, type;
    if (bits === 64) {
      offset = r.u64(p); const info = r.u64(p + 8); symIndex = Number(info >> 32n); type = Number(info & 0xffffffffn);
      if (sec.type === SHT_RELA) addend = r.i64(p + 16);
    } else {
      offset = BigInt(r.u32(p)); const raw = r.u32(p + 4); symIndex = raw >>> 8; type = raw & 0xff;
      if (sec.type === SHT_RELA) addend = BigInt(r.i32(p + 8));
    }
    const sym = byIndex.get(symIndex) || null;
    image.relocations.push({ address: offset, fileOffset: image.addressToOffset(offset), type, symbol: sym ? sym.name : null, symbolIndex: symIndex, addend, section: sec.name, source: sec.type === SHT_RELA ? 'RELA' : 'REL' });
    if (sym && !sym.defined) {
      const imp = image.imports.find((x) => x.name === sym.name && x.library == null);
      if (imp) imp.sites.push({ address: offset, offset: image.addressToOffset(offset), kind: 'relocation', type });
    }
  }
}

function parseDynamic(r, sec, sections, image, bits) {
  const str = sections[sec.link];
  if (!str || str.type !== SHT_STRTAB) return;
  const ent = Number(sec.entsize || (bits === 64 ? 16n : 8n));
  if (!ent) return;
  const count = Math.min(Number(sec.size) / ent, 1000000);
  for (let i = 0; i < count; i++) {
    const p = Number(sec.offset) + i * ent;
    const tag = bits === 64 ? r.i64(p) : BigInt(r.i32(p));
    const val = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4));
    if (tag === 0n) break;
    if (tag === 1n && val < str.size) {
      const name = r.cstring(Number(str.offset + val), Math.min(Number(str.size - val), 1 << 20));
      if (name) image.libraries.push(name);
    } else if (tag === 14n && val < str.size) {
      image.metadata.soname = r.cstring(Number(str.offset + val), Math.min(Number(str.size - val), 1 << 20));
    }
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

function elfMachineName(m) {
  return ({ 3: 'x86', 8: 'mips', 20: 'ppc', 21: 'ppc64', 40: 'arm', 62: 'x86_64', 183: 'arm64', 243: 'riscv' })[m] || `machine-${m}`;
}
function elfOsAbi(v) {
  return ({ 0: 'sysv', 1: 'hpux', 2: 'netbsd', 3: 'linux', 6: 'solaris', 9: 'freebsd', 12: 'openbsd' })[v] || `elf-osabi-${v}`;
}

function safeOffset(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
