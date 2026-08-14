import { inRange } from './reader.js';

function bigintOrNull(v) {
  if (v == null) return null;
  return typeof v === 'bigint' ? v : BigInt(v);
}

function normalizePerms(p) {
  if (!p) return { read: false, write: false, execute: false };
  return { read: !!p.read, write: !!p.write, execute: !!p.execute };
}

export class BinaryImage {
  constructor(input, meta = {}) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.format = meta.format || 'unknown';
    this.arch = meta.arch || 'unknown';
    this.bits = meta.bits || 0;
    this.endian = meta.endian || 'little';
    this.platform = meta.platform || null;
    this.abi = meta.abi || null;
    this.imageBase = bigintOrNull(meta.imageBase) ?? 0n;
    this.entrypoint = bigintOrNull(meta.entrypoint);
    this.fileOffset = bigintOrNull(meta.fileOffset) ?? 0n;
    this.fileSize = bigintOrNull(meta.fileSize) ?? BigInt(this.bytes.length);
    this.segments = [];
    this.sections = [];
    this.imports = [];
    this.exports = [];
    this.symbols = [];
    this.relocations = [];
    this.functions = [];
    this.libraries = [];
    this.warnings = [];
    this.metadata = meta.metadata || {};
  }

  addSegment(s) {
    const seg = {
      name: s.name || '', address: BigInt(s.address ?? 0), size: BigInt(s.size ?? 0),
      fileOffset: BigInt(s.fileOffset ?? 0), fileSize: BigInt(s.fileSize ?? 0),
      perms: normalizePerms(s.perms), flags: s.flags ?? 0, source: s.source || this.format,
    };
    this.segments.push(seg); return seg;
  }

  addSection(s) {
    const sec = {
      name: s.name || '', segment: s.segment || null,
      address: BigInt(s.address ?? 0), size: BigInt(s.size ?? 0),
      fileOffset: BigInt(s.fileOffset ?? 0), fileSize: BigInt(s.fileSize ?? s.size ?? 0),
      perms: normalizePerms(s.perms), flags: s.flags ?? 0, type: s.type ?? null,
      index: s.index ?? null, source: s.source || this.format,
    };
    this.sections.push(sec); return sec;
  }

  addressToOffset(address) {
    const a = BigInt(address);
    for (const s of this.segments) if (inRange(a, s.address, s.fileSize)) return s.fileOffset + (a - s.address);
    for (const s of this.sections) if (s.address !== 0n && inRange(a, s.address, s.fileSize)) return s.fileOffset + (a - s.address);
    return null;
  }

  offsetToAddress(offset) {
    const o = BigInt(offset);
    for (const s of this.segments) if (inRange(o, s.fileOffset, s.fileSize)) return s.address + (o - s.fileOffset);
    for (const s of this.sections) if (s.address !== 0n && inRange(o, s.fileOffset, s.fileSize)) return s.address + (o - s.fileOffset);
    return null;
  }

  sectionAt(address) { const a = BigInt(address); return this.sections.find((s) => inRange(a, s.address, s.size)) || null; }
  segmentAt(address) { const a = BigInt(address); return this.segments.find((s) => inRange(a, s.address, s.size)) || null; }

  readVirtual(address, size) {
    const off = this.addressToOffset(address);
    if (off == null) return null;
    const o = Number(off), n = Number(size);
    if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < 0 || n < 0 || o + n > this.bytes.length) return null;
    return this.bytes.subarray(o, o + n);
  }

  finalize() {
    const byAddr = (a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    this.segments.sort(byAddr); this.sections.sort(byAddr); this.symbols.sort(byAddr);
    this.exports.sort(byAddr); this.relocations.sort(byAddr);
    this.functions = mergeFunctionSeeds(this.functions);
    this.imports = dedupeImports(this.imports);
    this.libraries = [...new Set(this.libraries.filter(Boolean))];
    return this;
  }

  summary() {
    return {
      format: this.format, arch: this.arch, bits: this.bits, endian: this.endian,
      platform: this.platform, imageBase: this.imageBase, entrypoint: this.entrypoint,
      segments: this.segments.length, sections: this.sections.length, imports: this.imports.length,
      exports: this.exports.length, symbols: this.symbols.length, relocations: this.relocations.length,
      functions: this.functions.length, libraries: this.libraries.length, warnings: [...this.warnings],
    };
  }

  toJSON() {
    const convert = (v) => {
      if (typeof v === 'bigint') return '0x' + v.toString(16).toUpperCase();
      if (Array.isArray(v)) return v.map(convert);
      if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = convert(x); return out; }
      return v;
    };
    return convert({ ...this.summary(), libraries: this.libraries, segments: this.segments, sections: this.sections, imports: this.imports, exports: this.exports, symbols: this.symbols, relocations: this.relocations, functions: this.functions, metadata: this.metadata });
  }
}

export function functionSeed(address, opts = {}) {
  return {
    address: BigInt(address),
    size: opts.size == null ? null : BigInt(opts.size),
    end: opts.end == null ? null : BigInt(opts.end),
    name: opts.name || null,
    source: opts.source || 'heuristic',
    confidence: Math.max(0, Math.min(1, Number(opts.confidence ?? 0.5))),
    kind: opts.kind || 'function',
    nextStart: opts.nextStart == null ? null : BigInt(opts.nextStart),
  };
}

export function mergeFunctionSeeds(input) {
  const rank = { symbol: 5, exception: 4, unwind: 4, function_starts: 4, export: 3, entrypoint: 2, heuristic: 1 };
  const m = new Map();
  for (const f0 of input || []) {
    if (f0 == null || f0.address == null) continue;
    const f = { ...f0, address: BigInt(f0.address) };
    const k = f.address.toString();
    const prev = m.get(k);
    if (!prev) { m.set(k, f); continue; }
    const prevRank = rank[prev.source] || 0, curRank = rank[f.source] || 0;
    const best = curRank > prevRank || (curRank === prevRank && (f.confidence || 0) > (prev.confidence || 0)) ? f : prev;
    const other = best === f ? prev : f;
    if (!best.name && other.name) best.name = other.name;
    if (best.size == null && other.size != null) best.size = other.size;
    if (best.end == null && other.end != null) best.end = other.end;
    best.sources = [...new Set([...(prev.sources || [prev.source]), ...(f.sources || [f.source])])];
    best.confidence = Math.max(prev.confidence || 0, f.confidence || 0);
    m.set(k, best);
  }
  const out = [...m.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  for (let i = 0; i < out.length; i++) {
    const f = out[i];
    if (f.end == null && f.size != null) f.end = f.address + f.size;
    if (f.size == null && f.end != null && f.end > f.address) f.size = f.end - f.address;
    // The next start is only an upper bound; padding/islands must not become fake function bytes.
    if (i + 1 < out.length && out[i + 1].address > f.address) {
      const delta = out[i + 1].address - f.address;
      if (delta <= 0x1000000n) f.nextStart = out[i + 1].address;
    }
  }
  return out;
}

function dedupeImports(input) {
  const m = new Map();
  for (const i of input || []) {
    const key = `${i.library || ''}\0${i.name || ''}\0${i.ordinal ?? ''}`;
    const prev = m.get(key);
    if (!prev) { m.set(key, { ...i, sites: i.sites ? [...i.sites] : [] }); continue; }
    if (!prev.address && i.address) prev.address = i.address;
    if (!prev.source && i.source) prev.source = i.source;
    if (i.sites) prev.sites.push(...i.sites);
  }
  for (const i of m.values()) {
    if (!i.sites) continue;
    const seen = new Set();
    i.sites = i.sites.filter((s) => {
      const key = `${s.address ?? ''}:${s.offset ?? ''}:${s.kind ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  return [...m.values()];
}
