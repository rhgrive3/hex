import { EVIDENCE_STATUSES } from './schema.js';
import { addressText, jsonSafe } from './validation.js';

const DETERMINISTIC_VERIFICATION = Symbol('deterministic-verification');

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function compactSource(value) {
  const safe = jsonSafe(value);
  const text = JSON.stringify(safe);
  return text.length <= 4096 ? safe : { truncated: true, excerpt: text.slice(0, 4000) };
}

function firstAddress(value) {
  if (!value || typeof value !== 'object') return null;
  return addressText(value.functionAddress ?? value.function ?? value.address ?? value.addr ?? value.target);
}

function factRows(result) {
  const rows = [];
  for (const key of ['results', 'updates', 'sites', 'functions', 'paths', 'causalPaths']) {
    for (const row of Array.isArray(result && result[key]) ? result[key] : []) rows.push({ key, row });
  }
  if (!rows.length && result && typeof result === 'object') rows.push({ key: 'result', row: result });
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

export class EvidenceStore {
  constructor(initial = []) {
    this.records = new Map();
    for (const evidence of initial) this.add(evidence);
  }

  add(input, authority = null) {
    if (!input || typeof input !== 'object') return null;
    let status = EVIDENCE_STATUSES.includes(input.status) ? input.status : 'unknown';
    if (status === 'verified' && authority !== DETERMINISTIC_VERIFICATION) status = 'supported';
    const identity = JSON.stringify(jsonSafe([
      input.sourceTool || 'unknown', input.sourceId || null, input.address || null,
      input.functionAddress || null, input.kind || 'observation', input.title || '',
    ]));
    const id = String(input.id || `ev_${hashText(identity)}`);
    const record = {
      id,
      kind: String(input.kind || 'observation'),
      status,
      title: String(input.title || input.kind || 'Tool evidence').slice(0, 300),
      sourceTool: String(input.sourceTool || 'unknown'),
    };
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
    // A verified evidence id is an immutable provenance handle. Reusing it for
    // different content must never silently preserve the verified badge on new
    // data. Keep the original record intact; callers may create a fresh id.
    if (previous?.status === 'verified') {
      if (!sameSemanticRecord(previous, record)) return previous;
      return previous;
    }
    this.records.set(id, { ...previous, ...record });
    return this.records.get(id);
  }

  /* Verification authority comes from the local ToolRegistry definition, never
     from a model-visible tool name or an output field alone. A verifier must be
     explicitly registered by trusted application code. Verification is attached
     to a concrete row/evidence id; a top-level verdict is not bulk-propagated. */
  ingest(toolName, result, { verifier = false } = {}) {
    const output = result && result.result != null ? result.result : result;
    if (!output || typeof output !== 'object') return [];
    const outputVerifiedIds = verifiedEvidenceIds(output);
    const rows = factRows(output);
    const created = [];
    for (const { key, row } of rows) {
      if (!row || typeof row !== 'object') continue;
      const ids = evidenceIds(row);
      if (!ids.length && key === 'result' && !firstAddress(row) && !output.evidence) continue;
      const addr = firstAddress(row) || firstAddress(output);
      const fnAddr = addressText(row.functionAddress ?? row.function ?? output.functionAddress ?? output.address);
      const sourceIds = ids.length ? ids : (Array.isArray(output.evidence) ? output.evidence.filter((x) => typeof x === 'string') : []);
      const rowVerifiedIds = verifiedEvidenceIds(row);
      const rowVerdict = row.verified === true || row.status === 'verified' || row.verification?.verified === true;
      const singleTopLevelVerdict = rows.length === 1 && key === 'result' && (output.verified === true || output.status === 'verified');
      for (const sourceId of sourceIds.length ? sourceIds : [null]) {
        const sourceVerified = sourceId != null && (rowVerifiedIds.has(sourceId) || outputVerifiedIds.has(sourceId));
        const verified = verifier === true && (sourceVerified || rowVerdict || singleTopLevelVerdict);
        const status = verified ? 'verified' : 'supported';
        const kind = String(row.kind || key || 'observation');
        const evidence = this.add({
          sourceId, sourceTool: toolName, kind, status,
          address: addr, functionAddress: fnAddr,
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
      // Preserve the verified candidate verdict as its own evidence instead of
      // upgrading every supporting source that happened to participate.
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

  has(id) { return this.records.has(String(id)); }
  get(id) { return this.records.get(String(id)) || null; }
  all() { return Array.from(this.records.values()); }
  pinned(ids) { return (ids || []).map((id) => this.get(id)).filter(Boolean); }
  hasAddress(value) {
    const address = addressText(value);
    return !!address && this.all().some((item) => item.address === address || item.functionAddress === address);
  }
  verifiedIds() { return this.all().filter((item) => item.status === 'verified').map((item) => item.id); }
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
