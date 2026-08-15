import { ByteView } from './reader.js';
import { BinaryImage, functionSeed } from './model.js';
import { parseChainedImports, parseChainedBindingSites, parseClassicBindings, parseExportTrie } from './macho-dyld.js';
import { ensureMachOMetadataBudget } from './macho-budget.js';

const LC_SEGMENT = 0x1;
const LC_SYMTAB = 0x2;
const LC_THREAD = 0x4;
const LC_UNIXTHREAD = 0x5;
const LC_DYSYMTAB = 0xb;
const LC_LOAD_DYLIB = 0xc;
const LC_ID_DYLIB = 0xd;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_SEGMENT_64 = 0x19;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const LC_FUNCTION_STARTS = 0x26;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_MAIN = 0x80000028;
const LC_VERSION_MIN_TVOS = 0x2f;
const LC_VERSION_MIN_WATCHOS = 0x30;
const LC_BUILD_VERSION = 0x32;
const LC_DYLD_EXPORTS_TRIE = 0x80000033;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;

const DYLIB_COMMANDS = new Set([
  LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB,
  LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB,
]);

export function parseMachO(input, opts = {}) {
  const bytes = new ByteView(input).bytes;
  const kind = machoKind(bytes);
  if (!kind) throw new Error('not a Mach-O file');
  if (kind.fat) {
    const selected = selectFatSlice(bytes, kind, opts.arch);
    if (!selected) throw new Error('Mach-O universal binary has no readable slice');
    const sub = bytes.subarray(Number(selected.offset), Number(selected.offset + selected.size));
    const image = parseThin(sub, { ...opts, containerOffset: selected.offset });
    image.metadata.fat = {
      slices: selected.all.map((s) => ({ arch: sliceArchName(s), cpu: s.cpu, subtype: s.subtype, offset: s.offset, size: s.size })),
      selected: { arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },
    };
    return image;
  }
  return parseThin(bytes, opts);
}

function parseThin(bytes, opts) {
  const kind = machoKind(bytes);
  if (!kind || kind.fat) throw new Error('not a thin Mach-O file');
  const r = new ByteView(bytes, { littleEndian: kind.littleEndian });
  const bits = kind.bits;
  const headerSize = bits === 64 ? 32 : 28;
  const cpu = r.i32(4);
  const subtype = r.i32(8);
  const filetype = r.u32(12);
  const ncmds = r.u32(16);
  const sizeofcmds = r.u32(20);
  const flags = r.u32(24);
  if (headerSize + sizeofcmds > r.length) throw new Error('Mach-O load commands exceed file');
  const commandEnd = headerSize + sizeofcmds;

  const arch = cpuArchName(cpu, subtype);
  const image = new BinaryImage(bytes, {
    format: 'macho', arch, bits,
    endian: kind.littleEndian ? 'little' : 'big',
    platform: 'apple', imageBase: 0n,
    fileOffset: opts.containerOffset || 0n,
    metadata: {
      cpu, subtype, cpuName: cpuName(cpu), subtypeBase: subtypeBase(subtype),
      subtypeName: arch === 'arm64e' ? 'arm64e' : String(subtypeBase(subtype)),
      filetype, flags, ncmds, sizeofcmds,
    },
  });
  const metadataBudget = ensureMachOMetadataBudget(image);

  const commands = [];
  const segmentOrder = [];
  const symtabs = [];
  const linkeditData = {};
  const dyldInfos = [];
  let p = headerSize;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > commandEnd) { image.warnings.push(`truncated load command ${i}`); break; }
    const cmd = r.u32(p);
    const cmdsize = r.u32(p + 4);
    if (cmdsize < 8 || p + cmdsize > commandEnd) {
      image.warnings.push(`invalid load command ${i} size ${cmdsize}`);
      break;
    }
    if (!metadataBudget.take({ inputBytes:cmdsize, records:1, objects:1, operations:1, estimatedHeapBytes:64 }, 'load-command')) break;
    commands.push({ cmd, offset: p, size: cmdsize });
    try {
      if (cmd === LC_SEGMENT_64 && bits === 64) parseSegment64(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SEGMENT && bits === 32) parseSegment32(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SYMTAB) {
        if (cmdsize < 24) throw new Error(`invalid LC_SYMTAB size ${cmdsize}`);
        symtabs.push({ symoff: r.u32(p + 8), nsyms: r.u32(p + 12), stroff: r.u32(p + 16), strsize: r.u32(p + 20) });
      }
      else if (DYLIB_COMMANDS.has(cmd) || cmd === LC_ID_DYLIB) {
        if (cmdsize < 24) throw new Error(`invalid dylib command size ${cmdsize}`);
        parseDylib(r, p, cmdsize, image, cmd === LC_ID_DYLIB);
      }
      else if (cmd === LC_MAIN && cmdsize >= 24) linkeditData.main = { entryoff: r.u64(p + 8), stacksize: r.u64(p + 16) };
      else if ((cmd === LC_THREAD || cmd === LC_UNIXTHREAD) && cmdsize >= 16) {
        const pc = parseThreadEntrypoint(r, p, cmdsize, cpu, bits);
        if (pc != null && linkeditData.threadEntry == null) linkeditData.threadEntry = pc;
      }
      else if (cmd === LC_VERSION_MIN_MACOSX || cmd === LC_VERSION_MIN_IPHONEOS || cmd === LC_VERSION_MIN_TVOS || cmd === LC_VERSION_MIN_WATCHOS) {
        if (cmdsize < 16) throw new Error(`invalid LC_VERSION_MIN size ${cmdsize}`);
        parseLegacyVersionMin(r, p, cmd, image);
      }
      else if (cmd === LC_FUNCTION_STARTS && cmdsize >= 16) linkeditData.functionStarts = dataCommand(r, p);
      else if (cmd === LC_DYLD_CHAINED_FIXUPS && cmdsize >= 16) linkeditData.chainedFixups = dataCommand(r, p);
      else if (cmd === LC_DYLD_EXPORTS_TRIE && cmdsize >= 16) linkeditData.exportsTrie = dataCommand(r, p);
      else if ((cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) && cmdsize >= 48) dyldInfos.push(parseDyldInfo(r, p));
      else if (cmd === LC_BUILD_VERSION && cmdsize >= 24) parseBuildVersion(r, p, image);
    } catch (e) {
      if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
      image.warnings.push(`load command 0x${cmd.toString(16)}: ${e.message}`);
    }
    p += cmdsize;
  }

  image.metadata.loadCommands = commands.length;
  image.metadata.segmentOrder = segmentOrder.map((s) => s.name);
  const text = image.segments.find((s) => s.name === '__TEXT') || image.segments.find((s) => s.perms.execute) || image.segments[0];
  image.imageBase = text ? text.address : 0n;

  if (linkeditData.main) {
    image.entrypoint = image.offsetToAddress(linkeditData.main.entryoff);
    image.metadata.entrypointSource = 'LC_MAIN';
  } else if (linkeditData.threadEntry != null) {
    image.entrypoint = linkeditData.threadEntry;
    image.metadata.entrypointSource = 'LC_UNIXTHREAD';
  }
  if (image.entrypoint != null && image.entrypoint !== 0n) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));

  for (const st of symtabs) parseSymbolTable(r, st, image, bits, metadataBudget);
  const hadFunctionStarts = !!linkeditData.functionStarts;
  if (linkeditData.functionStarts) parseFunctionStarts(r, linkeditData.functionStarts, image, metadataBudget);
  let chainedImports = null;
  if (linkeditData.chainedFixups) chainedImports = parseChainedImports(r, linkeditData.chainedFixups, image, metadataBudget);
  if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image, chainedImports, segmentOrder, metadataBudget);
  for (const info of dyldInfos) {
    parseClassicBindings(r, info.bind, image, segmentOrder, 'bind', metadataBudget);
    parseClassicBindings(r, info.weakBind, image, segmentOrder, 'weak-bind', metadataBudget);
    parseClassicBindings(r, info.lazyBind, image, segmentOrder, 'lazy-bind', metadataBudget);
    if (!linkeditData.exportsTrie && info.export.size) parseExportTrie(r, info.export, image, metadataBudget);
  }
  if (linkeditData.exportsTrie) parseExportTrie(r, linkeditData.exportsTrie, image, metadataBudget);

  const namesByAddr = new Map();
  const nameIndexEntries = image.symbols.length + image.exports.length;
  if (metadataBudget.take({ objects:nameIndexEntries, operations:nameIndexEntries, estimatedHeapBytes:nameIndexEntries*48 }, 'name-address-index')) {
    for (const sym of image.symbols) if (sym.defined && sym.address) namesByAddr.set(sym.address.toString(), sym.name);
    for (const ex of image.exports) if (ex.address) namesByAddr.set(ex.address.toString(), ex.name);
  }
  if (hadFunctionStarts) {
    for (const f of image.functions) if (!f.name) f.name = namesByAddr.get(f.address.toString()) || null;
    const provenStarts = new Set(image.functions.filter((f) => f.source !== 'export').map((f) => f.address.toString()));
    image.functions = image.functions.filter((f) => f.source !== 'export' || provenStarts.has(f.address.toString()));
  } else {
    for (const sym of image.symbols) {
      if (!sym.defined || !sym.address) continue;
      const sec = image.sectionAt(sym.address);
      if (sec && sec.perms.execute && sym.name !== '__mh_execute_header' && metadataBudget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'symbol-function-fallback')) image.functions.push(functionSeed(sym.address, { name: sym.name, source: 'symbol', confidence: 0.9 }));
    }
  }

  image.metadata.machoMetadata = metadataBudget.snapshot();
  return image.finalize();
}

function validateMappedRange(label, address, size, fileOffset, fileSize, image) {
  const inputSize = BigInt(image.bytes?.length ?? image.fileSize ?? 0);
  if (fileSize > size) throw new Error(`${label} file size exceeds VM size`);
  if (fileOffset > inputSize || fileSize > inputSize - fileOffset) throw new Error(`${label} file range exceeds input`);
  return { vmEnd: address + size, fileEnd: fileOffset + fileSize };
}

function validateSectionRange(label, saddr, ssize, fileOffset, fileSize, seg, image, zeroFill) {
  if (saddr < seg.address || saddr > seg.address + seg.size || ssize > seg.address + seg.size - saddr) throw new Error(`${label} VM range escapes parent segment`);
  if (!zeroFill) {
    if (fileOffset < seg.fileOffset || fileOffset > seg.fileOffset + seg.fileSize || fileSize > seg.fileOffset + seg.fileSize - fileOffset) throw new Error(`${label} file range escapes parent segment`);
    validateMappedRange(label, saddr, ssize, fileOffset, fileSize, image);
  }
}

function parseSegment64(r, p, cmdsize, image, order) {
  if (cmdsize < 72) throw new Error(`invalid LC_SEGMENT_64 size ${cmdsize}`);
  const name = r.ascii(p + 8, 16);
  const address = r.u64(p + 24);
  const size = r.u64(p + 32);
  const fileOffset = r.u64(p + 40);
  const fileSize = r.u64(p + 48);
  const initprot = r.i32(p + 60);
  const nsects = r.u32(p + 64);
  if (nsects > Math.floor((cmdsize - 72) / 80)) throw new Error(`invalid section count ${nsects}`);
  const flags = r.u32(p + 68);
  validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image);
  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT_64' });
  order.push(seg);
  let q = p + 72;
  for (let i = 0; i < nsects; i++, q += 80) {
    r.check(q, 80);
    const sectname = r.ascii(q, 16);
    const segname = r.ascii(q + 16, 16);
    const saddr = r.u64(q + 32);
    const ssize = r.u64(q + 40);
    const offset = r.u32(q + 48);
    const sflags = r.u32(q + 64);
    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;
    validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image, zeroFill);
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });
  }
}

function parseSegment32(r, p, cmdsize, image, order) {
  if (cmdsize < 56) throw new Error(`invalid LC_SEGMENT size ${cmdsize}`);
  const name = r.ascii(p + 8, 16);
  const address = BigInt(r.u32(p + 24));
  const size = BigInt(r.u32(p + 28));
  const fileOffset = BigInt(r.u32(p + 32));
  const fileSize = BigInt(r.u32(p + 36));
  const initprot = r.i32(p + 44);
  const nsects = r.u32(p + 48);
  if (nsects > Math.floor((cmdsize - 56) / 68)) throw new Error(`invalid section count ${nsects}`);
  const flags = r.u32(p + 52);
  validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image);
  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT' });
  order.push(seg);
  let q = p + 56;
  for (let i = 0; i < nsects; i++, q += 68) {
    r.check(q, 68);
    const sectname = r.ascii(q, 16);
    const segname = r.ascii(q + 16, 16);
    const saddr = BigInt(r.u32(q + 32));
    const ssize = BigInt(r.u32(q + 36));
    const offset = r.u32(q + 40);
    const sflags = r.u32(q + 56);
    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;
    validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image, zeroFill);
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });
  }
}

function parseDylib(r, p, cmdsize, image, isId) {
  const nameoff = r.u32(p + 8);
  if (nameoff >= cmdsize) return;
  const name = r.cstring(p + nameoff, cmdsize - nameoff);
  if (isId) image.metadata.installName = name;
  else if (name) image.libraries.push(name);
}

function parseBuildVersion(r, p, image) {
  const platform = r.u32(p + 8);
  const minos = r.u32(p + 12);
  const sdk = r.u32(p + 16);
  image.metadata.buildVersion = { platform, platformName: platformName(platform), minos: version32(minos), sdk: version32(sdk), source: 'LC_BUILD_VERSION' };
  image.platform = platformName(platform) || image.platform;
}

function parseLegacyVersionMin(r, p, cmd, image) {
  if (image.metadata.buildVersion?.source === 'LC_BUILD_VERSION') return;
  const platform = cmd === LC_VERSION_MIN_MACOSX ? 1 : cmd === LC_VERSION_MIN_IPHONEOS ? 2 : cmd === LC_VERSION_MIN_TVOS ? 3 : 4;
  image.metadata.buildVersion = { platform, platformName: platformName(platform), minos: version32(r.u32(p + 8)), sdk: version32(r.u32(p + 12)), source: 'LC_VERSION_MIN' };
  image.platform = platformName(platform) || image.platform;
}

function parseThreadEntrypoint(r, p, cmdsize, cpu, bits) {
  const end = p + cmdsize;
  let q = p + 8;
  while (q + 8 <= end) {
    const flavor = r.u32(q);
    const count = r.u32(q + 4);
    const state = q + 8;
    const stateBytes = count * 4;
    if (!Number.isSafeInteger(stateBytes) || stateBytes < 0 || state + stateBytes > end) return null;
    const arch = cpuName(cpu);
    if (arch === 'arm64' && flavor === 6 && stateBytes >= 272) return r.u64(state + 264);
    if (arch === 'x86_64' && flavor === 4 && stateBytes >= 136) return r.u64(state + 128);
    if (arch === 'arm' && bits === 32 && flavor === 1 && stateBytes >= 64) return BigInt(r.u32(state + 60));
    q = state + stateBytes;
  }
  return null;
}

function parseDyldInfo(r, p) {
  return {
    rebase: { offset: r.u32(p + 8), size: r.u32(p + 12) },
    bind: { offset: r.u32(p + 16), size: r.u32(p + 20) },
    weakBind: { offset: r.u32(p + 24), size: r.u32(p + 28) },
    lazyBind: { offset: r.u32(p + 32), size: r.u32(p + 36) },
    export: { offset: r.u32(p + 40), size: r.u32(p + 44) },
  };
}

function parseSymbolTable(r, st, image, bits, sharedBudget = null) {
  const budget = ensureMachOMetadataBudget(image, sharedBudget);
  const ent = bits === 64 ? 16 : 12;
  if (st.symoff + st.nsyms * ent > r.length || st.stroff + st.strsize > r.length) {
    image.warnings.push('Mach-O symbol table is truncated'); return;
  }
  for (let i = 0; i < st.nsyms; i++) {
    if (!budget.take({ inputBytes:ent, records:1, objects:1, operations:2, estimatedHeapBytes:224 }, 'symbol-record')) break;
    const p = st.symoff + i * ent;
    const strx = r.u32(p);
    const type = r.u8(p + 4);
    const sect = r.u8(p + 5);
    const desc = r.u16(p + 6);
    const value = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
    if (type & 0xe0) continue;
    const name = strx < st.strsize ? r.cstring(st.stroff + strx, st.strsize - strx) : '';
    if (!name) continue;
    if (!budget.take({ stringBytes:name.length*2, estimatedHeapBytes:name.length*2+32 }, 'symbol-name')) break;
    const ntype = type & 0x0e;
    const external = !!(type & 1);
    const isUndefinedType = ntype === 0;
    // For N_UNDF with non-zero n_value, Mach-O defines a tentative/common
    // symbol: n_value is the requested byte size, never a VM address.
    const commonSymbol = isUndefinedType && value !== 0n;
    const undefinedSymbol = isUndefinedType && !commonSymbol;
    const sym = {
      name,
      address: isUndefinedType ? 0n : value,
      size: commonSymbol ? value : null,
      common: commonSymbol,
      kind: ntype === 0x0e ? 'section' : commonSymbol ? 'common' : undefinedSymbol ? 'undefined' : 'other',
      binding: external ? 'global' : 'local',
      defined: !isUndefinedType,
      sectionIndex: sect, desc, source: 'LC_SYMTAB',
    };
    image.symbols.push(sym);
    if (undefinedSymbol && external) {
      const ordinal = (desc >>> 8) & 0xff;
      image.imports.push({ name, library: dylibForOrdinal(image, ordinal), ordinal, weak: !!(desc & 0x40), source: 'symbol-table', sites: [] });
    } else if (!isUndefinedType && external && value !== 0n) {
      image.exports.push({ name, address: value, kind: 'symbol', source: 'symbol-table' });
    }
    void sect;
  }
}

function parseFunctionStarts(r, dc, image, sharedBudget = null) {
  const budget = ensureMachOMetadataBudget(image, sharedBudget);
  if (!dc.size || dc.offset > r.length || dc.size > r.length - dc.offset) return;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let addr = image.imageBase;
  const alignment = (image.arch === 'arm64' || image.arch === 'arm64e' || image.arch === 'arm64_32') ? 4n : image.arch === 'arm' ? 2n : 1n;
  const status = image.metadata.functionStarts = { complete: true, recovered: 0, partialReason: null };
  while (p < end) {
    if (!budget.take({ records:1, operations:1, estimatedHeapBytes:32 }, 'function-start-record')) { status.complete=false; status.partialReason='metadata-budget'; break; }
    let x;
    try { x = r.uleb(p, 10, end); }
    catch (e) {
      if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
      status.complete = false; status.partialReason = 'truncated-leb';
      image.warnings.push(`LC_FUNCTION_STARTS: ${e.message}`); break;
    }
    p = x.next;
    if (x.value === 0n) break;
    const next = addr + x.value;
    if (next < addr) { image.warnings.push('LC_FUNCTION_STARTS address overflow'); break; }
    addr = next;
    const seg = image.segmentAt(addr);
    if (!seg || !seg.perms.execute || (alignment > 1n && addr % alignment !== 0n)) {
      image.warnings.push(`invalid LC_FUNCTION_STARTS entry 0x${addr.toString(16)}`);
      continue;
    }
    if (!budget.take({ inputBytes:x.bytes, objects:1, estimatedHeapBytes:128 }, 'function-start-output')) { status.complete=false; status.partialReason='metadata-budget'; break; }
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
    status.recovered++;
  }
}

function dataCommand(r, p) { return { offset: r.u32(p + 8), size: r.u32(p + 12) }; }
function vmPerms(v) { return { read: !!(v & 1), write: !!(v & 2), execute: !!(v & 4) }; }
function dylibForOrdinal(image, ordinal) {
  if (ordinal === 0) return null;
  if (ordinal === -1 || ordinal === 0xff) return '<main-executable>';
  if (ordinal === -2 || ordinal === 0xfe) return '<flat-lookup>';
  if (ordinal === -3 || ordinal === 0xfd) return '<weak-lookup>';
  return ordinal > 0 ? image.libraries[ordinal - 1] || null : null;
}
function cpuName(cpu) {
  const u = cpu >>> 0;
  return ({ 7: 'x86', 12: 'arm', 18: 'ppc', 0x01000007: 'x86_64', 0x0100000c: 'arm64', 0x0200000c: 'arm64_32' })[u] || `cpu-${u}`;
}
function subtypeBase(subtype) { return (subtype >>> 0) & 0x00ffffff; }
function cpuArchName(cpu, subtype) { return cpuName(cpu) === 'arm64' && subtypeBase(subtype) === 2 ? 'arm64e' : cpuName(cpu); }
function sliceArchName(slice) { return cpuArchName(slice.cpu, slice.subtype); }
function platformName(p) { return ({ 1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 6: 'macCatalyst', 7: 'iOS-simulator', 8: 'tvOS-simulator', 9: 'watchOS-simulator', 10: 'driverKit', 11: 'visionOS', 12: 'visionOS-simulator' })[p] || `apple-platform-${p}`; }
function version32(v) { return `${(v >>> 16) & 0xffff}.${(v >>> 8) & 0xff}.${v & 0xff}`; }

function machoKind(bytes) {
  if (bytes.length < 4) return null;
  const r = new ByteView(bytes);
  const s = [r.u8(0), r.u8(1), r.u8(2), r.u8(3)].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (s === 'cefaedfe') return { fat: false, bits: 32, littleEndian: true };
  if (s === 'cffaedfe') return { fat: false, bits: 64, littleEndian: true };
  if (s === 'feedface') return { fat: false, bits: 32, littleEndian: false };
  if (s === 'feedfacf') return { fat: false, bits: 64, littleEndian: false };
  if (s === 'cafebabe') return { fat: true, bits: 32, littleEndian: false };
  if (s === 'cafebabf') return { fat: true, bits: 64, littleEndian: false };
  if (s === 'bebafeca') return { fat: true, bits: 32, littleEndian: true };
  if (s === 'bfbafeca') return { fat: true, bits: 64, littleEndian: true };
  return null;
}

function selectFatSlice(bytes, kind, preferredArch) {
  const r = new ByteView(bytes, { littleEndian: kind.littleEndian });
  const n = r.u32(4);
  if (n > 128) throw new Error(`unreasonable Mach-O slice count ${n}`);
  const all = [];
  let p = 8;
  for (let i = 0; i < n; i++) {
    if (kind.bits === 64) {
      const cpu = r.i32(p), subtype = r.i32(p + 4), offset = r.u64(p + 8), size = r.u64(p + 16);
      all.push({ cpu, subtype, offset, size }); p += 32;
    } else {
      const cpu = r.i32(p), subtype = r.i32(p + 4), offset = BigInt(r.u32(p + 8)), size = BigInt(r.u32(p + 12));
      all.push({ cpu, subtype, offset, size }); p += 20;
    }
  }
  const valid = all.filter((s) => s.offset >= 0n && s.size > 0n && s.offset + s.size <= BigInt(bytes.length));
  const want = preferredArch ? valid.find((s) => sliceArchName(s) === preferredArch) : null;
  if (preferredArch && !want) throw new Error(`requested Mach-O architecture ${preferredArch} is not present in the universal binary`);
  const chosen = want || valid.find((s) => sliceArchName(s) === 'arm64e') || valid.find((s) => sliceArchName(s) === 'arm64') || valid.find((s) => sliceArchName(s) === 'x86_64') || valid[0];
  return chosen ? { ...chosen, all } : null;
}
