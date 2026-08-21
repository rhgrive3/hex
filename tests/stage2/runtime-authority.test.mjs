import assert from 'node:assert/strict';
import {
  RuntimeAuthorityTracker,
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
  runtimeProfileSupport,
  validateRuntimeObservation,
} from '../../js/runtime/authority.js';

const binding = createRuntimeAuthorityBinding({
  providerIdentity: 'provider:lldb:test',
  runtimeInstanceIdentity: 'runtime:1',
  targetIdentity: 'process:42',
  binaryIdentity: 'binary:abc',
  moduleIdentity: 'module:main',
  loadMappingIdentity: 'mapping:1',
  sessionIdentity: 'session:1',
  capabilityVersion: 'debug/v1',
  epoch: 3,
});
assert.match(binding.bindingId, /^runtime-binding:/);

const tracker = new RuntimeAuthorityTracker(binding);
const first = createRuntimeObservation({ binding, sequence: 1, observedAt: '2026-08-22T00:00:00Z', kind: 'stop', payload: { pc: '0x1000' } });
assert.equal(tracker.accept(first).status, 'accepted');
assert.equal(tracker.accept(first).reason, 'runtime-observation-stale-sequence');

const wrongSession = createRuntimeObservation({
  binding: createRuntimeAuthorityBinding({ ...binding, sessionIdentity: 'session:other' }),
  sequence: 2,
  observedAt: '2026-08-22T00:00:01Z',
  kind: 'stop',
});
assert.equal(validateRuntimeObservation(binding, wrongSession).reason, 'runtime-observation-bindingId-mismatch');
assert.equal(tracker.accept(wrongSession).status, 'rejected');

assert.equal(tracker.authorizeMutation({ bindingId: binding.bindingId, actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-08-22T00:00:02Z' }).reason, 'runtime-mutation-explicit-approval-required');
const authorized = tracker.authorizeMutation({ bindingId: binding.bindingId, actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-08-22T00:00:02Z', explicitApproval: true });
assert.equal(authorized.status, 'authorized');
assert.equal(authorized.token.authority, 'explicit-local-runtime-mutation');

const support = runtimeProfileSupport({
  binding,
  providerCapabilities: { readMemory: true, readRegisters: true, disconnect: true },
  proof: { exactHead: true, identityNegativeTests: true, staleEventTests: true },
});
assert.equal(support.status, 'supported-for-exact-provider-profile');
assert.equal(runtimeProfileSupport({ binding, providerCapabilities: { readMemory: true }, proof: { exactHead: true, identityNegativeTests: true, staleEventTests: true } }).status, 'partial');
console.log('[stage2] runtime authority tests passed');
