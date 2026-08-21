import assert from 'node:assert/strict';
import { ChangeLog } from '../../js/collaboration/index.js';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  remoteCollaborationSupport,
} from '../../js/collaboration/remote-authority.js';
import { applyRemoteEnvelopeQueued } from '../../js/collaboration/remote-delivery.js';

function gate() {
  return new RemoteCollaborationGate({
    projectIdentity: 'project:1',
    binaryIdentity: 'binary:1',
    sessionIdentity: 'collab-session:1',
    allowedActors: { alice: ['*'], bob: ['fact:name', 'action:set'] },
    maxBatch: 8,
    maxMessageBytes: 65536,
  });
}
function log() {
  return new ChangeLog({ projectIdentity: 'project:1', binaryIdentity: 'binary:1', allowRemote: true, authorizedAuthors: ['alice', 'bob'] });
}
function envelope({ actor = 'alice', device = 'device:a', messageId, sequence, operations, projectIdentity = 'project:1', binaryIdentity = 'binary:1', rawBinaryBytes = false }) {
  return createRemoteCollaborationEnvelope({
    projectIdentity,
    binaryIdentity,
    sessionIdentity: 'collab-session:1',
    actorIdentity: actor,
    deviceIdentity: device,
    messageId,
    sequence,
    operations,
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:test' },
    egress: { userAuthorized: true, rawBinaryBytes, derivedDataOnly: !rawBinaryBytes },
  });
}

const remoteGate = gate();
const remoteLog = log();
const child = envelope({ messageId: 'msg:child', sequence: 1, operations: [{ operationId: 'op:child', targetEntityId: 'fn:1', factKind: 'type', action: 'set', payload: 'int', causalParents: ['op:parent'] }] });
const childResult = applyRemoteEnvelopeQueued(remoteLog, remoteGate, child);
assert.equal(childResult.status, 'accepted-with-pending-dependencies');
assert.deepEqual(childResult.unresolvedOperationIds, ['op:child']);

const parent = envelope({ messageId: 'msg:parent', sequence: 2, operations: [{ operationId: 'op:parent', targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'main' }] });
const parentResult = applyRemoteEnvelopeQueued(remoteLog, remoteGate, parent);
assert.equal(parentResult.status, 'applied');
assert.deepEqual(parentResult.unresolvedOperationIds, []);
assert.ok(remoteLog.appliedOperationIds().includes('op:child'));
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, parent).reason, 'remote-replay-or-duplicate');

const wrongProject = envelope({ messageId: 'msg:wrong-project', sequence: 3, projectIdentity: 'project:other', operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, wrongProject).reason, 'remote-wrong-project');
const raw = envelope({ messageId: 'msg:raw', sequence: 3, rawBinaryBytes: true, operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, raw).reason, 'remote-raw-binary-egress-forbidden');
remoteGate.revoke('alice');
const revoked = envelope({ messageId: 'msg:revoked', sequence: 3, operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, revoked).reason, 'remote-actor-revoked');

const bigintGate = gate();
const bigintLog = log();
const bigintEnvelope = envelope({
  messageId: 'msg:bigint', sequence: 1,
  operations: [{ operationId: 'op:bigint', targetEntityId: 'fn:3', factKind: 'address', action: 'set', payload: 0x123456789abcdefn }],
});
assert.notEqual(applyRemoteEnvelopeQueued(bigintLog, bigintGate, bigintEnvelope).status, 'rejected');

const envA = envelope({ messageId: 'msg:a', sequence: 1, operations: [{ operationId: 'op:a', targetEntityId: 'fn:2', factKind: 'name', action: 'set', payload: 'A' }] });
const envB = envelope({ actor: 'bob', device: 'device:b', messageId: 'msg:b', sequence: 1, operations: [{ operationId: 'op:b', targetEntityId: 'fn:2', factKind: 'name', action: 'set', payload: 'B' }] });
const logAB = log(), logBA = log(), gateAB = gate(), gateBA = gate();
assert.notEqual(applyRemoteEnvelopeQueued(logAB, gateAB, envA).status, 'rejected');
assert.notEqual(applyRemoteEnvelopeQueued(logAB, gateAB, envB).status, 'rejected');
assert.notEqual(applyRemoteEnvelopeQueued(logBA, gateBA, envB).status, 'rejected');
assert.notEqual(applyRemoteEnvelopeQueued(logBA, gateBA, envA).status, 'rejected');
assert.deepEqual(logAB.snapshot().facts, logBA.snapshot().facts);

assert.equal(remoteCollaborationSupport({ gate: gate(), proof: {
  exactHead: true,
  replayTests: true,
  identityTests: true,
  authorizationTests: true,
  transportSecurityTests: true,
  privacyTests: true,
  convergenceTests: true,
} }).status, 'supported-for-exact-security-profile');
console.log('[stage2] remote collaboration security/reconnect tests passed');
