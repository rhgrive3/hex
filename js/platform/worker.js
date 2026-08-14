import { asByteSource, detectBinary, openBinarySource } from '../binary/index.js';
import { CachedByteSource } from '../bytesource/cached.js';
import { describeBinaryImage } from './describe.js';
import { fingerprintVendors } from '../knowledge/index.js';
import { hashByteSource } from './hash.js';

const ROW_BYTES = 4;
const CHUNK_ROWS = 1024;
const CHUNK_BYTES = CHUNK_ROWS * ROW_BYTES;
const SCAN_BLOCK = 256 * 1024;
const SEARCH_LIMIT = 1000;
const STRINGS_LIMIT = 500_000;
const MAX_STRING_CHARS = 400;
const decoder = new TextDecoder('utf-8', { fatal: false });

let file = null;
let source = null;
let image = null;
let descriptor = null;
let regions = new Map();
let currentEpoch = 0;
let openChain = Promise.resolve();
const active = new Map();

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'cancel') {
    for (const [id, entry] of active) {
      if ((msg.requestId == null || msg.requestId === id) && (msg.epoch == null || msg.epoch === entry.epoch)) entry.controller.abort();
    }
    return;
  }
  const serialized = msg.t === 'open' || msg.t === 'detect';
  if (serialized) {
    // Advance the lifecycle epoch when the request arrives, not when its queued
    // work eventually starts. This makes older queued opens stale immediately
    // and aborts an old parse that is already consuming iPad CPU/memory.
    currentEpoch = msg.epoch;
    for (const entry of active.values()) if (entry.epoch !== currentEpoch) entry.controller.abort();
  }
  const execute = async () => {
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    const controller = new AbortController();
    if (msg.id != null) active.set(msg.id, { epoch: msg.epoch, controller });
    try { return await handle(msg, controller.signal); }
    finally { if (msg.id != null) active.delete(msg.id); }
  };
  try {
    const result = serialized ? (openChain = openChain.then(execute, execute)) : await execute();
    const resolved = await result;
    post({ t: 'ok', id: msg.id, epoch: msg.epoch, result: resolved }, resolved?.__transfer);
  } catch (error) {
    post({ t: 'err', id: msg.id, epoch: msg.epoch, error: error?.message || String(error) });
  }
};

function post(message, transfer) {
  if (message.result) delete message.result.__transfer;
  if (transfer?.length) self.postMessage(message, transfer);
  else self.postMessage(message);
}

function progress(msg, phase, done, total, extra = {}) {
  self.postMessage({ t: 'analysisProgress', requestId: msg.id, epoch: msg.epoch, phase, done, total, ...extra });
}

async function handle(msg, signal) {
  switch (msg.t) {
    case 'detect': return detectFile(msg, signal);
    case 'open': return openFile(msg, signal);
    case 'setRegions': return setRegions(msg.regions);
    case 'chunk': return getChunk(msg, signal);
    case 'analyze': return analyzeImage();
    case 'strings': return scanStrings(msg, signal);
    case 'search': return runSearch(msg, signal);
    case 'readAt': return readAtAddress(msg, signal);
    case 'guessFunctions': return genericFunctionSeeds();
    case 'xrefs': return { results: [], cancelled: false, capped: false, unsupported: true };
    case 'scanProgram': return emptyProgramScan();
    case 'fieldAccess': return msg.offsets ? { groups: Object.fromEntries((msg.offsets || []).map((x) => [String(x), []])), unsupported: true } : { results: [], unsupported: true };
    case 'valueShapes': return { groups: [], unsupported: true };
    case 'metadata': return metadataPage(msg);
    case 'hash': return { hash: await hashByteSource(source, { signal, onProgress: ({ done, total }) => self.postMessage({ t: 'analysisProgress', requestId: msg.id, epoch: msg.epoch, phase: 'hash', done, total }) }) };
    case 'memoryStats': return memoryStats();
    case 'cleanupMemory': source?.clear?.(); return memoryStats();
    case 'probe': return { ok: true, capability: descriptor?.capability || null };
    default: throw new Error(`Unknown platform request: ${msg.t}`);
  }
}

function createSource(input) {
  const base = asByteSource(input, { maxReadLength: 8 * 1024 * 1024 });
  return new CachedByteSource(base, { pageSize: 256 * 1024, maxCachedBytes: 8 * 1024 * 1024 });
}

async function detectFile(msg, signal) {
  file = msg.file;
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('This file is empty or has an invalid size.');
  image = null;
  descriptor = null;
  regions = new Map();
  source?.clear?.();
  source = createSource(file);
  const length = Math.min(16, file.size);
  const prefix = await source.readExactly(0n, length, { signal });
  if (signal.aborted) throw new Error('Open cancelled');
  const detected = detectBinary(prefix);
  return { formatId: detected.format, fat: !!detected.fat, size: BigInt(file.size), sourceBacked: true };
}

async function openFile(msg, signal) {
  file = msg.file;
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('This file is empty or has an invalid size.');
  progress(msg, 'header', 0, 7);
  source?.clear?.();
  const cached = createSource(file);
  source = cached;
  const cancellable = {
    size: cached.size,
    maxReadLength: cached.maxReadLength,
    read: (offset, length) => cached.read(offset, length, { signal }),
  };
  image = await openBinarySource(cancellable, {
    ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
  });
  if (signal.aborted) throw new Error('Open cancelled');
  progress(msg, 'sections', 2, 7);
  const engine = { arm64: image.arch === 'arm64', verified: false };
  descriptor = describeBinaryImage(image, { name: file.name || 'binary', engine });
  descriptor.platform.vendorCandidates = fingerprintVendors({ libraries: image.libraries, imports: image.imports, symbols: image.symbols });
  regions = new Map();
  setRegions(descriptor.slices.flatMap((s) => s.regions));
  regions.set(descriptor.raw.id, descriptor.raw);
  progress(msg, 'symbols', 3, 7, { count: image.symbols.length });
  progress(msg, 'imports', 4, 7, { count: image.imports.length });
  progress(msg, 'strings', 4, 7, { deferred: true });
  progress(msg, 'functions', 5, 7, { count: image.functions.length });
  progress(msg, 'expensive', 5, 7, { deferred: true });
  return descriptor;
}

function setRegions(list) {
  for (const region of list || []) if (region?.id) regions.set(region.id, region);
  return { ok: true };
}

async function readFileRange(offset, length, signal) {
  if (!source) throw new Error('No binary is open.');
  return source.readExactly(offset, length, { signal });
}

async function getChunk({ regionId, chunk }, signal) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const rel = BigInt(chunk) * BigInt(CHUNK_BYTES);
  const remaining = BigInt(region.size) - rel;
  if (remaining <= 0n) return { regionId, chunk, bytes: new Uint8Array(0), mn: '', ops: '', rows: 0 };
  const length = Number(remaining < BigInt(CHUNK_BYTES) ? remaining : BigInt(CHUNK_BYTES));
  const bytes = await readFileRange(BigInt(region.fileOffset) + rel, length, signal);
  const copy = bytes.slice();
  return { regionId, chunk, bytes: copy, mn: '', ops: '', rows: Math.ceil(copy.length / ROW_BYTES), __transfer: [copy.buffer] };
}

function analyzeImage() {
  if (!image) return emptyAnalysis();
  const entries = new Map();
  for (const symbol of image.symbols || []) {
    if (symbol?.address == null || !symbol.name) continue;
    entries.set(BigInt(symbol.address).toString(), { address: BigInt(symbol.address), name: symbol.name, exported: !!symbol.exported });
  }
  for (const exp of image.exports || []) {
    if (exp?.address == null || !exp.name) continue;
    const key = BigInt(exp.address).toString();
    const existing = entries.get(key);
    if (existing) existing.exported = true;
    else entries.set(key, { address: BigInt(exp.address), name: exp.name, exported: true });
  }
  const sorted = [...entries.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const addrs = new BigUint64Array(sorted.length);
  const kinds = new Uint8Array(sorted.length);
  const flags = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].address; flags[i] = sorted[i].exported ? 1 : 0; }
  const functions = [...new Set((image.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const funcs = new BigUint64Array(functions);
  return {
    addrs, kinds, flags, names: sorted.map((x) => x.name).join('\n'), funcs,
    symbolCount: addrs.length, funcCount: funcs.length, capped: false,
    functionStartsExact: functions.length > 0,
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer],
  };
}

function emptyAnalysis() {
  const addrs = new BigUint64Array(0), kinds = new Uint8Array(0), flags = new Uint8Array(0), funcs = new BigUint64Array(0);
  return { addrs, kinds, flags, names: '', funcs, symbolCount: 0, funcCount: 0, capped: false, functionStartsExact: false,
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer] };
}

function genericFunctionSeeds() {
  const values = [...new Set((image?.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const starts = new BigUint64Array(values);
  return { starts, cancelled: false, exact: true, __transfer: [starts.buffer] };
}

function emptyProgramScan() {
  const callFrom = new BigUint64Array(0), callTo = new BigUint64Array(0), refFrom = new BigUint64Array(0), refTo = new BigUint64Array(0);
  const refKind = new Uint8Array(0), kinds = new Uint8Array(0);
  return { callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0, callsCapped: false, refsCapped: false, words: 0, unsupported: true,
    __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer] };
}

function utf8Len(buf, index) {
  const c = buf[index];
  if (c < 0x80) return (c >= 0x20 && c < 0x7f) || c === 9 || c === 10 ? 1 : 0;
  let need = 0;
  if (c >= 0xc2 && c <= 0xdf) need = 1;
  else if (c >= 0xe0 && c <= 0xef) need = 2;
  else if (c >= 0xf0 && c <= 0xf4) need = 3;
  else return 0;
  if (index + need >= buf.length) return -1;
  for (let k = 1; k <= need; k++) if ((buf[index + k] & 0xc0) !== 0x80) return 0;
  return need + 1;
}

async function scanStrings(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  const minLength = Math.max(2, Number(msg.min) || 4);
  const cap = Math.min(Math.max(1, Number(msg.limit) || STRINGS_LIMIT), STRINGS_LIMIT);
  const regionBytes = Number(region.size);
  const total = Math.min(regionBytes, Math.max(0, Number(msg.maxBytes == null ? regionBytes : msg.maxBytes)));
  const out = [];
  let pos = 0, runStart = -1, runBytes = [];
  const flush = () => {
    if (runStart >= 0 && runBytes.length) {
      const text = decoder.decode(new Uint8Array(runBytes)).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
      if (text.length >= minLength) out.push({ addr: BigInt(region.vmAddr) + BigInt(runStart), offset: runStart, text });
    }
    runStart = -1; runBytes = [];
  };
  let carry = new Uint8Array(0), carryAt = 0;
  while (pos < total && out.length < cap) {
    if (signal.aborted) return { results: out, cancelled: true, capped: false, scannedBytes: pos, complete: false };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const block = await readFileRange(BigInt(region.fileOffset) + BigInt(pos), want, signal);
    if (!block.length) break;
    let buffer = block, base = pos;
    if (carry.length) {
      buffer = new Uint8Array(carry.length + block.length);
      buffer.set(carry); buffer.set(block, carry.length); base = carryAt;
    }
    const last = pos + block.length >= total;
    let i = 0;
    for (; i < buffer.length; i++) {
      const n = utf8Len(buffer, i);
      if (n === -1 && !last) break;
      if (n <= 0) { flush(); if (out.length >= cap) break; continue; }
      if (runStart < 0) { runStart = base + i; runBytes = []; }
      if (runBytes.length < MAX_STRING_CHARS * 4) for (let k = 0; k < n; k++) runBytes.push(buffer[i + k]);
      i += n - 1;
    }
    carry = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
    carryAt = base + i;
    pos += block.length;
    self.postMessage({ t: 'scanProgress', requestId: msg.id, epoch: msg.epoch, done: pos, all: total, hits: out.length });
    await Promise.resolve();
  }
  flush();
  return { results: out.slice(0, cap), cancelled: false, capped: out.length >= cap, scannedBytes: pos, complete: pos >= regionBytes && out.length < cap };
}

async function runSearch(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  if (msg.kind !== 'hex' && msg.kind !== 'text') return { cancelled: false, results: [], scanned: 0, capped: false, unsupported: true };
  const total = Number(region.size);
  const start = Math.max(0, Math.min(total, Number(msg.from || 0)));
  let pattern, mask = null;
  if (msg.kind === 'hex') {
    pattern = msg.hex?.bytes;
    mask = msg.hex?.mask;
    if (!pattern?.length) throw new Error('Enter a hex pattern.');
  } else {
    const q = String(msg.query || '');
    if (!q) throw new Error('Enter text to search for.');
    pattern = new TextEncoder().encode(q.toLowerCase());
  }
  const results = [];
  let pos = start, carry = new Uint8Array(0), capped = false;
  while (pos < total && !capped) {
    if (signal.aborted) return { cancelled: true, results, scanned: pos - start, capped: false };
    const block = await readFileRange(BigInt(region.fileOffset) + BigInt(pos), Math.min(SCAN_BLOCK, total - pos), signal);
    const joined = carry.length ? concat(carry, block) : block;
    const base = pos - carry.length;
    for (let i = 0; i <= joined.length - pattern.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        const actual = msg.kind === 'text' ? lower(joined[i + j]) : joined[i + j];
        const expected = pattern[j];
        if (msg.kind === 'hex' ? ((actual & mask[j]) !== expected) : actual !== expected) { ok = false; break; }
      }
      if (!ok) continue;
      const byteOff = base + i;
      results.push({ row: Math.floor(byteOff / ROW_BYTES), addr: BigInt(region.vmAddr) + BigInt(byteOff), byteOff });
      if (results.length >= SEARCH_LIMIT) { capped = true; break; }
    }
    pos += block.length;
    carry = pattern.length > 1 ? joined.slice(Math.max(0, joined.length - pattern.length + 1)) : new Uint8Array(0);
    self.postMessage({ t: 'searchProgress', requestId: msg.id, epoch: msg.epoch, done: pos - start, all: total - start, hits: results.length });
  }
  return { cancelled: false, results, scanned: pos - start, capped };
}

function lower(byte) { return byte >= 65 && byte <= 90 ? byte + 32 : byte; }
function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }

function vmToFile(address) {
  const at = BigInt(address);
  for (const region of regions.values()) {
    if (region.id === 'raw' || region.zerofill) continue;
    const start = BigInt(region.vmAddr), size = BigInt(region.size);
    if (at >= start && at < start + size) return { region, offset: BigInt(region.fileOffset) + (at - start) };
  }
  const offset = image?.addressToOffset(at);
  return offset == null ? null : { region: null, offset };
}

async function readAtAddress(msg, signal) {
  const hit = vmToFile(msg.addr);
  if (!hit) return { found: false };
  const requested = Math.min(Math.max(0, Number(msg.len) || 256), 1 << 20);
  let available = image.fileSize - hit.offset;
  if (hit.region) available = BigInt(hit.region.fileOffset) + BigInt(hit.region.size) - hit.offset;
  const length = Number(available < BigInt(requested) ? available : BigInt(requested));
  const bytes = (await readFileRange(hit.offset, length, signal)).slice();
  const result = { found: true, region: hit.region?.name || null, fileOffset: hit.offset, bytes };
  if (msg.text) {
    const end = bytes.indexOf(0);
    result.text = decoder.decode(end >= 0 ? bytes.subarray(0, end) : bytes);
    result.terminated = end >= 0;
  }
  result.__transfer = [bytes.buffer];
  return result;
}

function metadataPage(msg) {
  if (!image) throw new Error('No parsed universal binary is open.');
  const collections = {
    segments: image.segments, sections: image.sections, imports: image.imports, exports: image.exports,
    symbols: image.symbols, relocations: image.relocations, functions: image.functions, libraries: image.libraries,
  };
  if (msg.kind === 'summary') return { summary: image.summary(), metadata: image.metadata, capability: descriptor?.capability || null };
  const list = collections[msg.kind];
  if (!list) throw new Error(`Unknown metadata kind: ${msg.kind}`);
  const start = Math.max(0, Number(msg.start) || 0);
  const limit = Math.min(5000, Math.max(1, Number(msg.limit) || 500));
  return { kind: msg.kind, start, total: list.length, items: list.slice(start, start + limit), next: start + limit < list.length ? start + limit : null };
}

function memoryStats() {
  const sourceStats = source?.memoryStats?.() || {};
  return {
    ...sourceStats,
    functionsIndexed: image?.functions?.length || 0,
    stringsIndexed: 0,
    estimatedMemory: (sourceStats.bytesCached || 0) + ((image?.functions?.length || 0) * 64) + ((image?.symbols?.length || 0) * 96),
  };
}
