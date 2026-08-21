import assert from 'node:assert/strict';
import { createPackageEnvelope, createProjectOperation, compilePattern, createRebuildPlan, validatePhase12ProviderResult } from '../../../js/phase12/index.js';
import { currentSupportMatrix } from '../../../js/platform/capability-maturity.js';

assert.equal(createPackageEnvelope({ kind: 'patterns', packageId: 'p12', packageVersion: '1', payload: { patterns: [] } }).kind, 'patterns');
assert.equal(createProjectOperation({ projectIdentity: 'hex-project:p', targetEntityId: 'hex-entity:e', factKind: 'comment', action: 'add', payload: 'ok' }).schemaVersion, 'hex-project-operation-v1');
assert.ok(compilePattern('struct X { value: u8; }').patternId);
assert.equal(createRebuildPlan({ binaryId: 'b', sourceHash: 'bytes:x', loaderVersion: '1', operations: [{ offset: 0, before: [1], after: [2] }] }).authority, 'L3-explicit-proposal');
const provider = validatePhase12ProviderResult({ schemaVersion: 'provider-v1', targetIdentity: 'hex-binary:b', provenance: { source: 'external' }, completeness: 'complete', items: [{ id: 'candidate-1', targetIdentity: 'hex-binary:b' }] }, { targetIdentity: 'hex-binary:b' });
assert.equal(provider.ok, true);
assert.equal(provider.value.persisted, false);
assert.equal(currentSupportMatrix().phase12.rebuild.authority, 'R0-shadow-only');
assert.equal(currentSupportMatrix().phase12.collaboration.authority, 'local-canonical-only');
console.log('[phase12] integration facade/provider boundary tests passed');
