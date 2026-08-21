import assert from 'node:assert/strict';
import { createRuntimeObservation } from '../../js/runtime/authority.js';
import {
  createManagedRuntimeBinding,
  managedRuntimeProfileSupport,
  validateManagedRuntimeObservation,
  validateManagedRuntimeState,
} from '../../js/managed/runtime-binding.js';

const binding = createManagedRuntimeBinding({
  frontendId: 'jvm',
  runtimeImplementation: 'openjdk-test',
  runtimeVersion: '21-test',
  staticModuleIdentity: 'managed-module:1',
  runtimeModuleIdentity: 'managed-module:1',
  providerIdentity: 'provider:jvm:test',
  runtimeInstanceIdentity: 'runtime:jvm:1',
  targetIdentity: 'process:java:1',
  binaryIdentity: 'binary:jar:1',
  loadMappingIdentity: 'mapping:jvm:1',
  sessionIdentity: 'session:jvm:1',
  capabilityVersion: 'managed-debug/v1',
  maxThreads: 2,
  maxFramesPerThread: 2,
  maxLocalsPerFrame: 2,
  maxOperandStack: 2,
});

assert.throws(() => createManagedRuntimeBinding({
  frontendId: 'jvm', runtimeImplementation: 'x', runtimeVersion: '1', staticModuleIdentity: 'a', runtimeModuleIdentity: 'b',
  providerIdentity: 'p', runtimeInstanceIdentity: 'r', targetIdentity: 't', binaryIdentity: 'bin', loadMappingIdentity: 'map', sessionIdentity: 's', capabilityVersion: '1',
}), /module-identity-mismatch/);

assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ moduleIdentity: 'managed-module:1', locals: [1], operandStack: [2] }] }] }).ok, true);
assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ moduleIdentity: 'managed-module:1', locals: [1, 2, 3] }] }] }).reason, 'managed-runtime-local-budget-exceeded');
assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ moduleIdentity: 'wrong' }] }] }).reason, 'managed-runtime-frame-module-mismatch');

const observation = createRuntimeObservation({ binding: binding.runtime, sequence: 1, observedAt: '2026-08-22T00:00:00Z', kind: 'managed-frame', payload: { moduleIdentity: 'managed-module:1' } });
assert.equal(validateManagedRuntimeObservation(binding, observation).ok, true);
const wrongObservation = createRuntimeObservation({ binding: binding.runtime, sequence: 2, observedAt: '2026-08-22T00:00:01Z', kind: 'managed-frame', payload: { moduleIdentity: 'other' } });
assert.equal(validateManagedRuntimeObservation(binding, wrongObservation).reason, 'managed-runtime-observation-module-mismatch');

assert.equal(managedRuntimeProfileSupport({ binding, proof: {
  exactHead: true,
  identityNegativeTests: true,
  staleEventTests: true,
  stateBudgetTests: true,
  runtimeDisagreementPreservesStaticTruth: true,
} }).status, 'supported-for-exact-provider-profile');
console.log('[stage2] managed runtime binding tests passed');
