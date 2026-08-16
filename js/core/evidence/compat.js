import { createEvidenceNode, EvidenceGraph } from './index.js';
import { createOriginSet } from '../identity/origin.js';

function familyFor(record = {}) {
  const text = `${record.sourceTool || record.source || ''} ${record.kind || ''}`.toLowerCase();
  if (text.includes('runtime') || record.source === 'runtime') return 'RuntimeEvidence';
  if (text.includes('symbolic') || text.includes('solver')) return 'SymbolicEvidence';
  if (text.includes('signature') || text.includes('fingerprint')) return 'SignatureEvidence';
  if (text.includes('type')) return 'TypeEvidence';
  if (text.includes('cfg') || text.includes('branch') || text.includes('control')) return 'ControlFlowEvidence';
  if (text.includes('dataflow') || text.includes('alias') || text.includes('reaching')) return 'DataflowEvidence';
  if (text.includes('decode') || text.includes('instruction')) return 'DecodeEvidence';
  if (text.includes('knowledge') || text.includes('external')) return 'KnowledgeEvidence';
  if (text.includes('binary') || text.includes('loader')) return 'BinaryEvidence';
  return 'SemanticEvidence';
}

function targetIds(record = {}) {
  return [record.entityId, record.functionId, record.instructionId].filter((value) => value != null).map(String);
}

export function legacyAiEvidenceToCanonical(record = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('evidence-compat-invalid-ai-record');
  return createEvidenceNode({
    id: String(record.id || '').trim(),
    family: familyFor(record),
    binaryId: record.binaryId ?? record.binaryHash ?? null,
    targetEntityIds: targetIds(record),
    semanticKind: record.kind ?? 'legacy-ai-evidence',
    completeness: record.completeness ?? 'partial',
    confidence: Number.isFinite(record.confidence) ? record.confidence : null,
    deterministic: record.status === 'verified',
    origin: createOriginSet({
      instructionIds: record.instructionId ? [record.instructionId] : [],
      parentEntityIds: targetIds(record),
    }),
    payload: {
      legacySystem: 'ai-evidence-store',
      status: record.status ?? 'unknown',
      title: record.title ?? null,
      sourceTool: record.sourceTool ?? null,
      sourceId: record.sourceId ?? null,
      sourceRef: record.sourceRef ?? null,
      sourceBinding: record.sourceBinding ?? null,
      address: record.address ?? null,
      functionAddress: record.functionAddress ?? null,
      functionName: record.functionName ?? null,
      summary: record.summary ?? null,
      navigation: record.navigation ?? null,
      sourceData: record.sourceData ?? null,
    },
    createdAt: record.timestamp ?? null,
  });
}

export function runtimeEvidenceToCanonical(record = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('evidence-compat-invalid-runtime-record');
  return createEvidenceNode({
    id: String(record.id || '').trim(),
    family: 'RuntimeEvidence',
    binaryId: record.binaryId ?? record.binaryHash ?? null,
    targetEntityIds: targetIds(record),
    semanticKind: record.kind ?? 'runtime-observation',
    completeness: record.completeness ?? (record.observationComplete === false ? 'truncated' : 'partial'),
    confidence: Number.isFinite(record.confidence) ? record.confidence : null,
    deterministic: false,
    origin: createOriginSet({ parentEntityIds: targetIds(record) }),
    payload: {
      legacySystem: 'runtime-evidence',
      verdict: record.verdict ?? 'unknown',
      backend: record.backend ?? null,
      binaryHash: record.binaryHash ?? null,
      sliceIdentity: record.sliceIdentity ?? null,
      function: record.function ?? null,
      address: record.address ?? null,
      input: record.input ?? null,
      initialState: record.initialState ?? null,
      observedState: record.observedState ?? null,
      branchPath: record.branchPath ?? [],
      sessionId: record.sessionId ?? null,
      reproducibility: record.reproducibility ?? null,
      provenance: record.provenance ?? null,
    },
    createdAt: record.timestamp ?? null,
  });
}

export function evidenceStoreToCanonicalGraph(store) {
  const records = store && typeof store.all === 'function' ? store.all() : [];
  return new EvidenceGraph({ nodes: records.map(legacyAiEvidenceToCanonical) });
}

export function legacyEvidenceToCanonicalGraph({ aiEvidence = [], runtimeEvidence = [] } = {}) {
  const graph = new EvidenceGraph();
  for (const record of aiEvidence) graph.addNode(legacyAiEvidenceToCanonical(record));
  for (const record of runtimeEvidence) graph.addNode(runtimeEvidenceToCanonical(record));
  return graph;
}

export function canonicalEvidenceToLegacyAi(node) {
  const canonical = createEvidenceNode(node);
  if (canonical.family === 'Claim') throw new TypeError('evidence-compat-claim-not-ai-record');
  const payload = canonical.payload || {};
  return {
    id: canonical.id,
    kind: payload.semanticKind || canonical.semanticKind || 'observation',
    status: canonical.deterministic ? 'verified' : (payload.status === 'hypothesis' ? 'hypothesis' : 'supported'),
    title: payload.title || canonical.semanticKind || canonical.family,
    sourceTool: payload.sourceTool || 'core-evidence',
    confidence: canonical.confidence == null ? undefined : canonical.confidence,
    timestamp: canonical.createdAt || undefined,
    summary: payload.summary || undefined,
  };
}
