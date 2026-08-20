import { canonicalAddress, createRuntimeSessionId, deepFreeze } from '../core/identity/index.js';
import { DebugAdapterError, asAddress } from '../debug/adapter.js';

const RESOLUTION_STATES = Object.freeze(['exact', 'resolved', 'ambiguous', 'unresolved', 'mismatch']);
const BINDING_STATES = Object.freeze(['exact', 'resolved', 'unresolved', 'mismatch']);

function required(value, code, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function optionalText(value) {
  return value == null ? null : String(value);
}

function safeSequence(value, name = 'sequence') {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new DebugAdapterError('invalid-sequence', `${name} must be a non-negative safe integer`);
  return n;
}

function positiveSize(value, name = 'runtimeSize') {
  const n = asAddress(value, name);
  if (n <= 0n) throw new DebugAdapterError('invalid-size', `${name} must be greater than zero`);
  return n;
}

function freezeEvidenceIds(value) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new DebugAdapterError('invalid-evidence-ids', 'evidence ids must be an array');
  return Object.freeze([...new Set(value.map(String).filter(Boolean))].sort());
}

export function createRuntimeProviderSessionId(input = {}) {
  const binaryId = required(input.binaryId ?? input.binaryHash, 'runtime-binary-identity-required', 'runtime provider session requires verified binary identity');
  return createRuntimeSessionId({
    binaryId,
    provider: required(input.providerId ?? input.provider, 'runtime-provider-required', 'runtime provider id is required'),
    targetIdentity: input.targetIdentity ?? input.target ?? { kind: 'runtime-target' },
    sessionNonce: required(input.sessionNonce ?? input.startedAt, 'runtime-session-nonce-required', 'runtime session nonce is required'),
  });
}

export function createRuntimeTargetBinding(input = {}) {
  const runtimeSessionId = required(input.runtimeSessionId, 'runtime-session-id-required', 'runtime target binding requires runtimeSessionId');
  const providerId = required(input.providerId, 'runtime-provider-required', 'runtime target binding requires providerId');
  return deepFreeze({
    runtimeSessionId,
    providerId,
    providerVersion: optionalText(input.providerVersion),
    processKey: optionalText(input.processKey),
    platform: optionalText(input.platform),
    architecture: optionalText(input.architecture),
    primaryBinaryId: optionalText(input.primaryBinaryId ?? input.binaryId),
    primarySliceId: optionalText(input.primarySliceId ?? input.sliceId),
    startedAt: input.startedAt == null ? null : String(input.startedAt),
    bindingEvidenceIds: freezeEvidenceIds(input.bindingEvidenceIds),
  });
}

function normalizeBinding(input, runtimeSessionId, generation) {
  const runtimeBase = asAddress(input.runtimeBase ?? input.base, 'runtimeBase');
  const runtimeSize = positiveSize(input.runtimeSize ?? input.size, 'runtimeSize');
  const staticBase = input.staticBase == null && input.imageBase == null ? null : asAddress(input.staticBase ?? input.imageBase, 'staticBase');
  const identityState = input.identityState == null
    ? (input.binaryId ? 'exact' : 'unresolved')
    : String(input.identityState);
  if (!BINDING_STATES.includes(identityState)) throw new DebugAdapterError('invalid-module-identity-state', `invalid module identity state: ${identityState}`);
  return deepFreeze({
    runtimeSessionId,
    bindingKey: required(input.bindingKey ?? input.moduleKey ?? input.id, 'runtime-module-binding-key-required', 'runtime module binding key is required'),
    generation,
    runtimeBase,
    runtimeSize,
    runtimeEnd: runtimeBase + runtimeSize,
    staticBase,
    permissions: optionalText(input.permissions),
    pathHint: optionalText(input.pathHint ?? input.path ?? input.name),
    binaryId: optionalText(input.binaryId),
    sliceId: optionalText(input.sliceId),
    imageId: optionalText(input.imageId),
    buildIdentity: input.buildIdentity == null ? null : input.buildIdentity,
    loadedSequence: safeSequence(input.loadedSequence, 'loadedSequence'),
    unloadedSequence: safeSequence(input.unloadedSequence, 'unloadedSequence'),
    identityState,
    identityEvidenceIds: freezeEvidenceIds(input.identityEvidenceIds),
  });
}

function matchIsStrong(match, targetBinaryId) {
  if (!match || typeof match !== 'object' || match.accepted !== true || match.ambiguous === true) return false;
  if (targetBinaryId && match.targetBinaryId && String(match.targetBinaryId) !== String(targetBinaryId)) return false;
  const confidence = Number(match.identityConfidence ?? match.confidence ?? match.score);
  if (!Number.isFinite(confidence) || confidence < 0.85) return false;
  const margin = Number(match.ambiguityMargin ?? match.margin);
  if (Number.isFinite(margin) && margin < 0.10) return false;
  return true;
}

export class RuntimeModuleBindingTable {
  #active = new Map();
  #history = [];
  #generation = new Map();

  constructor(runtimeSessionId) {
    this.runtimeSessionId = required(runtimeSessionId, 'runtime-session-id-required', 'module table requires runtimeSessionId');
  }

  load(input = {}) {
    const bindingKey = required(input.bindingKey ?? input.moduleKey ?? input.id, 'runtime-module-binding-key-required', 'runtime module binding key is required');
    const active = this.#active.get(bindingKey);
    if (active && active.unloadedSequence == null) {
      throw new DebugAdapterError('module-binding-already-loaded', `runtime module binding is already loaded: ${bindingKey}`, { bindingKey, generation: active.generation });
    }
    const generation = (this.#generation.get(bindingKey) || 0) + 1;
    this.#generation.set(bindingKey, generation);
    const binding = normalizeBinding({ ...input, bindingKey }, this.runtimeSessionId, generation);
    this.#active.set(bindingKey, binding);
    this.#history.push(binding);
    return binding;
  }

  unload(bindingKey, sequence = null) {
    const key = required(bindingKey, 'runtime-module-binding-key-required', 'runtime module binding key is required');
    const current = this.#active.get(key);
    if (!current || current.unloadedSequence != null) return null;
    const unloadedSequence = safeSequence(sequence, 'unloadedSequence');
    if (current.loadedSequence != null && unloadedSequence != null && unloadedSequence < current.loadedSequence) {
      throw new DebugAdapterError('invalid-module-sequence', 'module unload sequence precedes load sequence', { bindingKey: key });
    }
    const retired = deepFreeze({ ...current, unloadedSequence });
    this.#active.delete(key);
    this.#history.push(retired);
    return retired;
  }

  get(bindingKey) { return this.#active.get(String(bindingKey)) || null; }
  active() { return Object.freeze([...this.#active.values()]); }
  history() { return Object.freeze(this.#history.slice()); }

  resolve(runtimeAddress, options = {}) {
    const address = asAddress(runtimeAddress, 'runtimeAddress');
    const candidates = [...this.#active.values()].filter((binding) => address >= binding.runtimeBase && address < binding.runtimeEnd);
    if (candidates.length === 0) return createRuntimeAddressResolution({ runtimeSessionId: this.runtimeSessionId, runtimeAddress: address, state: 'unresolved', method: 'no-active-module' });
    if (candidates.length > 1) {
      return createRuntimeAddressResolution({
        runtimeSessionId: this.runtimeSessionId,
        runtimeAddress: address,
        state: 'ambiguous',
        method: 'overlapping-active-modules',
        evidenceIds: candidates.flatMap((binding) => binding.identityEvidenceIds),
      });
    }

    const binding = candidates[0];
    const targetBinaryId = options.binaryId == null ? null : String(options.binaryId);
    const targetSliceId = options.sliceId == null ? null : String(options.sliceId);

    if (binding.identityState === 'mismatch') {
      return createRuntimeAddressResolution({ ...binding, runtimeAddress: address, state: 'mismatch', method: 'module-identity-mismatch', evidenceIds: binding.identityEvidenceIds });
    }

    if (targetBinaryId && binding.binaryId && targetBinaryId !== binding.binaryId) {
      const match = options.crossVersionMatch;
      if (!matchIsStrong(match, targetBinaryId)) {
        return createRuntimeAddressResolution({
          ...binding,
          runtimeAddress: address,
          state: 'mismatch',
          method: 'binary-id-mismatch',
          binaryId: binding.binaryId,
          sliceId: binding.sliceId,
          evidenceIds: binding.identityEvidenceIds,
        });
      }
      const matchedStaticAddress = match.staticAddress == null ? null : asAddress(match.staticAddress, 'crossVersionMatch.staticAddress');
      return createRuntimeAddressResolution({
        ...binding,
        runtimeAddress: address,
        binaryId: targetBinaryId,
        sliceId: match.targetSliceId ?? targetSliceId,
        staticAddress: matchedStaticAddress,
        targetEntityIds: match.targetEntityIds,
        state: matchedStaticAddress == null ? 'unresolved' : 'resolved',
        method: 'cross-version-match',
        evidenceIds: [...binding.identityEvidenceIds, ...(match.evidenceIds || [])],
        functionMatchId: match.id ?? match.functionMatchId ?? null,
      });
    }

    if (targetSliceId && binding.sliceId && targetSliceId !== binding.sliceId) {
      return createRuntimeAddressResolution({ ...binding, runtimeAddress: address, state: 'mismatch', method: 'slice-id-mismatch', evidenceIds: binding.identityEvidenceIds });
    }

    if (!binding.binaryId || binding.staticBase == null || binding.identityState === 'unresolved') {
      return createRuntimeAddressResolution({ ...binding, runtimeAddress: address, state: 'unresolved', method: 'static-identity-unresolved', evidenceIds: binding.identityEvidenceIds });
    }

    const offset = address - binding.runtimeBase;
    const staticAddress = binding.staticBase + offset;
    const state = binding.identityState === 'exact' ? 'exact' : 'resolved';
    return createRuntimeAddressResolution({
      ...binding,
      runtimeAddress: address,
      staticAddress,
      state,
      method: state === 'exact' ? 'verified-module-offset' : 'resolved-module-offset',
      evidenceIds: binding.identityEvidenceIds,
    });
  }
}

export function createRuntimeAddressResolution(input = {}) {
  const state = String(input.state ?? 'unresolved');
  if (!RESOLUTION_STATES.includes(state)) throw new DebugAdapterError('invalid-runtime-resolution-state', `invalid runtime address resolution state: ${state}`);
  const runtimeAddress = asAddress(input.runtimeAddress, 'runtimeAddress');
  const staticAddress = input.staticAddress == null ? null : asAddress(input.staticAddress, 'staticAddress');
  return deepFreeze({
    runtimeSessionId: required(input.runtimeSessionId, 'runtime-session-id-required', 'runtime address resolution requires runtimeSessionId'),
    moduleBindingKey: optionalText(input.moduleBindingKey ?? input.bindingKey),
    moduleGeneration: input.moduleGeneration ?? input.generation ?? null,
    runtimeAddress,
    binaryId: optionalText(input.binaryId),
    sliceId: optionalText(input.sliceId),
    imageId: optionalText(input.imageId),
    staticAddress,
    targetEntityIds: Object.freeze([...(input.targetEntityIds || [])].map(String).filter(Boolean)),
    state,
    method: optionalText(input.method),
    evidenceIds: freezeEvidenceIds(input.evidenceIds),
    functionMatchId: optionalText(input.functionMatchId),
    display: deepFreeze({ runtimeAddress: canonicalAddress(runtimeAddress), staticAddress: staticAddress == null ? null : canonicalAddress(staticAddress) }),
  });
}

export const RUNTIME_RESOLUTION_STATES = RESOLUTION_STATES;
