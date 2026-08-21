import { deepFreeze, jsonSafe, stableStringify } from '../identity/index.js';
import { createOriginSet } from '../identity/origin.js';

export const EVIDENCE_NODE_FAMILIES = Object.freeze([
  'BinaryEvidence',
  'DecodeEvidence',
  'SemanticEvidence',
  'DataflowEvidence',
  'TypeEvidence',
  'ControlFlowEvidence',
  'SignatureEvidence',
  'KnowledgeEvidence',
  'SymbolicEvidence',
  'RuntimeEvidence',
  'UserEvidence',
  'Claim',
]);

export const EVIDENCE_EDGE_FAMILIES = Object.freeze([
  'derived-from',
  'supports',
  'contradicts',
  'refines',
  'observed-at',
  'originates-from',
  'verified-by',
  'matched-by',
  'supersedes',
]);

export const EVIDENCE_VERDICTS = Object.freeze([
  'confirmed',
  'supported',
  'unverified',
  'contradicted',
  'unknown',
]);

export const EVIDENCE_COMPLETENESS = Object.freeze([
  'complete',
  'bounded',
  'partial',
  'truncated',
  'unsupported',
]);

function fail(code) { throw new TypeError(code); }
function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function stringArray(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return [...new Set(value.map(String).filter(Boolean))].sort();
}
function safeArray(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return value;
}
function graphLimit(value, code) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail(code);
  return n;
}
function confidence(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) fail('evidence-invalid-confidence');
  return n;
}
function enumValue(value, allowed, fallback, code) {
  const normalized = value == null ? fallback : String(value);
  if (!allowed.includes(normalized)) fail(code);
  return normalized;
}

export function createEvidenceNode(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('evidence-invalid-node');
  const family = enumValue(input.family, EVIDENCE_NODE_FAMILIES, null, 'evidence-invalid-family');
  if (family === 'Claim') return createClaimNode(input);
  const node = {
    id: required(input.id, 'evidence-id-required'),
    family,
    binaryId: input.binaryId == null ? null : String(input.binaryId),
    targetEntityIds: stringArray(input.targetEntityIds, 'evidence-invalid-targets'),
    semanticKind: input.semanticKind == null ? null : String(input.semanticKind),
    completeness: enumValue(input.completeness, EVIDENCE_COMPLETENESS, 'partial', 'evidence-invalid-completeness'),
    confidence: confidence(input.confidence),
    deterministic: input.deterministic === true,
    origin: createOriginSet(input.origin ?? {}),
    payload: jsonSafe(input.payload ?? {}),
    createdAt: input.createdAt == null ? null : String(input.createdAt),
  };
  return deepFreeze(node);
}

export function createClaimNode(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('evidence-invalid-claim');
  const supportingEvidenceIds = stringArray(input.supportingEvidenceIds, 'evidence-invalid-support-ids');
  const contradictingEvidenceIds = stringArray(input.contradictingEvidenceIds, 'evidence-invalid-contradiction-ids');
  const confirmedByEvidenceIds = stringArray(input.confirmedByEvidenceIds, 'evidence-invalid-confirmation-ids');
  const requestedVerdict = enumValue(input.verdict, EVIDENCE_VERDICTS, 'unknown', 'evidence-invalid-verdict');
  let verdict = requestedVerdict;
  if (contradictingEvidenceIds.length || requestedVerdict === 'contradicted') verdict = 'contradicted';
  else if (requestedVerdict === 'confirmed') verdict = supportingEvidenceIds.length || confirmedByEvidenceIds.length ? 'supported' : 'unverified';
  else if (requestedVerdict === 'supported' && !supportingEvidenceIds.length) verdict = 'unverified';
  const targetEntityIds = stringArray(input.targetEntityIds, 'evidence-invalid-targets');
  const scope = input.scope == null ? null : jsonSafe(input.scope);
  if (!targetEntityIds.length && scope == null) fail('evidence-claim-target-required');
  const semanticKind = required(input.semanticKind, 'evidence-claim-semantic-kind-required');
  return deepFreeze({
    id: required(input.id, 'evidence-id-required'),
    family: 'Claim',
    binaryId: input.binaryId == null ? null : String(input.binaryId),
    targetEntityIds,
    scope,
    semanticKind,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    confirmedByEvidenceIds,
    assumptions: jsonSafe(safeArray(input.assumptions, 'evidence-invalid-assumptions')),
    completeness: enumValue(input.completeness, EVIDENCE_COMPLETENESS, 'partial', 'evidence-invalid-completeness'),
    verdict,
    confidence: confidence(input.confidence),
    origin: createOriginSet(input.origin ?? {}),
    payload: jsonSafe(input.payload ?? {}),
    createdAt: input.createdAt == null ? null : String(input.createdAt),
  });
}

export function createEvidenceEdge(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('evidence-invalid-edge');
  return deepFreeze({
    type: enumValue(input.type, EVIDENCE_EDGE_FAMILIES, null, 'evidence-invalid-edge-family'),
    from: required(input.from, 'evidence-edge-from-required'),
    to: required(input.to, 'evidence-edge-to-required'),
    metadata: jsonSafe(input.metadata ?? {}),
  });
}

function equalValue(a, b) { return stableStringify(a) === stableStringify(b); }

export function canConfirmClaim(evidence, claim) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (evidence.deterministic !== true) return false;
  if (evidence.completeness === 'unsupported' || evidence.completeness === 'truncated' || evidence.completeness === 'partial') {
    return false;
  }
  return true;
}

export class EvidenceGraph {
  #nodes = new Map();
  #edges = [];
  #edgeKeys = new Set();
  #maxNodes = 500_000;
  #maxEdges = 1_000_000;

  constructor(initial = {}, { maxNodes = 500_000, maxEdges = 1_000_000, signal = null } = {}) {
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)) fail('evidence-invalid-graph');
    this.#maxNodes = graphLimit(maxNodes, 'evidence-graph-node-budget-invalid');
    this.#maxEdges = graphLimit(maxEdges, 'evidence-graph-edge-budget-invalid');
    const nodes = safeArray(initial.nodes, 'evidence-invalid-nodes');
    const edges = safeArray(initial.edges, 'evidence-invalid-edges');
    if (nodes.length > this.#maxNodes) fail('evidence-graph-node-budget-exceeded');
    if (edges.length > this.#maxEdges) fail('evidence-graph-edge-budget-exceeded');
    for (let i = 0; i < nodes.length; i++) {
      if (i % 1000 === 0 && signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      this.addNode(nodes[i]);
    }
    for (let i = 0; i < edges.length; i++) {
      if (i % 1000 === 0 && signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      this.addEdge(edges[i]);
    }
  }

  addNode(input) {
    if (this.#nodes.size >= this.#maxNodes && !this.#nodes.has(input?.id)) {
      fail('evidence-graph-node-budget-exceeded');
    }
    const node = createEvidenceNode(input);
    const existing = this.#nodes.get(node.id);
    if (existing) {
      if (!equalValue(existing, node)) fail('evidence-id-conflict');
      return existing;
    }
    this.#nodes.set(node.id, node);
    return node;
  }

  addEdge(input) {
    const edge = createEvidenceEdge(input);
    const key = stableStringify(edge);
    if (!this.#edgeKeys.has(key)) {
      if (this.#edges.length >= this.#maxEdges) fail('evidence-graph-edge-budget-exceeded');
      this.#edgeKeys.add(key);
      this.#edges.push(edge);
    }
    return edge;
  }

  getNode(id) { return this.#nodes.get(String(id)) || null; }
  hasNode(id) { return this.#nodes.has(String(id)); }
  allNodes() { return Array.from(this.#nodes.values()); }
  allEdges() { return this.#edges.slice(); }

  unresolvedReferences() {
    const missing = new Set();
    for (const edge of this.#edges) {
      if (!this.#nodes.has(edge.from)) missing.add(edge.from);
      if (!this.#nodes.has(edge.to)) missing.add(edge.to);
    }
    for (const node of this.#nodes.values()) {
      if (node.family !== 'Claim') continue;
      for (const id of [...node.supportingEvidenceIds, ...node.contradictingEvidenceIds, ...node.confirmedByEvidenceIds]) {
        if (!this.#nodes.has(id)) missing.add(id);
      }
    }
    return Array.from(missing).sort();
  }

  evaluateClaim(id) {
    const claim = this.getNode(id);
    if (!claim || claim.family !== 'Claim') {
      return deepFreeze({ verdict: 'unknown', claimId: String(id), supportingEvidenceIds: [], contradictingEvidenceIds: [], confirmedByEvidenceIds: [], missingEvidenceIds: [String(id)] });
    }
    const supporting = new Set(claim.supportingEvidenceIds);
    const contradicting = new Set(claim.contradictingEvidenceIds);
    const confirmedBy = new Set(claim.confirmedByEvidenceIds);
    for (const edge of this.#edges) {
      if (edge.from !== claim.id) continue;
      if (edge.type === 'supports') supporting.add(edge.to);
      else if (edge.type === 'contradicts') contradicting.add(edge.to);
      else if (edge.type === 'verified-by') confirmedBy.add(edge.to);
    }
    const missingEvidenceIds = new Set();
    for (const evidenceId of [...supporting, ...contradicting, ...confirmedBy]) {
      if (!this.#nodes.has(evidenceId)) missingEvidenceIds.add(evidenceId);
    }
    const knownContradictions = [...contradicting].filter((evidenceId) => this.#nodes.has(evidenceId));
    const knownSupport = [...supporting].filter((evidenceId) => this.#nodes.has(evidenceId));
    const deterministicConfirmations = [...confirmedBy].filter((evidenceId) => {
      const node = this.#nodes.get(evidenceId);
      return canConfirmClaim(node, claim);
    });
    let verdict = claim.verdict;
    if (knownContradictions.length || claim.verdict === 'contradicted') verdict = 'contradicted';
    else if (deterministicConfirmations.length) verdict = 'confirmed';
    else if (knownSupport.length) verdict = 'supported';
    else if (supporting.size || confirmedBy.size || claim.verdict === 'unverified') verdict = 'unverified';
    else verdict = 'unknown';
    return deepFreeze({
      verdict,
      claimId: claim.id,
      supportingEvidenceIds: Array.from(supporting).sort(),
      contradictingEvidenceIds: Array.from(contradicting).sort(),
      confirmedByEvidenceIds: Array.from(confirmedBy).sort(),
      missingEvidenceIds: Array.from(missingEvidenceIds).sort(),
      completeness: claim.completeness,
    });
  }

  toJSON() {
    return {
      schemaVersion: 1,
      nodes: this.allNodes().map((node) => jsonSafe(node)),
      edges: this.allEdges().map((edge) => jsonSafe(edge)),
    };
  }

  static fromJSON(value, options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('evidence-invalid-graph');
    if (value.schemaVersion != null && Number(value.schemaVersion) !== 1) fail('evidence-schema-mismatch');
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) fail('evidence-invalid-graph');
    return new EvidenceGraph({ nodes: value.nodes, edges: value.edges }, options);
  }
}
