import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { createOperationIdentity, assertIdentityMatch } from '../phase12/identity.js';

export const CHANGELOG_SCHEMA_VERSION = 'hex-project-operation-v1';
export const CHECKPOINT_SCHEMA_VERSION = 'hex-project-checkpoint-v1';
const MEANINGFUL_FACTS = new Set(['name', 'type', 'struct', 'confirmation', 'patch']);

function required(value, code) { const text = String(value ?? '').trim(); if (!text) throw new TypeError(code); return text; }
function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {}; for (const [key, item] of Object.entries(value)) out[key] = clone(item); return out;
}
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function factKey(target, kind) { return `${target}\u0000${kind}`; }
function payloadDigest(value) { return stableDigest(value); }

export function createProjectOperation(input = {}) {
  if (input.schemaVersion != null && input.schemaVersion !== CHANGELOG_SCHEMA_VERSION) throw new TypeError('operation-schema-version-unsupported');
  const projectIdentity = required(input.projectIdentity ?? input.projectId, 'operation-project-identity-required');
  const targetEntityId = required(input.targetEntityId ?? input.entityId, 'operation-target-entity-required');
  const factKind = required(input.factKind, 'operation-fact-kind-required');
  const action = required(input.action || 'set', 'operation-action-required');
  const payload = clone(input.payload ?? input.value ?? null);
  const operationId = required(input.operationId || `op:${stableDigest({ projectIdentity, binaryIdentity: input.binaryIdentity || null, targetEntityId, factKind, action, payload, beforeFingerprint: input.beforeFingerprint || null, causalParents: list(input.causalParents) })}`, 'operation-id-required');
  const operation = {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId,
    projectIdentity,
    binaryIdentity: input.binaryIdentity == null ? null : required(input.binaryIdentity, 'operation-binary-identity-invalid'),
    authorIdentity: input.authorIdentity == null ? null : required(input.authorIdentity, 'operation-author-identity-invalid'),
    deviceIdentity: input.deviceIdentity == null ? null : required(input.deviceIdentity, 'operation-device-identity-invalid'),
    timestampHint: input.timestampHint == null ? null : String(input.timestampHint),
    causalParents: list(input.causalParents),
    targetEntityId,
    factKind,
    action,
    beforeFingerprint: input.beforeFingerprint == null ? null : String(input.beforeFingerprint),
    payload,
    provenance: clone(input.provenance || { source: 'local', actorIdentity: input.authorIdentity || null }),
  };
  return deepFreeze(operation);
}

function compareOperations(a, b) { return a.operationId.localeCompare(b.operationId); }

export function orderOperations(operations = [], existingIds = new Set()) {
  const unique = new Map();
  for (const input of operations) {
    const operation = input.schemaVersion === CHANGELOG_SCHEMA_VERSION ? input : createProjectOperation(input);
    if (!unique.has(operation.operationId)) unique.set(operation.operationId, operation);
  }
  const remaining = new Map(unique);
  const seen = new Set(existingIds);
  const ordered = [];
  const unresolved = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((operation) => operation.causalParents.every((parent) => seen.has(parent))).sort(compareOperations);
    if (!ready.length) { unresolved.push(...[...remaining.values()].sort(compareOperations)); break; }
    for (const operation of ready) { remaining.delete(operation.operationId); ordered.push(operation); seen.add(operation.operationId); }
  }
  return Object.freeze({ ordered, unresolved });
}

function emptyState(projectIdentity, binaryIdentity) {
  return { schemaVersion: CHANGELOG_SCHEMA_VERSION, projectIdentity, binaryIdentity: binaryIdentity || null, facts: {}, conflicts: [], tombstones: [], unresolved: [] };
}

function cloneState(state) { return clone(state); }

export class ChangeLog {
  constructor(options = {}) {
    this.projectIdentity = required(options.projectIdentity ?? options.projectId, 'changelog-project-identity-required');
    this.binaryIdentity = options.binaryIdentity == null ? null : required(options.binaryIdentity, 'changelog-binary-identity-invalid');
    this.state = cloneState(options.state || emptyState(this.projectIdentity, this.binaryIdentity));
    this.operations = new Map((options.operations || []).map((operation) => [operation.operationId, operation]));
    this.pending = new Map(options.pending || []);
    this.allowRemote = options.allowRemote === true;
    this.authorizedAuthors = new Set((options.authorizedAuthors || []).map(String));
  }

  #validate(operation) {
    if (operation.schemaVersion !== CHANGELOG_SCHEMA_VERSION) return { status: 'rejected', reason: 'schema-version-unsupported' };
    if (operation.projectIdentity !== this.projectIdentity) return { status: 'rejected', reason: 'wrong-project-identity' };
    if (this.binaryIdentity !== operation.binaryIdentity) return { status: 'rejected', reason: 'wrong-binary-identity' };
    if (operation.provenance?.transport === 'remote') {
      if (!this.allowRemote) return { status: 'rejected', reason: 'remote-transport-security-gate-required' };
      if (!operation.authorIdentity || !this.authorizedAuthors.has(operation.authorIdentity)) return { status: 'rejected', reason: 'unauthorized-remote-actor' };
    }
    // A pending parent is not an applied parent. Causal effects become visible
    // only after every parent exists in the canonical applied operation set.
    if (operation.causalParents.some((parent) => !this.operations.has(parent))) return { status: 'unresolved', reason: 'missing-causal-parent' };
    return null;
  }

  #applyOne(operation) {
    const validation = this.#validate(operation);
    if (validation) return validation;
    if (this.operations.has(operation.operationId)) return { status: 'duplicate', operationId: operation.operationId };
    const key = factKey(operation.targetEntityId, operation.factKind);
    const current = this.state.facts[key] || null;
    if (operation.action !== 'resolve' && operation.action !== 'remove' && this.state.tombstones.some((item) => item.key === key) && operation.action !== 'resurrect') {
      this.state.unresolved.push({ operationId: operation.operationId, reason: 'tombstone-protects-state', key });
      this.pending.set(operation.operationId, operation);
      return { status: 'unresolved', reason: 'tombstone-protects-state' };
    }
    if (operation.beforeFingerprint != null && (!current || current.stateFingerprint !== operation.beforeFingerprint)) {
      this.state.conflicts.push({ type: 'stale-precondition', key, operationId: operation.operationId, expected: operation.beforeFingerprint, observed: current?.stateFingerprint || null });
      this.operations.set(operation.operationId, operation);
      return { status: 'conflict', operationId: operation.operationId, reason: 'stale-before-fingerprint' };
    }
    if (operation.action === 'remove') {
      delete this.state.facts[key];
      this.state.tombstones.push({ key, operationId: operation.operationId, targetEntityId: operation.targetEntityId, factKind: operation.factKind });
      this.operations.set(operation.operationId, operation);
      return { status: 'applied', operationId: operation.operationId, effect: 'tombstone' };
    }
    if (operation.action === 'resolve') {
      if (!current || !current.values.some((item) => item.operationId === operation.payload?.operationId)) return { status: 'rejected', reason: 'resolution-target-missing' };
      current.resolvedOperationId = operation.payload.operationId;
      this.operations.set(operation.operationId, operation);
      return { status: 'applied', operationId: operation.operationId, effect: 'resolution' };
    }
    const candidate = { operationId: operation.operationId, value: clone(operation.payload), provenance: clone(operation.provenance), timestampHint: operation.timestampHint };
    const candidateDigest = payloadDigest(candidate.value);
    const previous = current?.values.find((item) => payloadDigest(item.value) === candidateDigest);
    if (previous) { this.operations.set(operation.operationId, operation); return { status: 'applied', operationId: operation.operationId, effect: 'idempotent-value' }; }
    const record = current || { key, targetEntityId: operation.targetEntityId, factKind: operation.factKind, values: [], resolvedOperationId: null, stateFingerprint: null };
    record.values.push(candidate);
    record.values.sort((a, b) => a.operationId.localeCompare(b.operationId));
    record.stateFingerprint = payloadDigest(record.values.map((item) => ({ operationId: item.operationId, value: item.value })));
    this.state.facts[key] = record;
    if (MEANINGFUL_FACTS.has(operation.factKind) && record.values.length > 1) this.state.conflicts.push({ type: 'meaningful-conflict', key, factKind: operation.factKind, operationIds: record.values.map((item) => item.operationId) });
    this.operations.set(operation.operationId, operation);
    return { status: record.values.length > 1 && MEANINGFUL_FACTS.has(operation.factKind) ? 'conflict' : 'applied', operationId: operation.operationId, effect: record.values.length > 1 ? 'preserved-competing-value' : 'fact' };
  }

  applyOperation(input) {
    const operation = input?.schemaVersion === CHANGELOG_SCHEMA_VERSION ? input : createProjectOperation(input);
    const result = this.#applyOne(operation);
    if (result.status === 'unresolved') this.pending.set(operation.operationId, operation);
    else this.pending.delete(operation.operationId);
    return Object.freeze({ ...result, operationId: operation.operationId, stateDigest: this.digest() });
  }

  applyBatch(inputs = []) {
    const operations = inputs.map((input) => input?.schemaVersion === CHANGELOG_SCHEMA_VERSION ? input : createProjectOperation(input));
    const ordered = orderOperations(operations, new Set(this.operations.keys()));
    if (ordered.unresolved.length) return Object.freeze({ status: 'unresolved', reason: 'missing-causal-parent', operationIds: ordered.unresolved.map((operation) => operation.operationId), stateDigest: this.digest() });
    const working = new ChangeLog({ projectIdentity: this.projectIdentity, binaryIdentity: this.binaryIdentity, state: this.state, operations: [...this.operations.values()], pending: [...this.pending.entries()], allowRemote: this.allowRemote, authorizedAuthors: [...this.authorizedAuthors] });
    const results = [];
    for (const operation of ordered.ordered) {
      const result = working.#applyOne(operation);
      results.push(result);
      if (result.status === 'rejected') return Object.freeze({ status: 'rejected', reason: result.reason, operationId: operation.operationId, results, stateDigest: this.digest() });
      if (result.status === 'unresolved') working.pending.set(operation.operationId, operation);
      else working.pending.delete(operation.operationId);
    }
    this.state = working.state;
    this.operations = working.operations;
    this.pending = working.pending;
    const unresolved = [...this.pending.keys()].sort();
    return Object.freeze({ status: unresolved.length ? 'applied-with-unresolved' : 'applied', results, unresolvedOperationIds: unresolved, stateDigest: this.digest() });
  }

  checkpoint() {
    return deepFreeze({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, projectIdentity: this.projectIdentity, binaryIdentity: this.binaryIdentity, state: cloneState(this.state), operationIds: [...this.operations.keys()].sort(), digest: this.digest() });
  }

  digest() { return payloadDigest({ state: this.state, operationIds: [...this.operations.keys()].sort()); }
  snapshot() { return deepFreeze(cloneState(this.state)); }
  appliedOperationIds() { return Object.freeze([...this.operations.keys()].sort()); }
}

export function replayOperations({ projectIdentity, binaryIdentity = null, operations = [], checkpoint = null } = {}) {
  const log = new ChangeLog({ projectIdentity, binaryIdentity, state: checkpoint?.state, operations: checkpoint ? checkpoint.operationIds.map((operationId) => ({ operationId, schemaVersion: CHANGELOG_SCHEMA_VERSION, projectIdentity, binaryIdentity, targetEntityId: 'checkpoint', factKind: 'checkpoint', action: 'set', payload: null, causalParents: [], provenance: { source: 'checkpoint' } })) : [] });
  const filtered = checkpoint ? operations.filter((operation) => !checkpoint.operationIds.includes(operation.operationId)) : operations;
  const result = log.applyBatch(filtered);
  return Object.freeze({ ...result, state: log.snapshot(), digest: log.digest(), unresolved: result.status === 'unresolved' ? result.operationIds : result.unresolvedOperationIds || [] });
}

export function createCheckpoint(log) { if (!(log instanceof ChangeLog)) throw new TypeError('ChangeLog required'); return log.checkpoint(); }

export function restoreCheckpoint(checkpoint, options = {}) {
  if (!checkpoint || checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) throw new TypeError('checkpoint-schema-invalid');
  assertIdentityMatch(checkpoint.projectIdentity, options.projectIdentity, 'checkpoint-project-identity-mismatch');
  assertIdentityMatch(checkpoint.binaryIdentity || '', options.binaryIdentity || '', 'checkpoint-binary-identity-mismatch');
  const checkpointOperations = checkpoint.operationIds.map((operationId) => ({ operationId, schemaVersion: CHANGELOG_SCHEMA_VERSION, projectIdentity: options.projectIdentity, binaryIdentity: options.binaryIdentity || null, targetEntityId: 'checkpoint', factKind: 'checkpoint', action: 'set', payload: null, causalParents: [], provenance: { source: 'checkpoint' } }));
  const log = new ChangeLog({ projectIdentity: options.projectIdentity, binaryIdentity: options.binaryIdentity || null, state: checkpoint.state, operations: checkpointOperations });
  for (const operation of options.operations || []) if (!checkpoint.operationIds.includes(operation.operationId)) log.applyOperation(operation);
  return log;
}

export function mergeOperations(left = [], right = []) {
  const map = new Map();
  for (const input of [...left, ...right]) { const operation = input.schemaVersion === CHANGELOG_SCHEMA_VERSION ? input : createProjectOperation(input); if (!map.has(operation.operationId)) map.set(operation.operationId, operation); }
  return Object.freeze([...map.values()].sort(compareOperations));
}

export function collaborationAuthority() { return Object.freeze({ localReplay: 'supported', localCanonicalApply: 'supported', remoteTransport: 'unsupported', reason: 'security-gate-required' }); }
