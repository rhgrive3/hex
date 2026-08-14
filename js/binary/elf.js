import { BinaryImage, functionSeed } from './model.js';
import { ByteView } from './reader.js';
import { parseProgramDynamic } from './elf-dynamic.js';
import { parseEhFrameHeader } from './elf-unwind.js';

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const PT_LOAD = 1;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_HASH = 5;
const SHT_DYNAMIC = 6;
const SHT_NOTE = 7;
const SHT_NOBITS = 8;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHF_WRITE = 0x1n;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const SHN_UNDEF = 0;

export function parseELF(input) {
  const bytes = normalizeBytes(input);
  const base = new ByteView(bytes);
  for (let i = 0; i < 4; i++) if (base.u8(i) !== ELF_MAGIC[i]) throw new Error('not an ELF binary');
  const cls = base.u8(4), data = base.u8(5);
  if (cls !== 1 && cls !== 2) throw new Error(`unsupported ELF class ${cls}`);
  if (data !== 1 && data !== 2) throw new Error(`unsupported ELF endian ${data}`);
  const bits = cls === 2 ? 64 : 32;
  const r = new ByteView(bytes, { littleEndian: data === 1 });
  const h = readHeader(r, bits);
  const image = new BinaryImage(bytes, {
    format: 'elf', bits, endian: data === 1 ? 'little' : 'big', architecture: elfMachineName(h.machine),
    platform: elfOsAbi(r.u8(7)), imageBase: 0n, entrypoint: h.entry,
    metadata: { type: h.type, machine: h.machine, flags: h.flags, osabi: r.u8(7), abiVersion: r.u8(8) },
  });
  const programHeaders = parseProgramHeaders(r, h, image, bits);
  image.imageBase = findImageBase(image);
  const rawSections = parseSectionHeaders(r, h, bits);
  nameSections(r, rawSections, h);
  for (const s of rawSections) {
    if (!s.size && s.type !== SHT_NOBITS) continue;
    const perms = { read: !!(s.flags & SHF_ALLOC), write: !!(s.flags & SHF_WRITE), execute: !!(s.flags & SHF_EXECINSTR) };
    image.addSection({
      name: s.name || `section_${s.index}`, address: s.addr, size: s.size,
      fileOffset: s.type === SHT_NOBITS ? 0n : s.offset, fileSize: s.type === SHT_NOBITS ? 0n : s.size,
      perms, flags: s.flags, type: s.type, index: s.index, source: 'ELF-section',
    });
  }
  for (const s of rawSections) if (s.type === SHT_SYMTAB || s.type === SHT_DYNSYM) parseSymbols(r, s, rawSections, image, bits);
  for (const s of rawSections) if (s.type === SHT_RELA || s.type === SHT_REL) parseRelocations(r, s, rawSections, image, bits);
  for (const s of rawSections) if (s.type === SHT_DYNAMIC) parseDynamic(r, s, rawSections, image, bits);
  const hasDynsym = rawSections.some((s) => s.type === SHT_DYNSYM);
  const hasRelocations = rawSections.some((s) => s.type === SHT_RELA || s.type === SHT_REL);
  const hasDynamic = rawSections.some((s) => s.type === SHT_DYNAMIC);
  if (!hasDynsym || !hasRelocations || !hasDynamic) {
    parseProgramDynamic(r, programHeaders, image, bits, {
      symbols: !hasDynsym,
      relocations: !hasRelocations,
    });
  }
  const ehFrameHdr = rawSections.find((s) => s.name === '.eh_frame_hdr');
  if (ehFrameHdr) parseEhFrameHeader(r, ehFrameHdr, image, bits);
  image.functions.push(functionSeed(h.entry, { source: 'entrypoint', confidence: 0.9 }));
  return image.finalize();
}

function normalizeBytes(input) {
  if (input?.__binaryByteBacking === true) return input;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('ELF parser expects bytes');
}

function readHeader(r, bits) {
  return {
    type: r.u16(16), machine: r.u16(18), version: r.u32(20),
    entry: bits === 64 ? r.u64(24) : BigInt(r.u32(24)),
    phoff: bits === 64 ? r.u64(32) : BigInt(r.u32(28)),
    shoff: bits === 64 ? r.u64(40) : BigInt(r.u32(32)),
    flags: bits === 64 ? r.u32(48) : r.u32(36),
    ehsize: bits === 64 ? r.u16(52) : r.u16(40),
    phentsize: bits === 64 ? r.u16(54) : r.u16(42),
    phnum: bits === 64 ? r.u16(56) : r.u16(44),
    shentsize: bits === 64 ? r.u16(58) : r.u16(46),
    shnum: bits === 64 ? r.u16(60) : r.u16(48),
    shstrndx: bits === 64 ? r.u16(62) : r.u16(50),
  };
}

function parseProgramHeaders(r, h, image, bits) {
  if (!h.phoff || !h.phnum || !h.phentsize) return [];
  const start = Number(h.phoff);
  if (!Number.isSafeInteger(start) || start < 0 || start + h.phnum * h.phentsize > r.length) return [];
  const out = [];
  for (let i = 0; i < h.phnum; i++) {
    const p = start + i * h.phentsize;
    let type, flags, offset, vaddr, filesz, memsz, align;
    if (bits === 64) {
      type = r.u32(p); flags = r.u32(p + 4); offset = r.u64(p + 8); vaddr = r.u64(p + 16); filesz = r.u64(p + 32); memsz = r.u64(p + 40); align = r.u64(p + 48);
    } else {
      type = r.u32(p); offset = BigInt(r.u32(p + 4)); vaddr = BigInt(r.u32(p + 8)); filesz = BigInt(r.u32(p + 16)); memsz = BigInt(r.u32(p + 20)); flags = r.u32(p + 24); align = BigInt(r.u32(p + 28));
    }
    out.push({ index: i, type, flags, offset, vaddr, filesz, memsz, align });
    if (type === PT_LOAD && memsz) {
      image.addSegment({ name: `LOAD${i}`, address: vaddr, size: memsz, fileOffset: offset, fileSize: filesz, perms: { read: !!(flags & 4), write: !!(flags & 2), execute: !!(flags & 1) }, flags, source: 'ELF-program-header' });
    }
  }
  return out;
}

function parseSectionHeaders(r, h, bits) {
  if (!h.shoff || !h.shentsize) return [];
  const first = Number(h.shoff);
  if (!Number.isSafeInteger(first) || first < 0 || first + h.shentsize > r.length) return [];
  let count = h.shnum;
  if (count === 0) count = bits === 64 ? Number(r.u64(first + 32)) : r.u32(first + 20);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000000 || first + count * h.shentsize > r.length) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = first + i * h.shentsize;
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
    const defined = shndx !== SHN_UNDEF;
    const binding = bind === 0 ? 'local' : bind === 1 ? 'global' : bind === 2 ? 'weak' : `bind-${bind}`;
    const kind = type === 2 ? 'function' : type === 1 ? 'object' : type === 3 ? 'section' : type === 6 ? 'tls' : `type-${type}`;
    const sym = { name, address: value, size, kind, binding, defined, sectionIndex: shndx, visibility: other & 3, source: table.type === SHT_DYNSYM ? 'dynsym' : 'symtab', index: i, tableIndex: table.index };
    image.symbols.push(sym);
    if (!defined && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, symbolIndex: i, tableIndex: table.index, source: 'elf-dynsym', sites: [] });
    if (defined && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) image.exports.push({ name, address: value, kind, symbolIndex: i, tableIndex: table.index, source: sym.source });
    if (defined && type === 2 && value !== 0n) image.functions.push(functionSeed(value, { size: size || null, name, source: 'symbol', confidence: 0.995 }));
  }
}

function parseRelocations(r, sec, sections, image, bits) {
  if (!sec.entsize) return;
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
