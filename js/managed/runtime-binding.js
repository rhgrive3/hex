import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { createRuntimeAuthorityBinding, validateRuntimeObservation } from '../runtime/authority.js';

export const MANAGED_RUNTIME_BINDING_SCHEMA = 'hex-managed-runtime-binding/v1';
const FRONTENDS = new Set(['wasm', 'dex', 'cil', 'jvm']);

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function boundedCount(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

export function createManagedRuntimeBinding(input = {}) {
  const frontendId = required(input.frontendId, 'managed-runtime-frontend-required').toLowerCase();
  if (!FRONTENDS.has(frontendId)) throw new TypeError('managed-runtime-frontend-unsupported');
  const staticModuleIdentity = required(input.staticModuleIdentity, 'managed-runtime-static-module-required');
  const runtimeModuleIdentity = required(input.runtimeModuleIdentity, 'managed-runtime-module-required');
  if (staticModuleIdentity !== runtimeModuleIdentity) throw new TypeError('managed-runtime-module-identity-mismatch');
  const runtime = createRuntimeAuthorityBinding({
    providerIdentity: input.providerIdentity,
    runtimeInstanceIdentity: input.runtimeInstanceIdentity,
    targetIdentity: input.targetIdentity,
    binaryIdentity: input.binaryIdentity,
    moduleIdentity: runtimeModuleIdentity,
    loadMappingIdentity: input.loadMappingIdentity,
    sessionIdentity: input.sessionIdentity,
    capabilityVersion: input.capabilityVersion,
    epoch: input.epoch ?? 0,
  });
  const binding = {
    schemaVersion: MANAGED_RUNTIME_BINDING_SCHEMA,
    frontendId,
    runtimeImplementation: required(input.runtimeImplementation, 'managed-runtime-implementation-required'),
    runtimeVersion: required(input.runtimeVersion, 'managed-runtime-version-required'),
    staticModuleIdentity,
    runtimeModuleIdentity,
    runtime,
    maxThreads: boundedCount(input.maxThreads, 256, 4096, 'managed-runtime-max-threads-invalid'),
    maxFramesPerThread: boundedCount(input.maxFramesPerThread, 1024, 16384, 'managed-runtime-max-frames-invalid'),
    maxLocalsPerFrame: boundedCount(input.maxLocalsPerFrame, 4096, 65536, 'managed-runtime-max-locals-invalid'),
    maxOperandStack: boundedCount(input.maxOperandStack, 4096, 65536, 'managed-runtime-max-stack-invalid'),
  };
  return deepFreeze({ ...binding, bindingId: `managed-runtime:${stableDigest(binding)}` });
}

export function validateManagedRuntimeState(binding, state = {}) {
  if (!binding || binding.schemaVersion !== MANAGED_RUNTIME_BINDING_SCHEMA) return { ok: false, reason: 'managed-runtime-binding-invalid' };
  const threads = Array.isArray(state.threads) ? state.threads : [];
  if (threads.length > binding.maxThreads) return { ok: false, reason: 'managed-runtime-thread-budget-exceeded' };
  for (const thread of threads) {
    const frames = Array.isArray(thread?.frames) ? thread.frames : [];
    if (frames.length > binding.maxFramesPerThread) return { ok: false, reason: 'managed-runtime-frame-budget-exceeded' };
    for (const frame of frames) {
      if ((Array.isArray(frame?.locals) ? frame.locals.length : 0) > binding.maxLocalsPerFrame) return { ok: false, reason: 'managed-runtime-local-budget-exceeded' };
      if ((Array.isArray(frame?.operandStack) ? frame.operandStack.length : 0) > binding.maxOperandStack) return { ok: false, reason: 'managed-runtime-stack-budget-exceeded' };
      if (frame?.moduleIdentity != null && String(frame.moduleIdentity) !== binding.runtimeModuleIdentity) return { ok: false, reason: 'managed-runtime-frame-module-mismatch' };
    }
  }
  return { ok: true, threads };
}

export function validateManagedRuntimeObservation(binding, observation, options = {}) {
  if (!binding || binding.schemaVersion !== MANAGED_RUNTIME_BINDING_SCHEMA) return { ok: false, reason: 'managed-runtime-binding-invalid' };
  const runtime = validateRuntimeObservation(binding.runtime, observation, options);
  if (!runtime.ok) return runtime;
  if (observation.payload?.moduleIdentity != null && String(observation.payload.moduleIdentity) !== binding.runtimeModuleIdentity) {
    return { ok: false, reason: 'managed-runtime-observation-module-mismatch' };
  }
  return { ok: true, observation };
}

export function managedRuntimeProfileSupport({ binding, proof = {} } = {}) {
  const valid = binding?.schemaVersion === MANAGED_RUNTIME_BINDING_SCHEMA;
  const proven = valid
    && proof.exactHead === true
    && proof.identityNegativeTests === true
    && proof.staleEventTests === true
    && proof.stateBudgetTests === true
    && proof.runtimeDisagreementPreservesStaticTruth === true;
  return Object.freeze({
    frontendId: valid ? binding.frontendId : null,
    runtimeImplementation: valid ? binding.runtimeImplementation : null,
    runtimeVersion: valid ? binding.runtimeVersion : null,
    status: proven ? 'supported-for-exact-provider-profile' : valid ? 'partial' : 'unavailable',
    authority: proven ? 'runtime-evidence-bound' : 'none',
  });
}
