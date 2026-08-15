from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}: {old[:100]!r}')
    write(path, text.replace(old, new, 1))


def sub_once(path, pattern, repl, flags=0):
    text = read(path)
    next_text, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one regex match, got {count}: {pattern[:100]!r}')
    write(path, next_text)


# ---------------------------------------------------------------------------
# Shared budget / normalized-model helpers
# ---------------------------------------------------------------------------
write('js/worker-budget.js', r'''/* Shared hard limits for the classic analysis worker. */
(function installHexWorkerBudget(root) {
  const MiB = 1024 * 1024;
  root.HexWorkerBudget = Object.freeze({
    PROGRAM_INDEX_BYTES: 96 * MiB,
    FUNCTION_AUX_SLOTS: 400_000,
    functionAuxLimit(requested) {
      const n = Number.isFinite(Number(requested)) ? Math.max(0, Math.floor(Number(requested))) : 0;
      return Math.min(400_000, Math.max(16_384, n));
    },
    withinProgramBudget(currentBytes, temporaryBytes) {
      return currentBytes >= 0 && temporaryBytes >= 0 && currentBytes + temporaryBytes <= 96 * MiB;
    },
  });
})(globalThis);
''')

write('js/string-budget.js', r'''export const STRING_SCAN_BUDGET = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  resultLimit: 60_000,
  estimatedHeapBytes: 32 * 1024 * 1024,
});

export class StringCollectionBudget {
  constructor(config = STRING_SCAN_BUDGET) {
    this.inputRemaining = Math.max(0, Number(config.inputBytes) || 0);
    this.resultLimit = Math.max(1, Number(config.resultLimit) || 1);
    this.heapLimit = Math.max(1, Number(config.estimatedHeapBytes) || 1);
    this.results = 0;
    this.estimatedHeap = 0;
    this.truncationReason = null;
  }

  requestBytes(size) {
    if (this.inputRemaining <= 0) return 0;
    const n = Math.min(this.inputRemaining, Math.max(0, Number(size) || 0));
    this.inputRemaining -= n;
    return n;
  }

  requestLimit() {
    return Math.max(0, this.resultLimit - this.results);
  }

  accept(text) {
    if (this.results >= this.resultLimit) {
      this.truncationReason ||= 'result-budget';
      return false;
    }
    const bytes = 96 + String(text || '').length * 2;
    if (this.estimatedHeap + bytes > this.heapLimit) {
      this.truncationReason ||= 'heap-budget';
      return false;
    }
    this.results++;
    this.estimatedHeap += bytes;
    return true;
  }

  get exhausted() {
    return this.requestLimit() <= 0 || this.estimatedHeap >= this.heapLimit;
  }
}
''')

write('js/platform/product-descriptor.js', r'''function scalarName(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return String(value.name || value.library || value.path || value.dll || value.module || '');
}

function uniqueNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const name = scalarName(value).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function compactMetadata(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Format-neutral contract consumed by Product and legacy compatibility sheets. */
export function productDescriptor(fileInfo, slice) {
  const active = slice || fileInfo?.slices?.[0] || null;
  const embedded = fileInfo?.productDescriptor || active?.descriptor || active?.info?.descriptor || {};
  const info = active?.info || {};
  const formatId = String(embedded.formatId || fileInfo?.formatId || info.format || '').toLowerCase() || 'raw';
  const regions = Array.isArray(embedded.regions) ? embedded.regions : (active?.regions || []);
  const imports = Array.isArray(embedded.imports) ? embedded.imports : (info.imports || []);
  const exports = Array.isArray(embedded.exports) ? embedded.exports : (info.exports || []);
  const dependencies = uniqueNames([
    ...(embedded.dependencies || []),
    ...(info.dependencies || []),
    ...(info.dylibs || []),
    ...imports.map((item) => item?.library).filter(Boolean),
  ]);
  const generic = compactMetadata({
    format: formatId,
    arch: info.cpu || fileInfo?.architecture,
    bits: info.is64 === true ? 64 : info.is64 === false ? 32 : undefined,
    endian: info.endian,
    platform: info.platform,
    entrypoint: info.entry,
    imageBase: info.textVM,
  });
  return {
    formatId,
    regions,
    dependencies,
    imports,
    exports,
    formatMetadata: compactMetadata({ ...generic, ...(embedded.formatMetadata || info.formatMetadata || {}) }),
  };
}
''')

write('js/ui/evidence-model.js', r'''export function genericEvidenceStatus(item) {
  const verdict = String(item?.verdict?.status || item?.verdict || item?.status || '').toLowerCase();
  if (verdict === 'contradicted') return 'contradicted';
  if (verdict === 'confirmed' || item?.confirmed === true || item?.verified === true) return 'confirmed';
  const confidence = Number(item?.confidence ?? item?.verdict?.confidence);
  if (verdict === 'supported' || (Number.isFinite(confidence) && confidence >= 0.75)) return 'likely';
  return 'unverified';
}

export function ownerEvidence(owner) {
  if (!owner) return { status: 'unverified', unique: null, candidates: [] };
  if (owner.ambiguous === true || Array.isArray(owner.owners) && owner.owners.length > 1) {
    return { status: 'likely', unique: null, candidates: (owner.owners || []).filter(Boolean) };
  }
  if (owner.className) return { status: 'confirmed', unique: owner, candidates: [owner] };
  return { status: 'unverified', unique: null, candidates: [] };
}

export function summaryEvidenceStatus(result) {
  const value = result?.summary;
  if (value && typeof value === 'object') return genericEvidenceStatus(value);
  const confidence = Number(result?.summaryConfidence);
  if (Number.isFinite(confidence) && confidence >= 0.75) return 'likely';
  return value ? 'likely' : 'unverified';
}

export function provenanceStatus(provenance) {
  if (!provenance) return 'unverified';
  if (provenance.manual || provenance.status === 'manual') return 'manual';
  if (provenance.confirmed === true) return 'confirmed';
  const confidence = Number(provenance.confidence);
  return Number.isFinite(confidence) && confidence >= 0.5 ? 'likely' : 'unverified';
}
''')

write('js/ui/explorer-index.js', r'''const functionCache = new WeakMap();
const stringCache = new WeakMap();
const YIELD_EVERY = 4096;

function abortError() {
  const error = new Error('Explorer query aborted');
  error.name = 'AbortError';
  return error;
}

async function yieldControl(signal) {
  if (signal?.aborted) throw abortError();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw abortError();
}

async function buildFunctionIndex(sym, signal) {
  const cached = functionCache.get(sym);
  if (cached && cached.gen === sym.gen) return cached;
  const records = [];
  const prefix = new Map();
  const names = Array.isArray(sym.names) ? sym.names : [];
  const addrs = sym.addrs || [];
  const funcs = sym.funcs || [];
  let si = 0;
  for (let fi = 0; fi < funcs.length; fi++) {
    const addr = funcs[fi];
    while (si < addrs.length && addrs[si] < addr) si++;
    let name = null;
    if (si < addrs.length && addrs[si] === addr) name = String(names[si] || '');
    const manual = sym.renamedAt?.(addr);
    if (manual) name = manual;
    if (name) {
      const lower = name.toLowerCase();
      const record = { addr, name, lower };
      records.push(record);
      const key = lower.slice(0, 3);
      if (key) {
        const bucket = prefix.get(key) || [];
        bucket.push(record); prefix.set(key, bucket);
      }
    }
    if ((fi & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
  }
  for (const [rawAddr, manual] of sym.renames || []) {
    let addr;
    try { addr = BigInt(rawAddr); } catch { continue; }
    if (!sym.isFunctionStart?.(addr) || records.some((r) => r.addr === addr)) continue;
    const name = String(manual || '');
    if (!name) continue;
    const lower = name.toLowerCase();
    const record = { addr, name, lower };
    records.push(record);
    const key = lower.slice(0, 3);
    const bucket = prefix.get(key) || [];
    bucket.push(record); prefix.set(key, bucket);
  }
  const built = { gen: sym.gen, records, prefix };
  functionCache.set(sym, built);
  return built;
}

function inRegion(addr, region) {
  return !region || (addr >= region.vmAddr && addr < region.vmAddr + region.size);
}

export async function queryFunctions(app, query, { signal, limit = 200 } = {}) {
  const sym = app?.symbols;
  if (!sym) return [];
  const q = String(query || '').trim().toLowerCase();
  const region = app.codeRegion?.() || app.store?.get?.('currentRegion') || null;
  if (!q) return [];
  const address = /^sub_?([0-9a-f]+)$/i.exec(q);
  if (address) {
    try {
      const addr = BigInt('0x' + address[1]);
      if (sym.isFunctionStart?.(addr) && inRegion(addr, region)) return [{ addr, name: sym.nameAt?.(addr) || `sub_${addr.toString(16).toUpperCase()}` }];
    } catch { /* malformed address */ }
  }
  const index = await buildFunctionIndex(sym, signal);
  const source = q.length >= 3 ? (index.prefix.get(q.slice(0, 3)) || index.records) : index.records;
  const out = [];
  const seen = new Set();
  const collect = async (prefixOnly) => {
    for (let i = 0; i < source.length && out.length < limit; i++) {
      if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
      const row = source[i];
      if (!inRegion(row.addr, region)) continue;
      const hit = prefixOnly ? row.lower.startsWith(q) : row.lower.includes(q);
      if (!hit || seen.has(row.addr.toString())) continue;
      seen.add(row.addr.toString()); out.push({ addr: row.addr, name: row.name });
    }
  };
  await collect(true);
  if (out.length < limit) await collect(false);
  out.sort((a, b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);
  return out;
}

async function buildStringIndex(rows, signal) {
  const cached = stringCache.get(rows);
  if (cached) return cached;
  const records = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    records[i] = { row: rows[i], lower: String(rows[i]?.text || '').toLowerCase() };
    if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
  }
  stringCache.set(rows, records);
  return records;
}

export async function queryStrings(rows, query, { signal, limit = 200 } = {}) {
  const sourceRows = rows || [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return sourceRows;
  const records = await buildStringIndex(sourceRows, signal);
  const out = [];
  for (let i = 0; i < records.length && out.length < limit; i++) {
    if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
    if (records[i].lower.includes(q)) out.push(records[i].row);
  }
  for (const key of ['complete', 'truncated', 'truncationReason', 'scannedBytes', 'unscannedRegions']) {
    if (key in sourceRows) Object.defineProperty(out, key, { value: sourceRows[key], enumerable: false, configurable: true });
  }
  return out;
}
''')

# ---------------------------------------------------------------------------
# #557 Agent verdict semantics
# ---------------------------------------------------------------------------
replace_once('js/agent/runtime.js', 'function deterministicAnswer(plan) {', 'export function deterministicAnswer(plan) {')
replace_once('js/agent/runtime.js', """  const verdict = best.verification?.verdict?.status || best.verification?.verdict || best.verification?.status || null;
  const verified = best.verification?.verified === true || verdict === 'confirmed' || verdict === 'supported';
  const semanticCount = (best.semanticFacts || []).length;
  return {
    conclusion: { address: best.address, name: best.name || null },
    reasons: [
      { kind: 'semantic-facts', count: semanticCount },
      { kind: 'deterministic-verification', verified },
      { kind: 'candidate-score', score: best.score },
    ],
    evidence: plan.evidence || [],
    confidence: verified ? 0.98 : (semanticCount ? 0.78 : 0.45),
    missingEvidence: plan.missingEvidence || [],
  };
""", """  const verdictRecord = best.verification?.verdict;
  const verdict = String(verdictRecord?.status || verdictRecord || best.verification?.status || '').toLowerCase() || null;
  const verified = best.verification?.verified === true || verdict === 'confirmed';
  const supported = !verified && verdict === 'supported';
  const semanticCount = (best.semanticFacts || []).length;
  const sourceConfidence = Number(verdictRecord?.confidence ?? best.verification?.confidence);
  let confidence = verified ? 0.98 : supported ? 0.78 : (semanticCount ? 0.72 : 0.45);
  if (Number.isFinite(sourceConfidence)) confidence = Math.min(confidence, Math.max(0, Math.min(1, sourceConfidence)));
  return {
    conclusion: { address: best.address, name: best.name || null },
    reasons: [
      { kind: 'semantic-facts', count: semanticCount },
      { kind: 'deterministic-verification', verified, supported, verdict, sourceConfidence: Number.isFinite(sourceConfidence) ? sourceConfidence : null },
      { kind: 'candidate-score', score: best.score },
    ],
    evidence: plan.evidence || [],
    confidence,
    missingEvidence: plan.missingEvidence || [],
  };
""")

# ---------------------------------------------------------------------------
# #556/#554/#555 Worker provenance and bounded memory
# ---------------------------------------------------------------------------
replace_once('js/worker-legacy.js', "importScripts('./macho.js', './words.js', '../capstone.js');", "importScripts('./macho.js', './words.js', './worker-budget.js', '../capstone.js');\nconst WORKER_BUDGET = globalThis.HexWorkerBudget;")
replace_once('js/worker-legacy.js', "const MAX_KIND_WORDS = 16 * 1024 * 1024;  // 語ごとの分類を持つ上限（= 64 MiB のコード）", "const MAX_KIND_WORDS = 16 * 1024 * 1024;  // 語ごとの分類を持つ上限（= 64 MiB のコード）\nconst PROGRAM_INDEX_BUDGET_BYTES = WORKER_BUDGET.PROGRAM_INDEX_BYTES;\nconst FUNCTION_CANDIDATE_BUDGET = WORKER_BUDGET.FUNCTION_AUX_SLOTS;")

replace_once('js/worker-legacy.js', """  const found = new Set();
  const lo = region.vmAddr, hi = region.vmAddr + region.size;
""", """  const found = new Set();
  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const auxLimit = Math.min(FUNCTION_CANDIDATE_BUDGET, WORKER_BUDGET.functionAuxLimit(cap));
  let auxSlots = 0;
  let candidateBudgetHit = false;
  const reserveAux = (count = 1) => {
    if (candidateBudgetHit || auxSlots + count > auxLimit) { candidateBudgetHit = true; return false; }
    auxSlots += count; return true;
  };
  const addAux = (set, value) => {
    if (set.has(value)) return true;
    if (!reserveAux()) return false;
    set.add(value); return true;
  };
""")
replace_once('js/worker-legacy.js', "if (dataCandidates.size < cap) dataCandidates.add(t);", "if (dataCandidates.size < cap) addAux(dataCandidates, t);")
replace_once('js/worker-legacy.js', """  const beginWindow = (arr, pc, w, kind) => {
    const c = { addr: pc, word: w, kind, nextWord: null, nextKind: null, thirdWord: null, thirdKind: null };
    arr.push(c); pendingWindows.push(c);
  };
""", """  const beginWindow = (arr, pc, w, kind) => {
    if (!reserveAux(2)) return;
    const c = { addr: pc, word: w, kind, nextWord: null, nextKind: null, thirdWord: null, thirdKind: null };
    arr.push(c); pendingWindows.push(c);
  };
""")
replace_once('js/worker-legacy.js', "indirectFallthroughData.add(pc);", "addAux(indirectFallthroughData, pc);")
replace_once('js/worker-legacy.js', "postNoreturn.push(pc);", "if (reserveAux()) postNoreturn.push(pc);")
replace_once('js/worker-legacy.js', "if (t != null && t >= lo && t < hi) conditionalTargets.add(t);", "if (t != null && t >= lo && t < hi) addAux(conditionalTargets, t);")
replace_once('js/worker-legacy.js', "if (t != null && t >= lo && t < hi) directBranchTargets.add(t);", "if (t != null && t >= lo && t < hi) addAux(directBranchTargets, t);")
replace_once('js/worker-legacy.js', """  const capped = found.size >= cap;
  return {
    starts, cancelled: false, capped, truncated: capped, complete: !capped, cap,
    completeness: {
      complete: !capped,
      reason: capped ? 'function-start-cap-reached' : null,
""", """  const startCapHit = found.size >= cap;
  const capped = startCapHit || candidateBudgetHit;
  const truncationReason = candidateBudgetHit ? 'candidate-memory-budget' : startCapHit ? 'function-start-cap-reached' : null;
  return {
    starts, cancelled: false, capped, truncated: capped, complete: !capped, cap, truncationReason,
    completeness: {
      complete: !capped,
      reason: truncationReason,
""")

scan_program = r'''async function scanProgram({ regionId, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const total = Number(region.size);
  const words = Math.floor(total / 4);

  const initial = Math.min(words, EDGES_INITIAL);
  let callFrom = new BigUint64Array(initial);
  let callTo = new BigUint64Array(initial);
  let refFrom = new BigUint64Array(initial);
  let refTo = new BigUint64Array(initial);
  let refKind = new Uint8Array(initial);
  const kinds = new Uint8Array(Math.min(words, MAX_KIND_WORDS));

  let nCalls = 0, nRefs = 0;
  let callsCapped = false, refsCapped = false;
  let memoryCapped = false;
  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const provenance = makeAddressProvenance();
  let index = 0;
  let pos = 0;

  const allocatedBytes = () => callFrom.byteLength + callTo.byteLength + refFrom.byteLength + refTo.byteLength + refKind.byteLength + kinds.byteLength;
  const canGrow = (temporaryBytes) => WORKER_BUDGET.withinProgramBudget(allocatedBytes(), temporaryBytes) && allocatedBytes() + temporaryBytes <= PROGRAM_INDEX_BUDGET_BYTES;

  while (pos < total) {
    if (cancelled(requestId)) return { cancelled: true, __transfer: [] };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const n = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, n * 4);

    for (let i = 0; i < n; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const kind = Words.classifyWord(w);
      if (index < kinds.length) kinds[index] = kind;

      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL) {
        if (kind === Words.KIND.CALL) {
          const t = Words.branchImm26(w, pc);
          if (t != null && !callsCapped) {
            if (nCalls === callFrom.length && !growCalls()) callsCapped = memoryCapped = true;
            if (nCalls < callFrom.length) { callFrom[nCalls] = pc; callTo[nCalls] = t; nCalls++; }
          }
        }
        applyAddressFlowBarrier(provenance, kind);
        continue;
      }
      if (isAddressFlowBarrier(kind)) {
        applyAddressFlowBarrier(provenance, kind);
        continue;
      }

      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        noteAddressProvenance(provenance, rel.reg, rel.value, index);
        if (!rel.page) addRef(pc, rel.value, 0);
        continue;
      }

      const pair = Words.pairedOffset(w);
      const base = pair ? addressProvenanceBase(provenance, pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        if (!pair.load && !pair.store) noteAddressProvenance(provenance, pair.rd, full, index);
        else if (pair.rd !== pair.rn) killAddressRegister(provenance, pair.rd);
        continue;
      }

      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        continue;
      }

      if (WRITES_LOW_REG[kind]) killAddressRegister(provenance, w & 0x1f);
    }

    pos += n * 4;
    scanProgress(requestId, epoch, pos, total, nCalls + nRefs);
    await yieldToQueue();
  }

  const truncationReasons = [];
  if (callsCapped) truncationReasons.push('call-edge-memory-budget');
  if (refsCapped) truncationReasons.push('reference-memory-budget');
  if (kinds.length < words) truncationReasons.push('kind-stat-budget');
  return {
    regionId,
    vmAddr: region.vmAddr,
    words,
    callFrom, callTo, callCount: nCalls,
    refFrom, refTo, refKind, refCount: nRefs,
    kinds,
    kindsCovered: Math.min(words, kinds.length),
    callsCapped, refsCapped,
    cancelled: false,
    complete: truncationReasons.length === 0,
    truncated: truncationReasons.length > 0,
    truncationReason: truncationReasons[0] || null,
    completeness: { complete: truncationReasons.length === 0, reasons: truncationReasons, memoryBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES, allocatedBytes: allocatedBytes() },
    __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer],
  };

  function addRef(pc, target, k) {
    if (target == null || target <= 0n || refsCapped) return;
    void lo; void hi;
    if (nRefs === refFrom.length && !growRefs()) refsCapped = memoryCapped = true;
    if (nRefs < refFrom.length) {
      refFrom[nRefs] = pc; refTo[nRefs] = target; refKind[nRefs] = k; nRefs++;
    }
  }

  function growCalls() {
    const size = Math.min(Math.max(1, callFrom.length * 2), MAX_EDGES);
    if (size <= callFrom.length || !canGrow(size * 16)) return false;
    callFrom = grow64(callFrom, size);
    callTo = grow64(callTo, size);
    return true;
  }
  function growRefs() {
    const size = Math.min(Math.max(1, refFrom.length * 2), MAX_REFS);
    if (size <= refFrom.length || !canGrow(size * 17)) return false;
    refFrom = grow64(refFrom, size);
    refTo = grow64(refTo, size);
    const k = new Uint8Array(size);
    k.set(refKind);
    refKind = k;
    return true;
  }
}
'''
sub_once('js/worker-legacy.js', r'async function scanProgram\(\{ regionId, requestId, epoch \}\) \{.*?\n\}\n\nfunction grow64', scan_program + '\nfunction grow64', flags=re.S)

# Shared provenance state used by scanProgram and findXrefs.
replace_once('js/worker-legacy.js', "const PAIR_WINDOW = 4096;", r'''const PAIR_WINDOW = 4096;

function makeAddressProvenance() {
  return { pageOf: new Array(32).fill(null), pageAt: new Int32Array(32).fill(-1), pathOf: new Int32Array(32).fill(-1), path: 0 };
}
function clearAddressProvenance(state) {
  state.pageOf.fill(null); state.pageAt.fill(-1); state.pathOf.fill(-1); state.path++;
}
function killAddressRegister(state, reg) {
  if (reg < 0 || reg >= 32) return;
  state.pageOf[reg] = null; state.pageAt[reg] = -1; state.pathOf[reg] = -1;
}
function noteAddressProvenance(state, reg, value, index) {
  state.pageOf[reg] = value; state.pageAt[reg] = index; state.pathOf[reg] = state.path;
}
function addressProvenanceBase(state, reg, index, window = PAIR_WINDOW) {
  if (state.pathOf[reg] !== state.path || state.pageAt[reg] < 0 || index - state.pageAt[reg] > window) return null;
  return state.pageOf[reg];
}
function isAddressFlowBarrier(kind) {
  const K = Words.KIND;
  return kind === K.CONDBR || kind === K.BRANCH || kind === K.RET || kind === K.TRAP;
}
function applyAddressFlowBarrier(state, kind) {
  const K = Words.KIND;
  if (kind === K.CALL || kind === K.INDCALL) {
    for (let reg = 0; reg <= 18; reg++) killAddressRegister(state, reg);
    return;
  }
  if (isAddressFlowBarrier(kind)) clearAddressProvenance(state);
}
''')

# Replace xref's private ADRP state with the same provenance contract as scanProgram.
replace_once('js/worker-legacy.js', """  // レジスタごとに「直近の ADRP が作ったページ」を覚えておく。
  const pageOf = new Array(32).fill(null);
  const pageAt = new Array(32).fill(-1);
  let index = 0;
""", """  // scanProgram と同じ control-flow-aware provenance contract を使う。
  const provenance = makeAddressProvenance();
  let index = 0;
""")
replace_once('js/worker-legacy.js', """      const direct = wordTarget(w, pc);
      if (direct !== null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
        continue;
      }
      const rel = pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }
      const pair = pairedOffset(w);
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
""", """      const direct = wordTarget(w, pc);
      if (direct !== null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
      }
      const kind = Words.classifyWord(w);
      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL || isAddressFlowBarrier(kind)) {
        applyAddressFlowBarrier(provenance, kind);
        continue;
      }
      const rel = pcRelTarget(w, pc);
      if (rel) {
        noteAddressProvenance(provenance, rel.reg, rel.value, index);
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }
      const pair = pairedOffset(w);
      const base = pair ? addressProvenanceBase(provenance, pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
""")
replace_once('js/worker-legacy.js', """        if (!pair.load && !pair.store) {
          pageOf[pair.rd] = full;
          pageAt[pair.rd] = index;
        }
""", """        if (!pair.load && !pair.store) noteAddressProvenance(provenance, pair.rd, full, index);
        else if (pair.rd !== pair.rn) killAddressRegister(provenance, pair.rd);
""")

# String scan result metadata for both engines.
for worker in ['js/worker-legacy.js', 'js/platform/worker.js']:
    replace_once(worker, """    results: out.slice(0, cap), cancelled: false, capped: out.length >= cap,
    scannedBytes:""", """    results: out.slice(0, cap), cancelled: false, capped: out.length >= cap,
    truncationReason: out.length >= cap ? 'result-limit' : (total < regionBytes ? 'input-budget' : null),
    scannedBytes:""")

# ProgramIndex consumes counted views, not full-capacity buffers.
replace_once('js/program.js', """    this.callFrom = s.callFrom || new BigUint64Array(0);
    this.callTo = s.callTo || new BigUint64Array(0);
    this.refFrom = s.refFrom || new BigUint64Array(0);
    this.refTo = s.refTo || new BigUint64Array(0);
    this.refKind = s.refKind || new Uint8Array(0);
""", """    const rawCallFrom = s.callFrom || new BigUint64Array(0);
    const rawCallTo = s.callTo || new BigUint64Array(0);
    const rawRefFrom = s.refFrom || new BigUint64Array(0);
    const rawRefTo = s.refTo || new BigUint64Array(0);
    const rawRefKind = s.refKind || new Uint8Array(0);
    const callCount = Math.min(Number.isSafeInteger(s.callCount) ? s.callCount : rawCallFrom.length, rawCallFrom.length, rawCallTo.length);
    const refCount = Math.min(Number.isSafeInteger(s.refCount) ? s.refCount : rawRefFrom.length, rawRefFrom.length, rawRefTo.length, rawRefKind.length);
    this.callFrom = rawCallFrom.subarray(0, callCount);
    this.callTo = rawCallTo.subarray(0, callCount);
    this.refFrom = rawRefFrom.subarray(0, refCount);
    this.refTo = rawRefTo.subarray(0, refCount);
    this.refKind = rawRefKind.subarray(0, refCount);
""")
replace_once('js/program.js', "    this.words = s.words || 0;", "    this.words = s.words || 0;\n    this.completeness = s.completeness || { complete: !this.callsCapped && !this.refsCapped, reasons: [] };")

# ---------------------------------------------------------------------------
# #553 Global string-result/heap budget
# ---------------------------------------------------------------------------
replace_once('js/app.js', "import { NavigationHistory } from './navigation.js';", "import { NavigationHistory } from './navigation.js';\nimport { STRING_SCAN_BUDGET, StringCollectionBudget } from './string-budget.js';")
sub_once('js/app.js', r'''    let budget = 64 \* 1024 \* 1024;\n    const use = \[\];\n    const skipped = \[\];\n    for \(const r of targets\) \{.*?\n    out\.complete = skipped\.length === 0;\n    out\.skippedRegions = skipped\.map\(\(r\) => \(\{ id: r\.id, name: r\.name, section: r\.section, size: r\.size \}\)\);\n    out\.scannedBytes = scannedBytes;''', r'''    const collectionBudget = new StringCollectionBudget(STRING_SCAN_BUDGET);
    const use = [];
    const skipped = [];
    for (const r of targets) {
      const bytes = collectionBudget.requestBytes(Number(r.size));
      if (bytes <= 0) { skipped.push(r); continue; }
      use.push({ region: r, bytes });
      if (bytes < Number(r.size)) skipped.push(r);
    }
    if (!use.length && current) {
      const bytes = collectionBudget.requestBytes(Number(current.size));
      if (bytes > 0) use.push({ region: current, bytes });
    }
    const out = [];
    let scannedBytes = 0;
    let backendIncomplete = false;
    try {
      for (let itemIndex = 0; itemIndex < use.length; itemIndex++) {
        if (epoch !== this.backend.gen) return null;
        if (collectionBudget.exhausted) {
          for (const rest of use.slice(itemIndex)) if (!skipped.includes(rest.region)) skipped.push(rest.region);
          break;
        }
        const item = use[itemIndex];
        const r = item.region;
        const remaining = collectionBudget.requestLimit();
        if (remaining <= 0) { collectionBudget.truncationReason ||= 'result-budget'; break; }
        const res = await this.backend.strings({ regionId: r.id, min: 4, maxBytes: item.bytes, limit: remaining },
          onProgress && ((p) => onProgress({ phase: 'strings', done: p.done, all: p.all, region: r.id })));
        scannedBytes += res.scannedBytes || 0;
        if (!res.complete) { backendIncomplete = true; if (!skipped.includes(r)) skipped.push(r); }
        for (const s of res.results || []) {
          if (!collectionBudget.accept(s.text)) break;
          out.push({ addr: s.addr, text: s.text, region: r });
        }
        if (res.capped && !collectionBudget.truncationReason) collectionBudget.truncationReason = res.truncationReason || 'result-budget';
      }
    } finally {
      if (this.stringsBusyEpoch === epoch) {
        this.stringsBusy = null;
        this.stringsBusyEpoch = -1;
      }
    }
    const truncated = !!collectionBudget.truncationReason || skipped.length > 0 || backendIncomplete;
    out.complete = !truncated;
    out.truncated = truncated;
    out.truncationReason = collectionBudget.truncationReason || (skipped.length ? 'input-budget' : backendIncomplete ? 'backend-partial' : null);
    out.skippedRegions = skipped.map((r) => ({ id: r.id, name: r.name, section: r.section, size: r.size }));
    out.unscannedRegions = out.skippedRegions;
    out.scannedBytes = scannedBytes;''', flags=re.S)

# ObjC additions are trusted metadata; heuristics remain explicitly heuristic.
replace_once('js/app.js', "const added = this.symbols.addNames(model.names);\n          this.symbols.addFunctions(model.names.map((n) => n.addr));", "const added = this.symbols.addNames(model.names, { source: 'objc-runtime', confidence: 1, confirmed: true });\n          this.symbols.addFunctions(model.names.map((n) => n.addr), { source: 'objc-runtime', confidence: 1, confirmed: true });")
replace_once('js/app.js', "sym.addFunctions(res.starts);\n        sym.guessed = true;", "sym.addFunctions(res.starts, { source: 'heuristic', confidence: 0.55, confirmed: false });\n        sym.guessed = true;")

# ---------------------------------------------------------------------------
# #558 Symbol/function provenance
# ---------------------------------------------------------------------------
replace_once('js/symbols.js', """    this.functionStartsExact = !!r.functionStartsExact;
    this.guessed = false;          // 関数一覧が推測によるものか
""", """    this.functionStartsExact = !!r.functionStartsExact;
    this.nameProvenance = new Map();
    this.functionProvenance = new Map();
    const providedNames = Array.isArray(r.nameProvenance) ? r.nameProvenance : [];
    for (let i = 0; i < this.addrs.length; i++) {
      const p = providedNames[i] || { source: 'binary-symbol', confidence: 1, confirmed: true };
      this.nameProvenance.set(this.addrs[i].toString(), { ...p });
    }
    const providedFunctions = Array.isArray(r.functionProvenance) ? r.functionProvenance : [];
    for (let i = 0; i < this.funcs.length; i++) {
      const p = providedFunctions[i] || { source: this.functionStartsExact ? 'function-starts' : 'metadata', confidence: this.functionStartsExact ? 1 : 0.7, confirmed: this.functionStartsExact };
      this.functionProvenance.set(this.funcs[i].toString(), { ...p });
    }
    this.guessed = false;          // 関数一覧が推測によるものか
""")
replace_once('js/symbols.js', """  renamedAt(addr) {
    return addr == null ? null : (this.renames.get(addr.toString()) || null);
  }
""", """  renamedAt(addr) {
    return addr == null ? null : (this.renames.get(addr.toString()) || null);
  }

  nameEvidence(addr) {
    if (addr == null) return null;
    if (this.renames.has(addr.toString())) return { source: 'user', status: 'manual', manual: true, confirmed: false, confidence: null };
    return this.nameProvenance.get(addr.toString()) || null;
  }

  functionEvidence(addr) {
    if (addr == null) return null;
    return this.functionProvenance.get(addr.toString()) || null;
  }
""")
replace_once('js/symbols.js', "  addNames(entries) {", "  addNames(entries, provenance = { source: 'metadata', confidence: 0.9, confirmed: true }) {")
replace_once('js/symbols.js', """    this.addrs = addrs; this.kinds = kinds; this.names = names; this.flags = flags;
    this.gen = ++SymbolIndex.gen;
""", """    this.addrs = addrs; this.kinds = kinds; this.names = names; this.flags = flags;
    for (const e of fresh) this.nameProvenance.set(e.addr.toString(), { ...provenance, ...(e.provenance || {}) });
    this.gen = ++SymbolIndex.gen;
""", )
replace_once('js/symbols.js', "  addFunctions(list) {", "  addFunctions(list, provenance = { source: 'metadata', confidence: 0.7, confirmed: false }) {")
replace_once('js/symbols.js', """      have.add(a); all.push(a); added++;
""", """      have.add(a); all.push(a); added++;
      this.functionProvenance.set(a.toString(), { ...provenance });
""")
replace_once('js/symbols.js', """  setGuessedFunctions(starts) {
    this.funcs = starts || new BigUint64Array(0);
    this.funcEnds = null;
    this.guessed = true;
""", """  setGuessedFunctions(starts) {
    this.funcs = starts || new BigUint64Array(0);
    this.funcEnds = null;
    this.functionProvenance.clear();
    for (const addr of this.funcs) this.functionProvenance.set(addr.toString(), { source: 'heuristic', confidence: 0.55, confirmed: false });
    this.guessed = true;
""")

# Platform analysis retains per-function source/confidence from BinaryImage seeds.
replace_once('js/platform/worker.js', """  const functions = [...new Set((image.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const funcs = new BigUint64Array(functions);
  return {
    addrs, kinds, flags, names: sorted.map((x) => x.name).join('\\n'), funcs,
""", """  const seedByAddress = new Map();
  for (const seed of image.functions || []) if (seed?.address != null) seedByAddress.set(BigInt(seed.address).toString(), seed);
  const functions = [...seedByAddress.keys()].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const funcs = new BigUint64Array(functions);
  const functionProvenance = functions.map((addr) => {
    const seed = seedByAddress.get(addr.toString()) || {};
    const confirmed = isExactFunctionSeed(seed);
    return { source: seed.source || 'heuristic', confidence: Number(seed.confidence ?? (confirmed ? 1 : 0.5)), confirmed };
  });
  const nameProvenance = sorted.map((entry) => ({ source: entry.exported ? 'export-table' : 'binary-symbol', confidence: 1, confirmed: true }));
  return {
    addrs, kinds, flags, names: sorted.map((x) => x.name).join('\\n'), funcs, functionProvenance, nameProvenance,
""")

# ---------------------------------------------------------------------------
# #552 Normalized product descriptor across Mach-O/ELF/PE/raw
# ---------------------------------------------------------------------------
replace_once('js/platform/describe.js', """  const summary = image.summary();
  const raw = {
""", """  const summary = image.summary();
  const formatMetadata = {
    format: image.format,
    arch: image.arch,
    bits: image.bits,
    endian: image.endian,
  };
  if (image.platform != null) formatMetadata.platform = image.platform;
  if (image.abi != null) formatMetadata.abi = image.abi;
  if (image.entrypoint != null) formatMetadata.entrypoint = image.entrypoint;
  if (image.imageBase != null) formatMetadata.imageBase = image.imageBase;
  const productDescriptor = {
    formatId: image.format || 'raw',
    regions,
    dependencies: [...(image.libraries || [])],
    imports: [...(image.imports || [])],
    exports: [...(image.exports || [])],
    formatMetadata,
  };
  info.descriptor = productDescriptor;
  const raw = {
""")
replace_once('js/platform/describe.js', """    raw,
    warnings: [...(image.warnings || [])],
""", """    raw,
    productDescriptor,
    warnings: [...(image.warnings || [])],
""")

replace_once('js/panels.js', "import { buildGeminiPayload, streamGemini } from './gemini.js';", "import { buildGeminiPayload, streamGemini } from './gemini.js';\nimport { productDescriptor } from './platform/product-descriptor.js';")
# Mach-O-only header: keep only for Mach-O, otherwise show normalized facts without inventing defaults.
replace_once('js/panels.js', """    const m = slice.info;
    ul.append(groupRow(t('file.group.macho')));
    ul.append(kvRow(t('file.type'), m.filetypeName + (m.filetypeName === 'MH_EXECUTE'
""", """    const m = slice.info;
    const descriptor = productDescriptor(info, slice);
    if (descriptor.formatId === 'macho') {
      ul.append(groupRow(t('file.group.macho')));
      ul.append(kvRow(t('file.type'), m.filetypeName + (m.filetypeName === 'MH_EXECUTE'
""")
replace_once('js/panels.js', """    ul.append(kvRow(t('file.codeSignature'), m.hasCodeSignature ? t('file.present') : t('file.none')));
    if (slice.offset > 0n) ul.append(kvRow(t('file.sliceOffset'), addrHex(slice.offset)));

    if (m.entry != null) {
""", """      ul.append(kvRow(t('file.codeSignature'), m.hasCodeSignature ? t('file.present') : t('file.none')));
      if (slice.offset > 0n) ul.append(kvRow(t('file.sliceOffset'), addrHex(slice.offset)));
    } else {
      const fm = descriptor.formatMetadata || {};
      ul.append(groupRow(pick('バイナリ形式', 'Binary format')));
      if (fm.arch || m.cpu) ul.append(kvRow(t('file.cpu'), String(fm.arch || m.cpu)));
      if (fm.bits != null) ul.append(kvRow(pick('ビット幅', 'Bits'), String(fm.bits)));
      if (fm.endian) ul.append(kvRow(pick('エンディアン', 'Endianness'), String(fm.endian)));
      if (fm.platform) ul.append(kvRow(t('file.platform'), String(fm.platform)));
    }

    const entry = descriptor.formatMetadata?.entrypoint ?? m.entry;
    if (entry != null) {
""")
replace_once('js/panels.js', "right: addrHex(m.entry),\n        onTap: () => { sheet.close(); app.goToAddress(m.entry, { announce: true }); },", "right: addrHex(entry),\n        onTap: () => { sheet.close(); app.goToAddress(entry, { announce: true }); },")
replace_once('js/panels.js', """    if (m.encryption) {
""", """    if (descriptor.formatId === 'macho' && m.encryption) {
""")
replace_once('js/panels.js', """    if (m.dylibs && m.dylibs.length) {
      ul.append(groupRow(t('file.dylibs') + '  (' + m.dylibs.length + ')'));
""", """    if (descriptor.dependencies.length) {
      ul.append(groupRow(t('file.dylibs') + '  (' + descriptor.dependencies.length + ')'));
""")
replace_once('js/panels.js', "for (const d of m.dylibs) {", "for (const d of descriptor.dependencies) {")

# Replace Mach-O segment traversal with canonical regions.
sub_once('js/panels.js', r'''  const slice = app\.currentSlice\(\);\n  if \(slice && slice\.info\) \{\n    for \(const seg of slice\.info\.segments\) \{.*?\n    \}\n  \}\n\n  ul\.append\(groupRow\(t\('sections\.raw'\)\)\);''', r'''  const slice = app.currentSlice();
  if (slice) {
    const descriptor = productDescriptor(info, slice);
    const grouped = new Map();
    for (const region of descriptor.regions || []) {
      const key = region.segment || pick('セクション', 'Sections');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(region);
    }
    for (const [group, rows] of grouped) {
      ul.append(groupRow(group));
      for (const region of rows) {
        const disabled = !region || region.size === 0n;
        const extra = [addrHex(region.vmAddr) + ' – ' + addrHex(region.vmAddr + region.size), sizeText(region.size)];
        if (region.zerofill) extra.push(t('sections.zerofill'));
        if (region.truncated) extra.push(t('sections.truncated'));
        const hintText = sectionHint(region.section || region.name);
        ul.append(tapRow(region.section || region.name, {
          indent: true,
          sub: (hintText ? hintText + '\n' : '') + extra.join('  ·  '),
          tag: region.exec ? t('sections.tagCode') : (region.zerofill ? 'bss' : ''),
          tagClass: region.exec ? 'exec' : '',
          right: current && current.id === region.id ? '✓' : '',
          disabled,
          onTap: () => { sheet.close(); app.selectRegion(region); },
        }));
      }
    }
  }

  ul.append(groupRow(t('sections.raw')));''', flags=re.S)

# ---------------------------------------------------------------------------
# Product UI: #550/#551/#552/#558/#559
# ---------------------------------------------------------------------------
replace_once('js/ui/product.js', "import { askAiMenuItem, functionAiItems } from '../ai/interaction/contextual.js';", "import { askAiMenuItem, functionAiItems } from '../ai/interaction/contextual.js';\nimport { productDescriptor } from '../platform/product-descriptor.js';\nimport { queryFunctions, queryStrings } from './explorer-index.js';\nimport { genericEvidenceStatus, ownerEvidence, summaryEvidenceStatus, provenanceStatus } from './evidence-model.js';")
sub_once('js/ui/product.js', r'function matchingFunctionItems\(app, query\) \{.*?\n\}\n\nfunction sectionItems', r'''async function matchingFunctionItems(app, query, options) {
  const q = String(query || '').trim();
  if (!q) return functionSource(app);
  return queryFunctions(app, q, options);
}

function sectionItems''', flags=re.S)
replace_once('js/ui/product.js', """  return (app.store.get('regions') || []).filter((r) => !q || String(r.name || r.section || '').toLowerCase().includes(q)).map((r) => ({
""", """  const descriptor = productDescriptor(app.store.get('fileInfo'), app.currentSlice?.());
  return (descriptor.regions || []).filter((r) => !q || String(r.name || r.section || '').toLowerCase().includes(q)).map((r) => ({
""")
replace_once('js/ui/product.js', """async function stringItems(app, query) {
  const rows = await app.ensureStrings();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter((row) => String(row.text || '').toLowerCase().includes(q));
}

function externalItems(app, query) {
  const slice = app.currentSlice();
  const q = String(query || '').trim().toLowerCase();
  return ((slice && slice.info && slice.info.dylibs) || []).filter((name) => !q || name.toLowerCase().includes(q)).map((name) => ({ name }));
}
""", """async function stringItems(app, query, options) {
  const rows = await app.ensureStrings();
  return queryStrings(rows || [], query, options);
}

function externalItems(app, query) {
  const descriptor = productDescriptor(app.store.get('fileInfo'), app.currentSlice?.());
  const q = String(query || '').trim().toLowerCase();
  return (descriptor.dependencies || []).filter((name) => !q || name.toLowerCase().includes(q)).map((name) => ({ name }));
}
""")
replace_once('js/ui/product.js', """  let disposed = false;
  let virtual = null;
  let timer = 0;
""", """  let disposed = false;
  let virtual = null;
  let timer = 0;
  let queryController = null;
  let querySerial = 0;
""")
replace_once('js/ui/product.js', """  const update = async () => {
    if (disposed) return;
    const q = search.value.trim();
""", """  const update = async () => {
    if (disposed) return;
    queryController?.abort();
    const controller = new AbortController();
    queryController = controller;
    const serial = ++querySerial;
    const current = () => !disposed && !controller.signal.aborted && serial === querySerial;
    const q = search.value.trim();
""")
replace_once('js/ui/product.js', """    if (scope === 'functions') {
      const items = matchingFunctionItems(app, q);
      showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), meta: item.size != null ? String(item.size) + ' B' : '', onClick: () => router.navigate('/function/' + BigInt(item.addr).toString() + '/overview') }), text('関数名がまだ復元されていない可能性があります。', 'Function names may not be recovered yet.'));
      return;
    }
""", """    if (scope === 'functions') {
      if (q) content.replaceChildren(loadingState(text('索引を検索しています…', 'Searching index…')));
      try {
        const items = await matchingFunctionItems(app, q, { signal: controller.signal, limit: 200 });
        if (!current()) return;
        showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), meta: item.size != null ? String(item.size) + ' B' : '', onClick: () => router.navigate('/function/' + BigInt(item.addr).toString() + '/overview') }), text('関数名がまだ復元されていない可能性があります。', 'Function names may not be recovered yet.'));
      } catch (err) {
        if (err?.name !== 'AbortError' && current()) content.replaceChildren(errorState(text('検索できませんでした', 'Search failed'), String(err?.message || err)));
      }
      return;
    }
""")
replace_once('js/ui/product.js', "const items = await stringItems(app, q);\n        if (disposed) return;", "const items = await stringItems(app, q, { signal: controller.signal, limit: 200 });\n        if (!current()) return;")
replace_once('js/ui/product.js', """        showRows(items, (item) => listRow({ title: item.text, subtitle: addressText(item.addr), onClick: () => { app.goToStringAddress(item.region, item.addr); router.navigate('/code/' + BigInt(item.addr).toString()); } }), text('文字列が見つかりません。', 'No strings were found.'));
""", """        showRows(items, (item) => listRow({ title: item.text, subtitle: addressText(item.addr), onClick: () => { app.goToStringAddress(item.region, item.addr); router.navigate('/code/' + BigInt(item.addr).toString()); } }), text('文字列が見つかりません。', 'No strings were found.'));
        if (items?.complete === false) content.prepend(h('p', 'ui-partial-note', text('結果はメモリ上限内の一部です。未走査領域を「該当なし」とは扱いません。', 'Results are partial within the memory budget; unscanned regions are not treated as negative evidence.')));
""")
replace_once('js/ui/product.js', "if (!disposed) content.replaceChildren(errorState(text('文字列を表示できません', 'Could not show strings'), String(err && err.message || err)));", "if (err?.name !== 'AbortError' && current()) content.replaceChildren(errorState(text('文字列を表示できません', 'Could not show strings'), String(err && err.message || err)));")
replace_once('js/ui/product.js', "dispose: () => { disposed = true; clearTimeout(timer); virtual?.dispose(); },", "dispose: () => { disposed = true; queryController?.abort(); clearTimeout(timer); virtual?.dispose(); },")

# Evidence model uses source verdict rather than owner truthiness or manual names.
sub_once('js/ui/product.js', r'''function evidenceStatus\(item\) \{.*?\n\}\n''', "function evidenceStatus(item) { return genericEvidenceStatus(item); }\n", flags=re.S)
replace_once('js/ui/product.js', """  let disposed = false;

  const rowMapper = () => {
""", """  let disposed = false;
  const viewEpoch = app.backend?.gen;
  const viewSlice = app.store.get('sliceIndex');
  const viewCurrent = () => !disposed && app.backend?.gen === viewEpoch && app.store.get('sliceIndex') === viewSlice;

  const rowMapper = () => {
""", )
replace_once('js/ui/product.js', """    const owner = app.ownerOf?.(addr);
    const recognition = classifyFunction(recognitionInput(app, addr, res));
""", """    const owner = app.ownerOf?.(addr);
    const ownerFact = ownerEvidence(owner);
    const recognition = classifyFunction(recognitionInput(app, addr, res));
""")
replace_once('js/ui/product.js', """    const recovered = summaryText(res);
    summary.body.append(h('p', 'ui-lead', recovered || (owner && owner.className
      ? text(`${owner.className} の ${owner.sel || 'メソッド'} として認識されています。`, `Recognized as ${owner.sel || 'a method'} on ${owner.className}.`)
      : text('命令列と参照関係から、この関数の役割を確認できます。', 'Use the instructions and references below to determine this function’s role.'))));
    summary.body.append(evidenceBadge(owner ? 'confirmed' : recovered ? 'likely' : 'unverified'));
""", """    const recovered = summaryText(res);
    const recoveredStatus = summaryEvidenceStatus(res);
    const ownerLead = ownerFact.unique
      ? text(`${ownerFact.unique.className} の ${ownerFact.unique.sel || 'メソッド'} としてruntime metadataから一意に識別されています。`, `Runtime metadata uniquely identifies this as ${ownerFact.unique.sel || 'a method'} on ${ownerFact.unique.className}.`)
      : ownerFact.candidates.length
        ? text('この実装アドレスは複数のObjective-Cメソッドで共有されています。候補を確認してください。', 'This implementation address is shared by multiple Objective-C methods; review the candidates below.')
        : text('命令列と参照関係から、この関数の役割を確認できます。', 'Use the instructions and references below to determine this function’s role.');
    summary.body.append(h('p', 'ui-lead', recovered || ownerLead));
    summary.body.append(evidenceBadge(recovered ? recoveredStatus : ownerFact.status));
    if (!recovered && ownerFact.candidates.length > 1) {
      for (const candidate of ownerFact.candidates.slice(0, 8)) summary.body.append(listRow({ title: candidate.className || text('不明なクラス', 'Unknown class'), subtitle: candidate.sel || text('selector不明', 'Unknown selector'), badge: evidenceBadge('likely') }));
    }
""")
replace_once('js/ui/product.js', """    const name = app.symbols?.nameAt?.(addr);
    stack.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), badge: evidenceBadge('confirmed') }));
    stack.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), badge: evidenceBadge(name ? 'confirmed' : 'unverified') }));
""", """    const name = app.symbols?.nameAt?.(addr);
    const boundaryEvidence = app.symbols?.functionEvidence?.(addr);
    const nameEvidence = app.symbols?.nameEvidence?.(addr);
    const boundaryStatus = provenanceStatus(boundaryEvidence);
    const nameStatus = provenanceStatus(nameEvidence);
    stack.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), meta: boundaryEvidence?.source || text('由来不明', 'unknown source'), badge: evidenceBadge(boundaryStatus === 'manual' ? 'unverified' : boundaryStatus) }));
    stack.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), meta: nameStatus === 'manual' ? text('手動 / User', 'Manual / User') : (nameEvidence?.source || ''), badge: evidenceBadge(nameStatus === 'manual' ? 'unverified' : nameStatus) }));
""")
replace_once('js/ui/product.js', "await app.ensureProgram();\n    if (disposed) return;", "await app.ensureProgram();\n    if (!viewCurrent()) return;")
replace_once('js/ui/product.js', "if (disposed) return;\n        const obs = result.observation || {};", "if (!viewCurrent()) return;\n        const obs = result.observation || {};")
replace_once('js/ui/product.js', """      const res = await app.analyzeFunctionAt(addr);
      if (disposed) return;
""", """      const res = await app.analyzeFunctionAt(addr);
      if (!viewCurrent()) return;
""")
replace_once('js/ui/product.js', "if (!disposed) content.replaceChildren(errorState(text('表示できませんでした', 'Could not render this view'), String(err && err.message || err)));", "if (viewCurrent()) content.replaceChildren(errorState(text('表示できませんでした', 'Could not render this view'), String(err && err.message || err)));")

# Slice switches invalidate the active product view and all async commits.
replace_once('js/ui/product.js', """  let assistant = null;
  installCommandCenter(app, router, actions, chrome, () => assistant);
""", """  let assistant = null;
  const originalSelectSlice = typeof app.selectSlice === 'function' ? app.selectSlice.bind(app) : null;
  if (originalSelectSlice) {
    app.selectSlice = async (...args) => {
      const beforeEpoch = app.backend?.gen;
      const result = await originalSelectSlice(...args);
      if (app.backend?.gen !== beforeEpoch) {
        router.navigate('/code', { replace: true });
        assistant?.refresh();
        assistant?.collapse();
      }
      return result;
    };
  }
  installCommandCenter(app, router, actions, chrome, () => assistant);
""")
replace_once('js/ui/product.js', """    assistant?.destroy();
    chrome.remove(); nav.remove(); routeHost.remove();
""", """    assistant?.destroy();
    if (originalSelectSlice) app.selectSlice = originalSelectSlice;
    chrome.remove(); nav.remove(); routeHost.remove();
""")

# ---------------------------------------------------------------------------
# Regression tests and test-suite registration
# ---------------------------------------------------------------------------
write('tests/issues-550-559.mjs', r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deterministicAnswer } from '../js/agent/runtime.js';
import { StringCollectionBudget } from '../js/string-budget.js';
import { productDescriptor } from '../js/platform/product-descriptor.js';
import { ownerEvidence, summaryEvidenceStatus, provenanceStatus } from '../js/ui/evidence-model.js';
import { queryFunctions, queryStrings } from '../js/ui/explorer-index.js';
import { SymbolIndex } from '../js/symbols.js';
import '../js/worker-budget.js';

// #557: supported is not verified, and source verdict confidence caps output.
{
  const answer = deterministicAnswer({ best: { address: 1n, score: 99, semanticFacts: [{}], verification: { verdict: { status: 'supported', confidence: 0.61 } } }, evidence: [], missingEvidence: [] });
  const reason = answer.reasons.find((x) => x.kind === 'deterministic-verification');
  assert.equal(reason.verified, false);
  assert.equal(reason.supported, true);
  assert.equal(answer.confidence, 0.61);
  const confirmed = deterministicAnswer({ best: { address: 2n, score: 99, semanticFacts: [{}], verification: { verdict: { status: 'confirmed', confidence: 0.83 } } }, evidence: [], missingEvidence: [] });
  assert.equal(confirmed.reasons[1].verified, true);
  assert.equal(confirmed.confidence, 0.83);
}

// #559: ambiguous owners never become Confirmed; recovered-summary certainty is independent.
{
  const ambiguous = ownerEvidence({ ambiguous: true, owners: [{ className: 'A', sel: 'x' }, { className: 'B', sel: 'x' }] });
  assert.equal(ambiguous.status, 'likely');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ownerEvidence({ className: 'A', sel: 'x' }).status, 'confirmed');
  assert.equal(summaryEvidenceStatus({ summary: 'heuristic prose' }), 'likely');
  assert.equal(summaryEvidenceStatus({ summary: { text: 'fact', status: 'confirmed' } }), 'confirmed');
}

// #558: names/function starts keep provenance and manual rename is not Confirmed.
{
  const sym = new SymbolIndex({ addrs: new BigUint64Array([0x1000n]), kinds: new Uint8Array([0]), names: 'real', funcs: new BigUint64Array([0x1000n]), functionStartsExact: true });
  assert.equal(provenanceStatus(sym.functionEvidence(0x1000n)), 'confirmed');
  assert.equal(provenanceStatus(sym.nameEvidence(0x1000n)), 'confirmed');
  sym.rename(0x1000n, 'mine');
  assert.equal(provenanceStatus(sym.nameEvidence(0x1000n)), 'manual');
  sym.addFunctions([0x1100n], { source: 'heuristic', confidence: 0.55, confirmed: false });
  assert.equal(provenanceStatus(sym.functionEvidence(0x1100n)), 'likely');
}

// #553: result and estimated-heap budgets are global, not per-region.
{
  const b = new StringCollectionBudget({ inputBytes: 100, resultLimit: 2, estimatedHeapBytes: 1000 });
  assert.equal(b.requestBytes(80), 80);
  assert.equal(b.requestBytes(80), 20);
  assert.equal(b.accept('a'), true);
  assert.equal(b.accept('b'), true);
  assert.equal(b.accept('c'), false);
  assert.equal(b.truncationReason, 'result-budget');
}

// #552: one descriptor works for ELF/PE/Mach-O-style inputs without false Mach-O defaults.
{
  const elf = productDescriptor({ formatId: 'elf', productDescriptor: { formatId: 'elf', regions: [{ id: 'text' }], dependencies: ['libc.so.6'], imports: [{ library: 'libm.so.6' }], exports: [], formatMetadata: { arch: 'x86_64', bits: 64 } } }, null);
  assert.deepEqual(elf.dependencies, ['libc.so.6', 'libm.so.6']);
  assert.equal(elf.formatMetadata.arch, 'x86_64');
  assert.equal('hasCodeSignature' in elf.formatMetadata, false);
  const pe = productDescriptor({ formatId: 'pe', productDescriptor: { formatId: 'pe', regions: [], dependencies: ['KERNEL32.dll'], imports: [], exports: [], formatMetadata: { bits: 64 } } }, null);
  assert.deepEqual(pe.dependencies, ['KERNEL32.dll']);
  const macho = productDescriptor({ formatId: 'macho', slices: [{ info: { format: 'macho', dylibs: ['/usr/lib/libSystem.B.dylib'] }, regions: [] }] }, null);
  assert.deepEqual(macho.dependencies, ['/usr/lib/libSystem.B.dylib']);
}

// #550: indexed search is cancellable/top-N and no longer scans/materializes hundreds of thousands on each keystroke.
{
  const count = 25_000;
  const funcs = new BigUint64Array(count);
  const addrs = new BigUint64Array(count);
  const names = [];
  for (let i = 0; i < count; i++) { funcs[i] = 0x1000n + BigInt(i * 4); addrs[i] = funcs[i]; names.push(`Function_${i}`); }
  const sym = new SymbolIndex({ addrs, kinds: new Uint8Array(count), names: names.join('\n'), funcs, functionStartsExact: true });
  const app = { symbols: sym, codeRegion: () => ({ vmAddr: 0x1000n, size: BigInt(count * 4 + 4) }), store: { get: () => null } };
  const rows = await queryFunctions(app, 'Function_249', { limit: 10 });
  assert(rows.length <= 10 && rows.length > 0);
  const strings = Array.from({ length: 20_000 }, (_, i) => ({ text: `row-${i}`, addr: BigInt(i) }));
  const hits = await queryStrings(strings, 'row-199', { limit: 7 });
  assert(hits.length <= 7 && hits.length > 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => queryFunctions(app, 'not-found', { signal: controller.signal }), /aborted/i);
}

// #554/#555/#556 structural worker invariants: shared byte budget, counted transport,
// bounded candidate slots, and a single control-flow provenance contract for both scans.
{
  const budget = globalThis.HexWorkerBudget;
  assert.equal(budget.withinProgramBudget(budget.PROGRAM_INDEX_BYTES - 1, 1), true);
  assert.equal(budget.withinProgramBudget(budget.PROGRAM_INDEX_BYTES, 1), false);
  const source = fs.readFileSync(new URL('../js/worker-legacy.js', import.meta.url), 'utf8');
  assert.match(source, /candidate-memory-budget/);
  assert.match(source, /callCount: nCalls/);
  assert.match(source, /refCount: nRefs/);
  assert.doesNotMatch(source, /callFrom\.slice\(0, nCalls\)/);
  assert.match(source, /makeAddressProvenance\(\)/g);
  assert.match(source, /isAddressFlowBarrier/);
  assert.match(source, /pathOf/);
}

console.log('issues 550-559 regressions: ok');
''')

package = json.loads(read('package.json'))
if 'node tests/issues-550-559.mjs' not in package['scripts']['test']:
    package['scripts']['test'] = 'node tests/issues-550-559.mjs && ' + package['scripts']['test']
write('package.json', json.dumps(package, ensure_ascii=False, indent=2) + '\n')

print('Applied fixes for #550-#559')
