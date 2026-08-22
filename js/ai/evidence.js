import { EVIDENCE_STATUSES } from './schema.js';
import { addressText, jsonSafe } from './validation.js';
import { evidenceStoreToCanonicalGraph } from '../core/evidence/compat.js';
import { stableDigest } from '../core/identity/index.js';

const DETERMINISTIC_VERIFICATION = Symbol('deterministic-verification');

const SEMANTIC_SOURCE_KEYS = Object.freeze([
  'id', 'kind', 'status', 'address', 'addr', 'functionAddress', 'function', 'row', 'instructionId',
  'operation', 'relation', 'location', 'source', 'sink', 'value', 'threshold', 'condition', 'operator',
  'name', 'selector', 'signature', 'confidence', 'verified', 'reason', 'evidence', 'verification',
]);

function compactSource(value) {
  const safe = jsonSafe(value);
  const text = JSON.stringify(safe);
  if (text.length <= 4096) return safe;
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return { oversized: true, bytes: text.length, type: Array.isArray(safe) ? 'array' : typeof safe };
  const semantic = {};
  for (const key of SEMANTIC_SOURCE_KEYS) if (safe[key] !== undefined) semantic[key] = safe[key];
  return { oversized: true, bytes: text.length, semantic };
}

function firstAddress(value) {
  if (!value || typeof value !== 'object') return null;
  return addressText(value.functionAddress ?? value.function ?? value.address ?? value.addr ?? value.target);
}

function factRows(result) {
  const rows = [];
  for (const key of ['results', 'updates', 'sites', 'functions', 'paths', 'causalPaths']) {
    const values = Array.isArray(result && result[key]) ? result[key] : [];
    values.forEach((row, index) => rows.push({ key, index, row }));
  }
  if (!rows.length && result && typeof result === 'object') rows.push({ key: 'result', index: null, row: result });
  return rows;
}

function evidenceIds(row) {
  const ids = new Set();
  if (row && typeof row.id === 'string') ids.add(row.id);
  for (const id of Array.isArray(row && row.evidence) ? row.evidence : []) {
    if (typeof id === 'string') ids.add(id);
    else if (id && typeof id.id === 'string') ids.add(id.id);
  }
  return Array.from(ids);
}

function verifiedEvidenceIds(value) {
  const ids = new Set();
  const add = (entry) => {
    if (typeof entry === 'string' && entry) ids.add(entry);
    else if (entry && typeof entry.id === 'string') ids.add(entry.id);
  };
  for (const key of ['verifiedEvidenceIds', 'verifiedEvidence', 'verifiedIds']) {
    for (const entry of Array.isArray(value && value[key]) ? value[key] : []) add(entry);
  }
  for (const entry of Array.isArray(value?.verification?.evidenceIds) ? value.verification.evidenceIds : []) add(entry);
  return ids;
}

function semanticRecord(record) {
  if (!record) return null;
  return jsonSafe({
    id: record.id,
    kind: record.kind,
    title: record.title,
    sourceTool: record.sourceTool,
    sourceBinding: record.sourceBinding || null,
    address: record.address || null,
    functionAddress: record.functionAddress || null,
    functionName: record.functionName || null,
    summary: record.summary || null,
    sourceData: record.sourceData ?? null,
    navigation: record.navigation ?? null,
  });
}

function sameSemanticRecord(left, right) {
  return JSON.stringify(semanticRecord(left)) === JSON.stringify(semanticRecord(right));
}

function normalizeSourceRef(sourceRef) {
  if (!sourceRef) return null;
  if (typeof sourceRef === 'string') return { detailRef: sourceRef, path: '$' };
  if (typeof sourceRef !== 'object') return null;
  if (sourceRef.detailRef) return {
    detailRef: String(sourceRef.detailRef),
    path: String(sourceRef.path || '$'),
    ...(sourceRef.bindingKey ? { bindingKey: String(sourceRef.bindingKey) } : {}),
  };
  if (sourceRef.evidenceSourceId) return { evidenceSourceId: String(sourceRef.evidenceSourceId), path: String(sourceRef.path || '$') };
  return null;
}

export class EvidenceStore {
  constructor(initial = [], options = {}) {
    if (!Array.isArray(initial) && initial && typeof initial === 'object') {
      options = initial;
      initial = [];
    }
    this.records = new Map();
    this.sourcePayloads = new Map();
    this.observationStore = options.observationStore || null;
    for (const evidence of initial) this.add(evidence);
  }

  setObservationStore(store) {
    this.observationStore = store || null;
    if (this.observationStore) {
      for (const record of this.records.values()) {
        const sourceId = record.sourceRef?.evidenceSourceId;
        if (sourceId && this.sourcePayloads.has(sourceId)) {
          const stored = this.observationStore.put({
            tool: record.sourceTool || 'evidence-source', arguments: { evidenceId: record.id },
            fullResult: this.sourcePayloads.get(sourceId), functionIdentity: record.functionAddress ?? record.address ?? null, deterministic: true,
          });
          record.sourceRef = { detailRef: stored.id, path: record.sourceRef.path || '$', bindingKey: stored.binding.key };
          record.sourceBinding = stored.binding.key;
          this.sourcePayloads.delete(sourceId);
        }
        if (record.sourceRef?.detailRef) this.observationStore.pin?.(record.sourceRef.detailRef);
      }
    }
    return this;
  }

  add(input, authority = null) {
    if (!input || typeof input !== 'object') return null;
    let status = EVIDENCE_STATUSES.includes(input.status) ? input.status : 'unknown';
    if (status === 'verified' && authority !== DETERMINISTIC_VERIFICATION) status = 'supported';

    let sourceRef = normalizeSourceRef(input.sourceRef);
    if (!sourceRef && input.sourceData != null) {
      if (this.observationStore) {
        const stored = this.observationStore.put({
          tool: input.sourceTool || 'evidence-source',
          arguments: { sourceId: input.sourceId || null, evidenceKind: input.kind || 'observation' },
          fullResult: input.sourceData,
          functionIdentity: input.functionAddress ?? input.address ?? null,
          deterministic: true,
        });
        sourceRef = { detailRef: stored.id, path: '$', bindingKey: stored.binding.key };
      } else {
        // Same reasoning as the record id below: this is a Map key, so a 32-bit
        // collision would overwrite a stored payload rather than add one.
        const localId = `evsrc_${stableDigest([input.sourceTool || 'unknown', input.sourceId || null, Date.now(), this.sourcePayloads.size]).slice(0, 32)}`;
        this.sourcePayloads.set(localId, input.sourceData);
        sourceRef = { evidenceSourceId: localId, path: '$' };
      }
    }
    const sourceBinding = String(input.sourceBinding ?? sourceRef?.bindingKey ?? '');
    const identity = JSON.stringify(jsonSafe([
      input.sourceTool || 'unknown', input.sourceId || null, sourceBinding || null, input.address || null,
      input.functionAddress || null, input.kind || 'observation', input.title || '',
    ]));
    // The automatic id is a permanent record key: proposals, verification and
    // navigation all resolve evidence through it, and `add()` merges into an
    // existing key. A 32-bit hash is not enough to carry that — distinct
    // identities collided in practice (#1302), silently folding the second
    // record into the first and losing evidence. This is the same 128-bit
    // digest the symbolic evidence graph already derives its ids from.
    const id = String(input.id || `ev_${stableDigest(identity).slice(0, 32)}`);
    const record = {
      id,
      kind: String(input.kind || 'observation'),
      status,
      title: String(input.title || input.kind || 'Tool evidence').slice(0, 300),
      sourceTool: String(input.sourceTool || 'unknown'),
    };
    if (sourceBinding) record.sourceBinding = sourceBinding;
    if (sourceRef) record.sourceRef = sourceRef;
    const address = addressText(input.address);
    const functionAddress = addressText(input.functionAddress);
    if (address) record.address = address;
    if (functionAddress) record.functionAddress = functionAddress;
    if (input.functionName) record.functionName = String(input.functionName).slice(0, 500);
    if (input.summary) record.summary = String(input.summary).slice(0, 2000);
    if (input.sourceData != null) record.sourceData = compactSource(input.sourceData);
    if (Number.isFinite(input.confidence)) record.confidence = Math.max(0, Math.min(1, input.confidence));
    record.timestamp = input.timestamp || new Date().toISOString();
    if (input.navigation) record.navigation = jsonSafe(input.navigation);

    const previous = this.records.get(id);
    // Verified evidence is immutable. A model cannot recycle a verified id for
    // different semantic content or a different binary/revision binding.
    if (previous?.status === 'verified') {
      if (!sameSemanticRecord(previous, record)) return previous;
      return previous;
    }
    this.records.set(id, { ...previous, ...record });
    const storedRecord = this.records.get(id);
    if (storedRecord?.sourceRef?.detailRef) this.observationStore?.pin?.(storedRecord.sourceRef.detailRef);
    return storedRecord;
  }

  /* Verification authority is private local state. Tool names, model prose,
     status strings and supplied evidence ids never grant verified authority. */
  ingest(toolName, result, { verifier = false, sourceRef = null } = {}) {
    const output = result && result.result != null ? result.result : result;
    if (!output || typeof output !== 'object') return [];
    const rootSourceRef = normalizeSourceRef(sourceRef);
    const outputVerifiedIds = verifiedEvidenceIds(output);
    const rows = factRows(output);
    const created = [];
    for (const { key, index, row } of rows) {
      if (!row || typeof row !== 'object') continue;
      const ids = evidenceIds(row);
      if (!ids.length && key === 'result' && !firstAddress(row) && !output.evidence) continue;
      const addr = firstAddress(row) || firstAddress(output);
      const fnAddr = addressText(row.functionAddress ?? row.function ?? output.functionAddress ?? output.address);
      const sourceIds = ids.length ? ids : (Array.isArray(output.evidence) ? output.evidence.filter((x) => typeof x === 'string') : []);
      const rowVerifiedIds = verifiedEvidenceIds(row);
      const rowVerdict = row.verified === true || row.status === 'verified' || row.verification?.verified === true;
      const singleTopLevelVerdict = rows.length === 1 && key === 'result' && (output.verified === true || output.status === 'verified');
      const rowSourceRef = rootSourceRef ? {
        ...rootSourceRef,
        path: key === 'result' ? (rootSourceRef.path || '$') : `${rootSourceRef.path === '$' ? '$.' : `${rootSourceRef.path}.`}${key}[${index}]`,
      } : null;
      for (const sourceId of sourceIds.length ? sourceIds : [null]) {
        const sourceVerified = sourceId != null && (rowVerifiedIds.has(sourceId) || outputVerifiedIds.has(sourceId));
        const verified = verifier === true && (sourceVerified || rowVerdict || singleTopLevelVerdict);
        const status = verified ? 'verified' : 'supported';
        const kind = String(row.kind || key || 'observation');
        const evidence = this.add({
          sourceId, sourceTool: toolName, sourceRef: rowSourceRef, sourceBinding: rowSourceRef?.bindingKey,
          kind, status, address: addr, functionAddress: fnAddr,
          functionName: row.functionName || row.name || output.name,
          title: `${toolName}: ${kind}`,
          summary: summarizeRow(row), sourceData: row,
          confidence: Number.isFinite(row.confidence) ? row.confidence : (status === 'verified' ? 1 : 0.75),
          navigation: addr ? { address: addr } : undefined,
        }, verified ? DETERMINISTIC_VERIFICATION : null);
        if (evidence) created.push(evidence);
      }
    }
    return uniqueById(created);
  }

  ingestPlan(plan) {
    const out = [];
    for (const candidate of plan && plan.candidates || []) {
      const isVerifiedBest = !!(candidate.verification?.verified && plan.best && String(plan.best.address) === String(candidate.address));
      const explicitlyVerified = new Set([
        ...(candidate.verification?.evidenceIds || []),
        ...(candidate.verification?.verifiedEvidenceIds || []),
      ].map(String));
      for (const sourceId of candidate.evidence || []) {
        const verified = isVerifiedBest && explicitlyVerified.has(String(sourceId));
        out.push(this.add({
          sourceId, sourceTool: 'deterministic-goal-planner', kind: 'candidate-source', status: verified ? 'verified' : 'supported',
          functionAddress: candidate.address, functionName: candidate.name,
          title: `${verified ? 'Verified' : 'Ranked'} source for ${candidate.name || addressText(candidate.address)}`,
          summary: `Deterministic score ${candidate.score}; sources: ${(candidate.sources || []).join(', ')}`,
          sourceData: { score: candidate.score, sources: candidate.sources, sourceId }, confidence: verified ? 1 : 0.75,
        }, verified ? DETERMINISTIC_VERIFICATION : null));
      }
      if (isVerifiedBest) {
        out.push(this.add({
          sourceTool: 'deterministic-goal-planner',
          sourceId: `candidate:${addressText(candidate.address) || String(candidate.address)}`,
          kind: 'candidate-verification', status: 'verified',
          functionAddress: candidate.address, functionName: candidate.name,
          title: `Verified candidate ${candidate.name || addressText(candidate.address)}`,
          summary: `Deterministic verifier confirmed the candidate; score ${candidate.score}.`,
          sourceData: { score: candidate.score, sources: candidate.sources, verification: candidate.verification }, confidence: 1,
        }, DETERMINISTIC_VERIFICATION));
      }
    }
    return uniqueById(out.filter(Boolean));
  }

  sourceDataFor(id) {
    const record = typeof id === 'object' ? id : this.get(id);
    if (!record?.sourceRef?.evidenceSourceId) return null;
    return this.sourcePayloads.get(record.sourceRef.evidenceSourceId) ?? null;
  }

  has(id) { return this.records.has(String(id)); }
  get(id) { return this.records.get(String(id)) || null; }
  all() { return Array.from(this.records.values()); }
  pinned(ids) { return (ids || []).map((id) => this.get(id)).filter(Boolean); }
  hasAddress(value) {
    const address = addressText(value);
    return !!address && this.all().some((item) => item.address === address || item.functionAddress === address);
  }
  verifiedIds() { return this.all().filter((item) => item.status === 'verified').map((item) => item.id); }
  canonicalSnapshot() { return evidenceStoreToCanonicalGraph(this); }
}

function summarizeRow(row) {
  const parts = [];
  for (const key of ['kind', 'operation', 'relation', 'name', 'text', 'reason']) if (row[key] != null) parts.push(`${key}=${String(row[key]).slice(0, 300)}`);
  const addr = firstAddress(row);
  if (addr) parts.push(`address=${addr}`);
  return parts.join('; ').slice(0, 2000) || 'Deterministic tool observation';
}

function uniqueById(values) {
  return Array.from(new Map(values.map((value) => [value.id, value])).values());
}
