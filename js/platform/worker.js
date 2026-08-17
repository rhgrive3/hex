import { asByteSource, detectBinary, openBinarySource, parseMachOSource } from '../binary/index.js';
import { CachedByteSource } from '../bytesource/cached.js';
import { describeBinaryImage } from './describe.js';
import { fingerprintVendors } from '../knowledge/index.js';
import { hashByteSource } from './hash.js';
import { boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed } from './worker-validation.js';
import { analysisFromBinaryImage, emptyAnalysis } from './analysis-result.js';
import { analyzeDecodedSemanticFunction } from '../targets/architecture/x86_64/semantic-function.js';

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
    for (const entry of active.values()) {
      if ((msg.requestId == null || msg.requestId === entry.id) && (msg.epoch == null || msg.epoch === entry.epoch)) entry.controller.abort();
    }
    return;
  }
  const serialized = msg.t === 'open' || msg.t === 'detect';
  if (serialized) {
    currentEpoch = msg.epoch;
    for (const entry of active.values()) if (entry.epoch !== currentEpoch) entry.controller.abort();
  }
  const execute = async () => {
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    const controller = new AbortController();
    const requestKey = msg.id == null ? null : `${msg.epoch}:${msg.id}`;
    if (requestKey != null && active.has(requestKey)) throw new Error(`Duplicate active request id ${msg.id} for epoch ${msg.epoch}.`);
    if (requestKey != null) active.set(requestKey, { id: msg.id, epoch: msg.epoch, controller });
    try { return await handle(msg, controller.signal); }
    finally { if (requestKey != null && active.get(requestKey)?.controller === controller) active.delete(requestKey); }
  };
  try {
    const result = serialized ? (openChain = openChain.then(execute, execute)) : openChain.then(execute);
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
    case 'analyze': return analyzeImage(msg, signal);
    case 'semanticFunction': return analyzeDecodedSemanticFunction(msg.input, { signal });
    case 'strings': return scanStrings(msg, signal);
    case 'search': return runSearch(msg, signal);
    case 'readAt': return readAtAddress(msg, signal);
    case 'guessFunctions': return genericFunctionSeeds();
    case 'xrefs': return { results: [], cancelled: false, capped: false, unsupported: true };
    case 'scanProgram': return emptyProgramScan(msg.regionId);
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
  const candidate = msg.file;
  if (!candidate || !Number.isSafeInteger(candidate.size) || candidate.size <= 0) throw new Error('This file is empty or has an invalid size.');
  const temporary = createSource(candidate);
  try {
    const length = Math.min(16, candidate.size);
    const prefix = await temporary.readExactly(0n, length, { signal });
    if (signal.aborted) throw new Error('Open cancelled');
    const detected = detectBinary(prefix);
    return { formatId: detected.format, fat: !!detected.fat, size: BigInt(candidate.size), sourceBacked: true };
  } finally { temporary.clear?.(); }
}

async function openFile(msg, signal) {
  const candidateFile = msg.file;
  if (!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size <= 0) throw new Error('This file is empty or has an invalid size.');
  progress(msg, 'header', 0, 7);
  const candidateSource = createSource(candidateFile);
  const cancellable = {
    size: candidateSource.size,
    maxReadLength: candidateSource.maxReadLength,
    read: (offset, length, options = {}) => candidateSource.read(offset, length, { ...options, signal }),
  };
  let candidateImage, candidateDescriptor;
  try {
    candidateImage = await openBinarySource(cancellable, {
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
    if (signal.aborted) throw new Error('Open cancelled');
    progress(msg, 'sections', 2, 7);
    const engine = {
      arm64: candidateImage.arch === 'arm64' || candidateImage.arch === 'arm64e',
      arm64e: candidateImage.arch === 'arm64e',
      verified: false,
    };
    candidateDescriptor = describeBinaryImage(candidateImage, { name: candidateFile.name || 'binary', engine });
    candidateDescriptor.platform.vendorCandidates = fingerprintVendors({ libraries: candidateImage.libraries, imports: candidateImage.imports, symbols: candidateImage.symbols });
    const candidateRegions = new Map();
    for (const region of candidateDescriptor.slices.flatMap((s) => s.regions)) if (region?.id) candidateRegions.set(region.id, region);
    candidateRegions.set(candidateDescriptor.raw.id, candidateDescriptor.raw);

    progress(msg, 'symbols', 3, 7, { count: candidateImage.symbols.length });
    progress(msg, 'imports', 4, 7, { count: candidateImage.imports.length });
    progress(msg, 'strings', 4, 7, { deferred: true });
    progress(msg, 'functions', 5, 7, { count: candidateImage.functions.length });
    progress(msg, 'expensive', 5, 7, { deferred: true });

    const previousSource = source;
    file = candidateFile;
    source = candidateSource;
    image = candidateImage;
    descriptor = candidateDescriptor;
    regions = candidateRegions;
    if (previousSource && previousSource !== candidateSource) previousSource.clear?.();
    return candidateDescriptor;
  } catch (error) {
    candidateSource.clear?.();
    throw error;
  }
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
  const chunkIndex = checkedChunkIndex(chunk);
  const rel = BigInt(chunkIndex) * BigInt(CHUNK_BYTES);
  const remaining = regionSize(region.size) - rel;
  if (remaining <= 0n) return { regionId, chunk, bytes: new Uint8Array(0), mn: '', ops: '', rows: 0 };
  const length = chunkLength(remaining, CHUNK_BYTES);
  const bytes = await readFileRange(BigInt(region.fileOffset) + rel, length, signal);
  const copy = bytes.slice();
  return { regionId, chunk, bytes: copy, mn: '', ops: '', rows: Math.ceil(copy.length / ROW_BYTES), __transfer: [copy.buffer] };
}

async function analyzeImage(msg, signal) {
  if (!image) return emptyAnalysis();
  let selected = image;
  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
    selected = await parseMachOSource(source, {
      sliceIndex: msg.sliceIndex,
      signal,
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
  }
  if (signal.aborted) throw new Error('Analysis cancelled');
  return analysisFromBinaryImage(selected);
}

function genericFunctionSeeds() {
  const values = [...new Set((image?.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const starts = new BigUint64Array(values);
  const allSeedsExact = values.length > 0 && (image?.functions || []).every(isExactFunctionSeed);
  return { starts, cancelled: false, exact: allSeedsExact, allSeedsExact,
    complete: false, discoveryComplete: false,
    completeness: { complete:false, capped:false, reasons:['platform-function-discovery-not-exhaustive'] },
    __transfer: [starts.buffer] };
}

function emptyProgramScan(regionId = null) {
  const callFrom = new BigUint64Array(0), callTo = new BigUint64Array(0), refFrom = new BigUint64Array(0), refTo = new BigUint64Array(0);
  const refKind = new Uint8Array(0), kinds = new Uint8Array(0);
  return { regionId, callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0,
    callsCapped: false, refsCapped: false, words: 0, unsupported: true,
    architecture: image?.arch || null,
    completeness: { complete:false, reasons:['unsupported-program-analysis'] },
    __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer] };
}

async function scanStrings(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  const minLength = Math.max(2, Number(msg.min) || 4);
  const cap = Math.min(Math.max(1, Number(msg.limit) || STRINGS_LIMIT), STRINGS_LIMIT);
  const regionBytes = regionSize(region.size);
  const total = msg.maxBytes == null ? regionBytes : boundedOffset(msg.maxBytes, regionBytes, 'maxBytes');
  const out = [];
  let pos = 0n, runStart = null, runBytes = [];
  const flush = () => {
    if (runStart != null && runBytes.length) {
      const text = decoder.decode(new Uint8Array(runBytes)).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
      if (text.length >= minLength) out.push({ addr: BigInt(region.vmAddr) + runStart, offset: exactExternalInteger(runStart), text });
    }
    runStart = null;
    runBytes = [];
  };
  let carry = new Uint8Array(0), carryAt = 0n;
  while (pos < total && out.length < cap) {
    if (signal.aborted) return { results: out, cancelled: true, capped: false, scannedBytes: exactExternalInteger(pos), complete: false };
    const want = chunkLength(total - pos, SCAN_BLOCK);
    const block = await readFileRange(BigInt(region.fileOffset) + pos, want, signal);
    if (!block.length) break;
    let buffer = block, base = pos;
    if (carry.length) {
      buffer = new Uint8Array(carry.length + block.length);
      buffer.set(carry);
      buffer.set(block, carry.length);
      base = carryAt;
    }
    const last = pos + BigInt(block.length) >= total;
    let i = 0;
    for (; i < buffer.length; i++) {
      const n = utf8Len(buffer, i);
      if (n === -1 && !last) break;
      if (n <= 0) { flush(); if (out.length >= cap) break; continue; }
      if (runStart == null) { runStart = base + BigInt(i); runBytes = []; }
      if (runBytes.length < MAX_STRING_CHARS * 4) for (let k = 0; k < n; k++) runBytes.push(buffer[i + k]);
      i += n - 1;
    }
    carry = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
    carryAt = base + BigInt(i);
    pos += BigInt(block.length);
    self.postMessage({ t: 'scanProgress', requestId: msg.id, epoch: msg.epoch, done: exactExternalInteger(pos), all: exactExternalInteger(total), hits: out.length });
    await Promise.resolve();
  }
  flush();
  return {
    results: out.slice(0, cap), cancelled: false, capped: out.length >= cap,
    truncationReason: out.length >= cap ? 'result-limit' : (total < regionBytes ? 'input-budget' : null),
    scannedBytes: exactExternalInteger(pos), complete: pos >= regionBytes && out.length < cap,
  };
}

async function runSearch(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  if (msg.kind !== 'hex' && msg.kind !== 'text') return { cancelled: false, results: [], scanned: 0, capped: false, unsupported: true };
  const total = regionSize(region.size);
  const start = boundedOffset(msg.from ?? 0, total, 'search start');
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
    if (signal.aborted) return { cancelled: true, results, scanned: exactExternalInteger(pos - start), capped: false };
    const block = await readFileRange(BigInt(region.fileOffset) + pos, chunkLength(total - pos, SCAN_BLOCK), signal);
    const joined = carry.length ? concat(carry, block) : block;
    const base = pos - BigInt(carry.length);
    for (let i = 0; i <= joined.length - pattern.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        const actual = msg.kind === 'text' ? lower(joined[i + j]) : joined[i + j];
        const expected = pattern[j];
        if (msg.kind === 'hex' ? ((actual & mask[j]) !== expected) : actual !== expected) { ok = false; break; }
      }
      if (!ok) continue;
      const byteOff = base + BigInt(i);
      results.push({ row: exactExternalInteger(byteOff / BigInt(ROW_BYTES)), addr: BigInt(region.vmAddr) + byteOff, byteOff: exactExternalInteger(byteOff) });
      if (results.length >= SEARCH_LIMIT) { capped = true; break; }
    }
    pos += BigInt(block.length);
    carry = pattern.length > 1 ? joined.slice(Math.max(0, joined.length - pattern.length + 1)) : new Uint8Array(0);
    self.postMessage({
      t: 'searchProgress', requestId: msg.id, epoch: msg.epoch,
      done: exactExternalInteger(pos - start), all: exactExternalInteger(total - start), hits: results.length,
    });
  }
  return { cancelled: false, results, scanned: exactExternalInteger(pos - start), capped };
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
