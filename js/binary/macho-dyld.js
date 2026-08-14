import { functionSeed } from './model.js';

export function parseChainedImports(r, dc, image) {
  if (!dc.size || dc.offset + dc.size > r.length || dc.size < 28) return null;
  const base = dc.offset;
  const version = r.u32(base);
  const startsOffset = r.u32(base + 4);
  const importsOffset = r.u32(base + 8);
  const symbolsOffset = r.u32(base + 12);
  const importsCount = r.u32(base + 16);
  const importsFormat = r.u32(base + 20);
  const symbolsFormat = r.u32(base + 24);
  image.metadata.chainedFixups = { version, startsOffset, importsCount, importsFormat, symbolsFormat };
  if (symbolsFormat !== 0) {
    image.warnings.push(`chained-fixups symbol pool format ${symbolsFormat} is not supported`);
    return null;
  }
  const importsBase = base + importsOffset;
  const stringsBase = base + symbolsOffset;
  const entrySize = importsFormat === 1 ? 4 : importsFormat === 2 ? 8 : importsFormat === 3 ? 16 : 0;
  if (!entrySize) { image.warnings.push(`unknown chained import format ${importsFormat}`); return null; }
  if (importsBase + importsCount * entrySize > base + dc.size) { image.warnings.push('chained imports are truncated'); return null; }
  const parsed = [];
  for (let i = 0; i < importsCount; i++) {
    const p = importsBase + i * entrySize;
    let ordinal, weak, nameOffset, addend = 0n;
    if (importsFormat === 1 || importsFormat === 2) {
      const raw = r.u32(p);
      ordinal = signExtend(raw & 0xff, 8);
      weak = !!((raw >>> 8) & 1);
      nameOffset = raw >>> 9;
      if (importsFormat === 2) addend = BigInt(r.i32(p + 4));
    } else {
      const raw = r.u32(p);
      ordinal = signExtend(raw & 0xffff, 16);
      weak = !!((raw >>> 16) & 1);
      nameOffset = r.u32(p + 4);
      addend = r.i64(p + 8);
    }
    const strp = stringsBase + nameOffset;
    if (strp < base || strp >= base + dc.size) continue;
    const name = r.cstring(strp, base + dc.size - strp);
    if (!name) continue;
    const imp = { name, library: dylibForOrdinal(image, ordinal), ordinal, weak, addend, source: 'chained-fixups', sites: [], chainedIndex: i };
    image.imports.push(imp);
    parsed[i] = imp;
  }
  return parsed;
}

export function parseChainedBindingSites(r, dc, image, imports) {
  const base = dc.offset;
  const startsOffset = r.u32(base + 4);
  if (!startsOffset || base + startsOffset + 4 > base + dc.size) return;
  const startsBase = base + startsOffset;
  const segCount = r.u32(startsBase);
  if (segCount > 4096 || startsBase + 4 + segCount * 4 > base + dc.size) return;
  let decoded = 0;
  for (let segIndex = 0; segIndex < segCount; segIndex++) {
    const rel = r.u32(startsBase + 4 + segIndex * 4);
    if (!rel) continue;
    const p = startsBase + rel;
    if (p + 22 > base + dc.size) continue;
    const structSize = r.u32(p);
    const pageSize = r.u16(p + 4);
    const pointerFormat = r.u16(p + 6);
    const segmentOffset = r.u64(p + 8);
    const maxValidPointer = r.u32(p + 16);
    const pageCount = r.u16(p + 20);
    if (!pageSize || p + structSize > base + dc.size || 22 + pageCount * 2 > structSize) continue;
    for (let page = 0; page < pageCount; page++) {
      const start = r.u16(p + 22 + page * 2);
      if (start === 0xffff) continue;
      const starts = [];
      if (start & 0x8000) {
        let oi = start & 0x7fff;
        for (let guard = 0; guard < 4096; guard++, oi++) {
          const q = p + 22 + oi * 2;
          if (q + 2 > p + structSize) break;
          const x = r.u16(q);
          starts.push(x & 0x7fff);
          if (x & 0x8000) break;
        }
      } else starts.push(start);
      for (const chainStart of starts) {
        let address = image.imageBase + segmentOffset + BigInt(page * pageSize + chainStart);
        for (let guard = 0; guard < 100000; guard++) {
          const off = image.addressToOffset(address);
          if (off == null || off + 8n > BigInt(r.length)) break;
          const raw = r.u64(Number(off));
          const d = decodeChainedPointer(raw, pointerFormat);
          if (!d) break;
          if (d.bind && d.ordinal >= 0 && d.ordinal < imports.length && imports[d.ordinal]) {
            imports[d.ordinal].sites.push({ address, offset: off, kind: 'chained-bind', pointerFormat, addend: d.addend });
            decoded++;
          }
          if (!d.next) break;
          address += BigInt(d.next * d.stride);
          if (maxValidPointer && address - (image.imageBase + segmentOffset) > BigInt(maxValidPointer) + BigInt(pageSize * pageCount)) break;
        }
      }
    }
  }
  image.metadata.chainedFixups.bindingSites = decoded;
}

function decodeChainedPointer(raw, format) {
  if (format === 2 || format === 6) {
    const bind = !!(raw >> 63n);
    const next = Number((raw >> 51n) & 0xfffn);
    if (!bind) return { bind: false, ordinal: -1, addend: 0n, next, stride: 4 };
    const ordinal = Number(raw & 0xffffffn);
    let addend = Number((raw >> 24n) & 0xffn);
    if (addend & 0x80) addend -= 0x100;
    return { bind: true, ordinal, addend: BigInt(addend), next, stride: 4 };
  }
  if ([1, 7, 9, 10, 12].includes(format)) {
    const bind = !!((raw >> 62n) & 1n);
    const next = Number((raw >> 51n) & 0x7ffn);
    const ordinalBits = format === 12 ? 24n : 16n;
    const ordinalMask = (1n << ordinalBits) - 1n;
    const ordinal = Number(raw & ordinalMask);
    const auth = !!((raw >> 63n) & 1n);
    let addend = 0n;
    if (bind && !auth) {
      let a = Number((raw >> 32n) & 0x7ffffn);
      if (a & 0x40000) a -= 0x80000;
      addend = BigInt(a);
    }
    return { bind, ordinal, addend, next, stride: 8 };
  }
  return null;
}

export function parseClassicBindings(r, dc, image, segments, source) {
  if (!dc || !dc.size || dc.offset + dc.size > r.length) return;
  const BIND_OPCODE_MASK = 0xf0, BIND_IMMEDIATE_MASK = 0x0f;
  const ptrSize = image.bits === 64 ? 8n : 4n;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let libOrdinal = 0, symbol = '', type = 1, addend = 0n, segIndex = 0, segOffset = 0n;
  const bind = () => {
    const seg = segments[segIndex];
    if (!seg || !symbol) return;
    const address = seg.address + segOffset;
    const imp = { name: symbol, library: dylibForOrdinal(image, libOrdinal), ordinal: libOrdinal, weak: false, addend, type, source, sites: [{ address, offset: image.addressToOffset(address), kind: source }] };
    image.imports.push(imp);
  };
  while (p < end) {
    const byte = r.u8(p++);
    const op = byte & BIND_OPCODE_MASK;
    const imm = byte & BIND_IMMEDIATE_MASK;
    if (op === 0x00) {
      if (source === 'lazy-bind') { symbol = ''; libOrdinal = 0; addend = 0n; continue; }
      break;
    } else if (op === 0x10) libOrdinal = imm;
    else if (op === 0x20) { const x = r.uleb(p); p = x.next; libOrdinal = Number(x.value); }
    else if (op === 0x30) libOrdinal = imm === 0 ? 0 : signExtend(imm | 0xf0, 8);
    else if (op === 0x40) { symbol = r.cstring(p, end - p); p += new TextEncoder().encode(symbol).length + 1; }
    else if (op === 0x50) type = imm;
    else if (op === 0x60) { const x = r.sleb(p); p = x.next; addend = x.value; }
    else if (op === 0x70) { segIndex = imm; const x = r.uleb(p); p = x.next; segOffset = x.value; }
    else if (op === 0x80) { const x = r.uleb(p); p = x.next; segOffset += x.value; }
    else if (op === 0x90) { bind(); segOffset += ptrSize; }
    else if (op === 0xa0) { bind(); const x = r.uleb(p); p = x.next; segOffset += ptrSize + x.value; }
    else if (op === 0xb0) { bind(); segOffset += ptrSize + BigInt(imm) * ptrSize; }
    else if (op === 0xc0) {
      const a = r.uleb(p); p = a.next;
      const b = r.uleb(p); p = b.next;
      for (let i = 0n; i < a.value; i++) { bind(); segOffset += ptrSize + b.value; }
    } else if (op === 0xd0) {
      image.warnings.push('threaded dyld binding opcodes are not decoded yet');
      break;
    } else break;
  }
}

export function parseExportTrie(r, dc, image) {
  if (!dc || !dc.size || dc.offset + dc.size > r.length) return;
  const base = dc.offset;
  const end = dc.offset + dc.size;
  const visited = new Set();
  const walk = (nodeOff, prefix, depth) => {
    if (depth > 256 || nodeOff < 0 || base + nodeOff >= end || visited.has(`${nodeOff}:${prefix}`)) return;
    visited.add(`${nodeOff}:${prefix}`);
    let p = base + nodeOff;
    const term = r.uleb(p); p = term.next;
    const terminalEnd = p + Number(term.value);
    if (term.value && terminalEnd <= end) {
      const flagsX = r.uleb(p); p = flagsX.next;
      const flags = Number(flagsX.value);
      if (flags & 0x08) {
        const ord = r.uleb(p); p = ord.next;
        const imported = r.cstring(p, terminalEnd - p);
        image.exports.push({ name: prefix, address: 0n, kind: 'reexport', flags, ordinal: Number(ord.value), imported: imported || null, source: 'exports-trie' });
      } else {
        const addrX = r.uleb(p); p = addrX.next;
        const address = image.imageBase + addrX.value;
        const ex = { name: prefix, address, kind: 'export', flags, source: 'exports-trie' };
        if (flags & 0x10) {
          const resolverX = r.uleb(p); p = resolverX.next;
          ex.resolver = image.imageBase + resolverX.value;
        }
        image.exports.push(ex);
        const sec = image.sectionAt(address);
        if (sec && sec.perms.execute) image.functions.push(functionSeed(address, { name: prefix, source: 'export', confidence: 0.9 }));
      }
    }
    p = terminalEnd;
    if (p >= end) return;
    const children = r.u8(p++);
    for (let i = 0; i < children; i++) {
      const edge = r.cstring(p, end - p);
      p += new TextEncoder().encode(edge).length + 1;
      if (p >= end) break;
      const child = r.uleb(p); p = child.next;
      walk(Number(child.value), prefix + edge, depth + 1);
    }
  };
  try { walk(0, '', 0); } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
    image.warnings.push(`exports trie: ${e.message}`);
  }
}

function dylibForOrdinal(image, ordinal) {
  if (ordinal === 0) return null;
  if (ordinal === -1 || ordinal === 0xff) return '<main-executable>';
  if (ordinal === -2 || ordinal === 0xfe) return '<flat-lookup>';
  if (ordinal === -3 || ordinal === 0xfd) return '<weak-lookup>';
  return ordinal > 0 ? image.libraries[ordinal - 1] || null : null;
}
function signExtend(v, bits) { const sign = 1 << (bits - 1); const mask = (1 << bits) - 1; v &= mask; return (v & sign) ? v - (1 << bits) : v; }
