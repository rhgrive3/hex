import { hashBytes } from '../platform/hash.js';

function sortedStrings(values) {
  return [...new Set((values || []).filter((x) => x != null).map(String))].sort();
}

function normalizeBytes(bytes, relocationOffsets = []) {
  if (!bytes) return null;
  const out = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  for (const raw of relocationOffsets || []) {
    const offset = Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= out.length) continue;
    out.fill(0, offset, Math.min(out.length, offset + 8));
  }
  return out;
}

function shape(value = {}) {
  return {
    blocks: Math.max(0, Number(value.blocks || 0)),
    edges: Math.max(0, Number(value.edges || 0)),
    exits: Math.max(0, Number(value.exits || 0)),
    calls: Math.max(0, Number(value.calls || 0)),
  };
}

export function fingerprintFunction(fn = {}) {
  const bytes = fn.bytes ? (fn.bytes instanceof Uint8Array ? fn.bytes : new Uint8Array(fn.bytes)) : null;
  const normalized = normalizeBytes(bytes, fn.relocationOffsets);
  const strings = sortedStrings(fn.strings);
  const imports = sortedStrings(fn.imports);
  const calls = sortedStrings(fn.calls);
  const constants = sortedStrings(fn.constants);
  const cfg = shape(fn.cfg);
  const size = Number(fn.size ?? bytes?.length ?? 0);
  const normalizedByteHash = normalized ? hashBytes(normalized) : null;
  const byteHash = bytes ? hashBytes(bytes) : null;
  const signature = JSON.stringify({ normalizedByteHash, size, cfg, strings, imports, calls, constants, irHash: fn.irHash || null });
  return Object.freeze({
    address: fn.address == null ? null : BigInt(fn.address),
    name: fn.name || null,
    size,
    byteHash,
    normalizedByteHash,
    byteSample: normalized ? Array.from(normalized.subarray(0, Math.min(256, normalized.length))) : [],
    irHash: fn.irHash || null,
    cfg,
    strings,
    imports,
    calls,
    constants,
    hash: hashBytes(new TextEncoder().encode(signature)),
  });
}

function jaccard(a, b) {
  const left = new Set(a || []), right = new Set(b || []);
  if (!left.size && !right.size) return 1;
  let hit = 0;
  for (const value of left) if (right.has(value)) hit++;
  return hit / (left.size + right.size - hit || 1);
}

function ratio(a, b) {
  a = Math.max(0, Number(a || 0)); b = Math.max(0, Number(b || 0));
  if (!a && !b) return 1;
  return Math.min(a, b) / Math.max(a, b, 1);
}

function cfgScore(a, b) {
  return (ratio(a.blocks, b.blocks) + ratio(a.edges, b.edges) + ratio(a.exits, b.exits) + ratio(a.calls, b.calls)) / 4;
}

function byteSampleScore(a = [], b = []) {
  if (!a.length && !b.length) return 0;
  const n = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
  return same / n;
}

export function compareFingerprints(a, b) {
  const reasons = [];
  let score = 0;
  const exactBytes = a.normalizedByteHash && a.normalizedByteHash === b.normalizedByteHash;
  if (exactBytes) { score += 0.28; reasons.push('normalized-bytes'); }
  else if (a.irHash && a.irHash === b.irHash) { score += 0.25; reasons.push('normalized-ir'); }
  const bs = byteSampleScore(a.byteSample, b.byteSample); score += bs * 0.42; if (bs >= 0.8 && !exactBytes) reasons.push('byte-similarity');
  const c = cfgScore(a.cfg, b.cfg); score += c * 0.09; if (c >= 0.9) reasons.push('cfg-shape');
  const s = jaccard(a.strings, b.strings); score += s * 0.07; if (s >= 0.75 && (a.strings.length || b.strings.length)) reasons.push('strings');
  const i = jaccard(a.imports, b.imports); score += i * 0.05; if (i >= 0.75 && (a.imports.length || b.imports.length)) reasons.push('imports');
  const calls = jaccard(a.calls, b.calls); score += calls * 0.03; if (calls >= 0.75 && (a.calls.length || b.calls.length)) reasons.push('calls');
  const constants = jaccard(a.constants, b.constants); score += constants * 0.02; if (constants >= 0.75 && (a.constants.length || b.constants.length)) reasons.push('constants');
  const z = ratio(a.size, b.size); score += z * 0.04; if (z >= 0.95) reasons.push('size');
  return { confidence: Math.max(0, Math.min(1, score)), reasons };
}

export function diffFunctions(beforeFunctions, afterFunctions, options = {}) {
  const before = (beforeFunctions || []).map((fn) => fn.hash ? fn : fingerprintFunction(fn));
  const after = (afterFunctions || []).map((fn) => fn.hash ? fn : fingerprintFunction(fn));
  const threshold = options.threshold ?? 0.62;
  const ambiguityWindow = options.ambiguityWindow ?? 0.04;
  const candidates = [];
  const byToken = new Map();
  for (let j = 0; j < after.length; j++) {
    for (const token of tokens(after[j])) {
      let bucket = byToken.get(token); if (!bucket) byToken.set(token, bucket = []);
      bucket.push(j);
    }
  }
  for (let i = 0; i < before.length; i++) {
    const pool = new Set();
    for (const token of tokens(before[i])) for (const j of byToken.get(token) || []) pool.add(j);
    if (!pool.size) for (let j = 0; j < after.length; j++) if (ratio(before[i].size, after[j].size) >= 0.8) pool.add(j);
    for (const j of pool) {
      const cmp = compareFingerprints(before[i], after[j]);
      if (cmp.confidence >= threshold) candidates.push({ i, j, ...cmp });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.i - b.i || a.j - b.j);

  const usedBefore = new Set(), usedAfter = new Set(), matches = [];
  for (const candidate of candidates) {
    if (usedBefore.has(candidate.i) || usedAfter.has(candidate.j)) continue;
    const a = before[candidate.i], b = after[candidate.j];
    const near = candidates
      .filter((x) => x.i === candidate.i && x.j !== candidate.j && !usedAfter.has(x.j) && candidate.confidence - x.confidence <= ambiguityWindow)
      .slice(0, 4)
      .map((x) => ({ address: after[x.j].address, confidence: x.confidence, reasons: x.reasons }));
    const exactBytes = !!a.normalizedByteHash && a.normalizedByteHash === b.normalizedByteHash;
    const sameAddress = a.address != null && b.address != null && a.address === b.address;
    const status = exactBytes ? (sameAddress ? 'identical' : 'moved') : 'slightly changed';
    matches.push({ before: a, after: b, status, confidence: candidate.confidence, reasons: candidate.reasons, candidates: near });
    usedBefore.add(candidate.i); usedAfter.add(candidate.j);
  }

  const deleted = before.filter((_item, i) => !usedBefore.has(i)).map((fingerprint) => ({ status: 'deleted', before: fingerprint, after: null, confidence: 1, reasons: ['unmatched'] }));
  const added = after.filter((_item, j) => !usedAfter.has(j)).map((fingerprint) => ({ status: 'new', before: null, after: fingerprint, confidence: 1, reasons: ['unmatched'] }));
  return {
    matches: matches.sort(byAddress),
    deleted,
    new: added,
    results: [...matches, ...deleted, ...added],
    stats: {
      before: before.length, after: after.length, matched: matches.length,
      identical: matches.filter((x) => x.status === 'identical').length,
      moved: matches.filter((x) => x.status === 'moved').length,
      changed: matches.filter((x) => x.status === 'slightly changed').length,
      deleted: deleted.length, new: added.length,
    },
  };
}

function tokens(fp) {
  const out = [];
  if (fp.normalizedByteHash) out.push('b:' + fp.normalizedByteHash);
  if (fp.irHash) out.push('i:' + fp.irHash);
  if (fp.name) out.push('n:' + fp.name);
  for (const x of fp.strings.slice(0, 8)) out.push('s:' + x);
  for (const x of fp.imports.slice(0, 8)) out.push('m:' + x);
  return out;
}

function byAddress(a, b) {
  const x = a.before?.address ?? a.after?.address ?? 0n, y = b.before?.address ?? b.after?.address ?? 0n;
  return x < y ? -1 : x > y ? 1 : 0;
}
