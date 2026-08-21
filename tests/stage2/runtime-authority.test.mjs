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

assert.throws(() => new RuntimeAuthorityTracker(binding, { maxObservations: Number.NaN }), /runtime-max-observations-invalid/);
assert.throws(() => new RuntimeAuthorityTracker(binding, { maxObservations: 5000 }), /runtime-max-observations-invalid/);
const tracker = new RuntimeAuthorityTracker(binding, { maxObservations: 2 });
for (let sequence = 1; sequence <= 3; sequence++) {
  const observation = createRuntimeObservation({ binding, sequence, observedAt: `2026-08-22T00:00:0${sequence}Z`, kind: 'stop', payload: { pc: `0x100${sequence}` } });
  assert.equal(tracker.accept(observation).status, 'accepted');
}
assert.equal(tracker.snapshot().observations.length, 2, 'runtime observation history must stay bounded');
const replay = createRuntimeObservation({ binding, sequence: 3, observedAt: '2026-08-22T00:00:04Z', kind: 'stop' });
assert.equal(tracker.accept(replay).reason, 'runtime-observation-stale-sequence');

const wrongSession = createRuntimeObservation({
  binding: createRuntimeAuthorityBinding({ ...binding, sessionIdentity: 'session:other' }),
  sequence: 4,
  observedAt: '2026-08-22T00:00:05Z',
  kind: 'stop',
});
assert.equal(validateRuntimeObservation(binding, wrongSession).reason, 'runtime-observation-bindingId-mismatch');
assert.equal(tracker.accept(wrongSession).status, 'rejected');

assert.equal(tracker.authorizeMutation({ bindingId: binding.bindingId, actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-08-22T00:00:06Z' }).reason, 'runtime-mutation-explicit-approval-required');
const authorized = tracker.authorizeMutation({ bindingId: binding.bindingId, actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-08-22T00:00:06Z', explicitApproval: true });
assert.equal(authorized.status, 'authorized');
assert.equal(authorized.token.authority, 'explicit-local-runtime-mutation');

const targetProfileId = 'arm64:a64';
const requiredCapabilities = [
  'connect', 'disconnect', 'attach', 'pause', 'resume', 'stepInto',
  'breakpointAddress', 'removeBreakpoint', 'readRegisters', 'readMemory', 'writeMemory',
  'threads', 'modules', 'cancel',
];
const providerCapabilities = Object.fromEntries(requiredCapabilities.map((name) => [name, true]));
const fullProof = {
  exactHead: true,
  identityNegativeTests: true,
  staleEventTests: true,
  lifecycleTests: true,
  capabilityTests: true,
  moduleMappingTests: true,
  mutationAuthorityTests: true,
};
const support = runtimeProfileSupport({
  binding,
  providerProfileId: 'native:lldb-compatible-v1:test',
  targetProfileId,
  providerCapabilities,
  requiredCapabilities,
  proof: fullProof,
});
assert.equal(support.status, 'supported-for-exact-provider-profile');
assert.equal(support.targetProfileId, targetProfileId);
assert.equal(runtimeProfileSupport({ binding, providerProfileId: 'native:lldb-compatible-v1:test', targetProfileId, providerCapabilities, requiredCapabilities }).status, 'partial', 'capabilities without proof must not promote A7');
assert.equal(runtimeProfileSupport({ binding, targetProfileId, providerCapabilities, requiredCapabilities, proof: fullProof }).status, 'partial', 'anonymous provider profile must not promote A7');
assert.equal(runtimeProfileSupport({ binding, providerProfileId: 'native:lldb-compatible-v1:test', providerCapabilities, requiredCapabilities, proof: fullProof }).status, 'partial', 'missing target profile must not promote A7');
assert.equal(runtimeProfileSupport({ binding, providerProfileId: 'native:lldb-compatible-v1:test', targetProfileId, providerCapabilities: { ...providerCapabilities, stepInto: false }, requiredCapabilities, proof: fullProof }).status, 'partial');
assert.equal(runtimeProfileSupport({ binding, providerProfileId: 'native:lldb-compatible-v1:test', targetProfileId, providerCapabilities, proof: fullProof }).status, 'partial', 'empty required capability denominator must not promote A7');
assert.throws(() => runtimeProfileSupport({ binding, providerProfileId: 'x', targetProfileId, requiredCapabilities: ['inventedCapability'] }), /runtime-capability-unknown/);
console.log('[stage2] runtime authority tests passed');
