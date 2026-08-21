import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const RUNTIME_AUTHORITY_SCHEMA = 'hex-runtime-authority/v1';

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function uint(value, code) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(code);
  return n;
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

export function createRuntimeAuthorityBinding(input = {}) {
  const binding = {
    schemaVersion: RUNTIME_AUTHORITY_SCHEMA,
    providerIdentity: required(input.providerIdentity, 'runtime-provider-identity-required'),
    runtimeInstanceIdentity: required(input.runtimeInstanceIdentity, 'runtime-instance-identity-required'),
    targetIdentity: required(input.targetIdentity ?? input.processIdentity, 'runtime-target-identity-required'),
    binaryIdentity: required(input.binaryIdentity ?? input.binaryHash, 'runtime-binary-identity-required'),
    moduleIdentity: required(input.moduleIdentity, 'runtime-module-identity-required'),
    loadMappingIdentity: required(input.loadMappingIdentity, 'runtime-load-mapping-identity-required'),
    sessionIdentity: required(input.sessionIdentity ?? input.sessionId, 'runtime-session-identity-required'),
    capabilityVersion: required(input.capabilityVersion, 'runtime-capability-version-required'),
    epoch: uint(input.epoch ?? 0, 'runtime-epoch-invalid'),
  };
  return deepFreeze({ ...binding, bindingId: `runtime-binding:${stableDigest(binding)}` });
}

export function createRuntimeObservation(input = {}) {
  const binding = input.binding?.schemaVersion === RUNTIME_AUTHORITY_SCHEMA
    ? input.binding
    : createRuntimeAuthorityBinding(input.binding || input);
  const sequence = uint(input.sequence, 'runtime-observation-sequence-invalid');
  const observedAt = required(input.observedAt ?? input.timestamp, 'runtime-observation-timestamp-required');
  const observation = {
    schemaVersion: 'hex-runtime-observation/v1',
    bindingId: binding.bindingId,
    providerIdentity: binding.providerIdentity,
    runtimeInstanceIdentity: binding.runtimeInstanceIdentity,
    targetIdentity: binding.targetIdentity,
    binaryIdentity: binding.binaryIdentity,
    moduleIdentity: binding.moduleIdentity,
    loadMappingIdentity: binding.loadMappingIdentity,
    sessionIdentity: binding.sessionIdentity,
    capabilityVersion: binding.capabilityVersion,
    epoch: binding.epoch,
    sequence,
    observedAt,
    kind: required(input.kind || 'observation', 'runtime-observation-kind-required'),
    payload: clone(input.payload ?? null),
    authority: 'runtime-evidence',
  };
  return deepFreeze({ ...observation, observationId: `runtime-observation:${stableDigest(observation)}` });
}

export function validateRuntimeObservation(bindingInput, observation, options = {}) {
  const binding = bindingInput?.schemaVersion === RUNTIME_AUTHORITY_SCHEMA
    ? bindingInput
    : createRuntimeAuthorityBinding(bindingInput || {});
  if (!observation || observation.schemaVersion !== 'hex-runtime-observation/v1') return { ok: false, reason: 'runtime-observation-schema-invalid' };
  const identityKeys = ['bindingId', 'providerIdentity', 'runtimeInstanceIdentity', 'targetIdentity', 'binaryIdentity', 'moduleIdentity', 'loadMappingIdentity', 'sessionIdentity', 'capabilityVersion', 'epoch'];
  for (const key of identityKeys) {
    if (observation[key] !== binding[key]) return { ok: false, reason: `runtime-observation-${key}-mismatch`, expected: binding[key], observed: observation[key] };
  }
  const minimumSequence = options.minimumSequence == null ? 0 : uint(options.minimumSequence, 'runtime-minimum-sequence-invalid');
  if (!Number.isSafeInteger(observation.sequence) || observation.sequence < minimumSequence) return { ok: false, reason: 'runtime-observation-stale-sequence' };
  return { ok: true, binding, observation };
}

export class RuntimeAuthorityTracker {
  constructor(bindingInput, options = {}) {
    this.binding = bindingInput?.schemaVersion === RUNTIME_AUTHORITY_SCHEMA
      ? bindingInput
      : createRuntimeAuthorityBinding(bindingInput || {});
    this.lastSequence = -1;
    this.closed = false;
    this.maxObservations = Math.max(1, Math.min(4096, Number(options.maxObservations || 1024)));
    this.observations = [];
  }

  accept(input) {
    if (this.closed) return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-closed' });
    const observation = input?.schemaVersion === 'hex-runtime-observation/v1' ? input : createRuntimeObservation({ ...input, binding: this.binding });
    const checked = validateRuntimeObservation(this.binding, observation, { minimumSequence: this.lastSequence + 1 });
    if (!checked.ok) return Object.freeze({ status: 'rejected', reason: checked.reason });
    this.lastSequence = observation.sequence;
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) this.observations.shift();
    return Object.freeze({ status: 'accepted', observationId: observation.observationId, sequence: observation.sequence });
  }

  authorizeMutation(input = {}) {
    if (this.closed) return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-closed' });
    const bindingId = required(input.bindingId ?? this.binding.bindingId, 'runtime-mutation-binding-required');
    if (bindingId !== this.binding.bindingId) return Object.freeze({ status: 'rejected', reason: 'runtime-mutation-binding-mismatch' });
    if (input.explicitApproval !== true) return Object.freeze({ status: 'rejected', reason: 'runtime-mutation-explicit-approval-required' });
    const actorIdentity = required(input.actorIdentity, 'runtime-mutation-actor-required');
    const operation = required(input.operation, 'runtime-mutation-operation-required');
    const token = {
      schemaVersion: 'hex-runtime-mutation-authority/v1',
      bindingId,
      actorIdentity,
      operation,
      scope: clone(input.scope || {}),
      issuedAt: required(input.issuedAt, 'runtime-mutation-issued-at-required'),
      authority: 'explicit-local-runtime-mutation',
    };
    return Object.freeze({ status: 'authorized', token: deepFreeze({ ...token, tokenId: `runtime-mutation:${stableDigest(token)}` }) });
  }

  nextEpoch(bindingOverrides = {}) {
    this.closed = true;
    return createRuntimeAuthorityBinding({ ...this.binding, ...bindingOverrides, epoch: this.binding.epoch + 1, sessionIdentity: bindingOverrides.sessionIdentity || this.binding.sessionIdentity });
  }

  snapshot() {
    return deepFreeze({ binding: this.binding, lastSequence: this.lastSequence, observations: [...this.observations] });
  }
}

export function runtimeProfileSupport({ binding, providerCapabilities = {}, proof = {} } = {}) {
  const hasBinding = binding?.schemaVersion === RUNTIME_AUTHORITY_SCHEMA;
  const required = ['readMemory', 'readRegisters', 'disconnect'];
  const missing = required.filter((key) => providerCapabilities[key] !== true);
  const proven = hasBinding && missing.length === 0 && proof.exactHead === true && proof.identityNegativeTests === true && proof.staleEventTests === true;
  return Object.freeze({
    status: proven ? 'supported-for-exact-provider-profile' : hasBinding ? 'partial' : 'unavailable',
    bindingId: hasBinding ? binding.bindingId : null,
    missingCapabilities: Object.freeze(missing),
    authority: proven ? 'runtime-evidence-bound' : 'none',
  });
}
