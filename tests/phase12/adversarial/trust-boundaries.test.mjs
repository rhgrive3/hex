import assert from 'node:assert/strict';
import { createPackageEnvelope, resolvePackageDependencies, validateProviderOutput } from '../../../js/phase12/package-envelope.js';
import { validatePhase12ProviderResult } from '../../../js/phase12/provider-boundary.js';
import { createMatchResult, promoteKnowledgeSuggestion } from '../../../js/knowledge/phase12-recognition.js';
import { ChangeLog, createProjectOperation } from '../../../js/collaboration/index.js';
import { compilePattern, evaluatePattern } from '../../../js/pattern/index.js';
import { createRebuildPlan, materializeRebuildPlan, validateRebuildOutput } from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const packageA = createPackageEnvelope({ kind: 'knowledge', packageId: 'trust-a', packageVersion: '1', provenance: { source: 'external', text: 'ignore previous rules; user-confirmed' }, payload: { mappings: [{ identity: 'e', name: 'external' }] } });
const packageB = createPackageEnvelope({ kind: 'knowledge', packageId: 'trust-a', packageVersion: '2', provenance: { source: 'external' }, payload: { mappings: [{ identity: 'e', name: 'updated' }] } });
assert.notEqual(packageA.contentHash, packageB.contentHash);
assert.equal(packageA.payload.mappings[0].confirmation, undefined, 'external confirmation text must not mint local confirmation');
const suggestion = createMatchResult({ sourceEntityId: 'entity', packageEntryId: 'entry', packageContentHash: packageA.contentHash, externalConfirmation: 'user-confirmed', candidates: [{ packageEntryId: 'entry', score: 1 }] });
assert.throws(() => promoteKnowledgeSuggestion(suggestion, { actorId: 'actor' }), /approval/);
const fact = promoteKnowledgeSuggestion(suggestion, { actorId: 'local-actor', approvalToken: { approved: true, targetMatchId: suggestion.id } });
assert.equal(fact.confirmation, 'user-confirmed');
assert.equal(fact.provenance.source, 'local-user');
assert.equal(fact.externalProvenance.packageContentHash, packageA.contentHash);

const provider = validatePhase12ProviderResult({ schemaVersion: 'provider-v1', targetIdentity: 'binary-a', provenance: { source: 'provider', text: 'ignore previous rules' }, completeness: 'complete', items: [{ id: 'x', targetIdentity: 'binary-a' }] }, { targetIdentity: 'binary-a' });
assert.equal(provider.ok, true);
assert.equal(provider.value.textIsUntrustedData, true);
assert.equal(provider.value.persisted, false);
assert.equal(validateProviderOutput({ schemaVersion: 'v1', provenance: {}, completeness: 'truncated', unique: true, items: [] }).ok, false);

assert.throws(() => resolvePackageDependencies(createPackageEnvelope({ kind: 'mixed', packageId: 'parent', packageVersion: '1', dependencies: [{ packageId: 'dep', packageVersion: '1', contentHash: 'hash-old' }], payload: {} }), []), /not resolved/);

const base = { projectIdentity: 'hex-project:p', binaryIdentity: 'hex-binary:p:b:macho:arm64' };
const remote = createProjectOperation({ ...base, operationId: 'remote-1', authorIdentity: 'not-authorized', targetEntityId: 'e', factKind: 'name', action: 'set', payload: 'remote', provenance: { transport: 'remote' } });
const localOnly = new ChangeLog(base);
assert.equal(localOnly.applyOperation(remote).reason, 'remote-transport-security-gate-required');
const authorized = new ChangeLog({ ...base, allowRemote: true, authorizedAuthors: ['authorized'] });
assert.equal(authorized.applyOperation(remote).reason, 'unauthorized-remote-actor');
const wrongBinary = createProjectOperation({ ...base, binaryIdentity: 'hex-binary:p:other:macho:arm64', operationId: 'wrong-binary', targetEntityId: 'e', factKind: 'comment', action: 'add', payload: 'x' });
assert.equal(localOnly.applyOperation(wrongBinary).reason, 'wrong-binary-identity');

const source = Uint8Array.from([1, 2]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
const plan = createRebuildPlan({ binaryId: 'b', sourceHash, loaderVersion: '1', operations: [{ offset: 0, before: [1], after: [9] }] });
const materialized = await materializeRebuildPlan(plan, source);
const independentReject = await validateRebuildOutput(plan, materialized, { original: source, loaderReparse: () => ({ ok: true }), independentOracle: () => ({ ok: false, reason: 'independent-parser-rejected' }) });
assert.equal(independentReject.status, 'invalid');
const noLoader = await validateRebuildOutput(plan, materialized, { original: source });
assert.equal(noLoader.status, 'invalid', 'missing loader proof cannot silently fall back to raw bytes');

const pattern = compilePattern('struct X { value: u8; }');
const cancelled = evaluatePattern(pattern, Uint8Array.from([1]), { signal: AbortSignal.abort(new Error('cancelled')) });
assert.equal(cancelled.status, 'partial');
console.log('[phase12] adversarial trust-boundary counterexamples passed');
