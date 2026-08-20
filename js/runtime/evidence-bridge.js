import { createEvidenceEdge, createEvidenceNode, EvidenceGraph, EVIDENCE_COMPLETENESS } from '../core/evidence/index.js';
import { createEvidenceId, deepFreeze, stableDigest } from '../core/identity/index.js';
import { createOriginSet } from '../core/identity/origin.js';
import { DebugAdapterError } from '../debug/adapter.js';
import { createRuntimeEvent } from './events.js';

const RELATIONS = Object.freeze(['supports', 'contradicts', 'refines']);
const COMPLETENESS_RANK = Object.freeze({ unsupported: 0, truncated: 1, partial: 2, bounded: 3, complete: 4 });

function required(value, code, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function stringArray(value, name) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new DebugAdapterError('runtime-invalid-array', `${name} must be an array`);
  return Object.freeze([...new Set(value.map(String).filter(Boolean))].sort());
}

function completeness(value, fallback = 'partial') {
  const normalized = String(value ?? fallback);
  if (!EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${normalized}`);
  return normalized;
}

export function conservativeCompleteness(...values) {
  const normalized = values.filter((value) => value != null).map((value) => completeness(value));
  if (!normalized.length) return 'partial';
  return normalized.reduce((worst, value) => COMPLETENESS_RANK[value] < COMPLETENESS_RANK[worst] ? value : worst, normalized[0]);
}

export function createInterventionRecord(input = {}) {
  const runtimeSessionId = required(input.runtimeSessionId, 'runtime-session-id-required', 'intervention requires runtimeSessionId');
  const providerId = required(input.providerId, 'runtime-provider-required', 'intervention requires providerId');
  const kind = required(input.kind, 'runtime-intervention-kind-required', 'intervention kind is required');
  const identity = {
    runtimeSessionId,
    providerId,
    kind,
    target: input.target ?? null,
    requestedChange: input.requestedChange ?? null,
    sequence: input.sequence ?? null,
    parentInterventionIds: input.parentInterventionIds ?? [],
  };
  return deepFreeze({
    interventionId: String(input.interventionId || `intervention_${stableDigest(identity)}`),
    runtimeSessionId,
    providerId,
    kind,
    target: input.target ?? null,
    requestedChange: input.requestedChange ?? null,
    acknowledgedResult: input.acknowledgedResult ?? null,
    sequence: input.sequence == null ? null : Number(input.sequence),
    parentInterventionIds: stringArray(input.parentInterventionIds, 'parentInterventionIds'),
    evidenceIds: stringArray(input.evidenceIds, 'evidenceIds'),
  });
}

export class InterventionLedger {
  #records = new Map();

  add(input) {
    const record = createInterventionRecord(input);
    const existing = this.#records.get(record.interventionId);
    if (existing) return existing;
    for (const parent of record.parentInterventionIds) {
      if (!this.#records.has(parent)) throw new DebugAdapterError('runtime-intervention-parent-missing', `intervention parent not found: ${parent}`);
    }
    this.#records.set(record.interventionId, record);
    return record;
  }

  get(id) { return this.#records.get(String(id)) || null; }
  all() { return Object.freeze([...this.#records.values()]); }

  ancestry(ids = []) {
    const out = new Map();
    const visit = (id) => {
      const record = this.get(id);
      if (!record || out.has(record.interventionId)) return;
      out.set(record.interventionId, record);
      for (const parent of record.parentInterventionIds) visit(parent);
    };
    for (const id of ids) visit(id);
    return Object.freeze([...out.values()]);
  }
}

function linkableResolution(resolution) {
  return !!resolution && (resolution.state === 'exact' || resolution.state === 'resolved') && Array.isArray(resolution.targetEntityIds) && resolution.targetEntityIds.length > 0;
}

function resolutionCompleteness(resolution) {
  if (!resolution) return 'partial';
  if (resolution.state === 'exact') return 'complete';
  if (resolution.state === 'resolved') return 'bounded';
  if (resolution.state === 'ambiguous' || resolution.state === 'unresolved') return 'partial';
  if (resolution.state === 'mismatch') return 'unsupported';
  return 'partial';
}

export class RuntimeEvidenceBridge {
  constructor({ graph = null, interventions = null } = {}) {
    this.graph = graph instanceof EvidenceGraph ? graph : new EvidenceGraph();
    this.interventions = interventions instanceof InterventionLedger ? interventions : new InterventionLedger();
  }

  eventToEvidence(eventInput, resolution = null, options = {}) {
    const event = createRuntimeEvent(eventInput);
    const binaryId = resolution?.binaryId ?? options.binaryId ?? null;
    const targetEntityIds = linkableResolution(resolution) ? resolution.targetEntityIds : [];
    const interventionRecords = this.interventions.ancestry(event.interventionIds);
    const evidenceId = createEvidenceId({
      binaryId,
      kind: 'runtime-event',
      sourceId: event.eventId,
      identity: {
        runtimeSessionId: event.runtimeSessionId,
        providerId: event.providerId,
        moduleBindingKey: event.moduleBindingKey,
        moduleGeneration: event.moduleGeneration,
        resolutionState: resolution?.state ?? 'unresolved',
      },
    });
    const evidence = createEvidenceNode({
      id: evidenceId,
      family: 'RuntimeEvidence',
      binaryId,
      targetEntityIds,
      semanticKind: options.semanticKind ?? event.kind,
      completeness: conservativeCompleteness(event.completeness, resolutionCompleteness(resolution)),
      confidence: options.confidence == null ? null : Number(options.confidence),
      deterministic: false,
      origin: createOriginSet({ parentEntityIds: targetEntityIds }),
      payload: {
        runtimeSessionId: event.runtimeSessionId,
        providerId: event.providerId,
        providerVersion: event.providerVersion,
        sessionEpoch: event.sessionEpoch,
        streamId: event.streamId,
        sequence: event.sequence,
        processKey: event.processKey,
        threadKey: event.threadKey,
        moduleBindingKey: event.moduleBindingKey,
        moduleGeneration: event.moduleGeneration,
        observationMode: event.observationMode,
        eventKind: event.kind,
        eventPayload: event.payload,
        interventionIds: interventionRecords.map((record) => record.interventionId),
        resolution: resolution ? {
          state: resolution.state,
          method: resolution.method,
          staticAddress: resolution.staticAddress,
          functionMatchId: resolution.functionMatchId,
          evidenceIds: resolution.evidenceIds,
        } : { state: 'unresolved', method: 'no-resolution' },
      },
      createdAt: event.timestamp,
    });
    this.graph.addNode(evidence);
    return evidence;
  }

  linkClaim(claimId, evidenceId, relation, resolution = null) {
    const type = String(relation);
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);
    if (!linkableResolution(resolution)) {
      return deepFreeze({ linked: false, reason: resolution?.state === 'mismatch' ? 'identity-mismatch' : 'static-resolution-required', claimId: String(claimId), evidenceId: String(evidenceId), relation: type });
    }
    const claim = this.graph.getNode(claimId);
    const evidence = this.graph.getNode(evidenceId);
    if (!claim || claim.family !== 'Claim') throw new DebugAdapterError('runtime-claim-not-found', `claim not found: ${claimId}`);
    if (!evidence || evidence.family !== 'RuntimeEvidence') throw new DebugAdapterError('runtime-evidence-not-found', `runtime evidence not found: ${evidenceId}`);
    const edge = createEvidenceEdge({ type, from: claim.id, to: evidence.id, metadata: { resolutionState: resolution.state, method: resolution.method ?? null } });
    this.graph.addEdge(edge);
    return deepFreeze({ linked: true, edge });
  }
}

export const RUNTIME_EVIDENCE_RELATIONS = RELATIONS;
