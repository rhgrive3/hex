import assert from 'node:assert/strict';
import { createKnowledgePack } from '../../../js/signature/index.js';
import { createPackageEnvelope, importPhase12Package, parseBoundedPackageInput, resolvePackageDependencies, validateProviderOutput } from '../../../js/phase12/package-envelope.js';
import { createMatchResult, promoteKnowledgeSuggestion, recognitionCanClaimUnique } from '../../../js/knowledge/phase12-recognition.js';

const legacy = createKnowledgePack({ architecture: 'arm64', provenance: { source: 'external', note: 'untrusted text' }, signatures: [{ architecture: 'arm64', symbols: ['_foo'] }], mappings: [{ identity: 'foo', name: 'foo' }] });
const envelope = importPhase12Package(legacy);
assert.equal(envelope.kind, 'knowledge');
assert.ok(envelope.contentHash);
assert.equal(importPhase12Package(envelope).contentHash, envelope.contentHash);

const sameA = createPackageEnvelope({ kind: 'knowledge', packageId: 'pack-a', packageVersion: '1', payload: { b: 2, a: 1 }, provenance: { source: 'one' } });
const sameB = createPackageEnvelope({ kind: 'knowledge', packageId: 'pack-a', packageVersion: '1', payload: { a: 1, b: 2 }, provenance: { source: 'two' } });
assert.equal(sameA.contentHash, sameB.contentHash, 'provenance and object insertion order are not semantic package identity');
const changed = createPackageEnvelope({ kind: 'knowledge', packageId: 'pack-a', packageVersion: '1', payload: { a: 2, b: 2 } });
assert.notEqual(changed.contentHash, sameA.contentHash);

assert.throws(() => parseBoundedPackageInput('x'.repeat(128), { maxBytes: 32 }), /package input exceeds/);
const dep = createPackageEnvelope({ kind: 'knowledge', packageId: 'dep-a', packageVersion: '1', payload: { rules: [] } });
const parent = createPackageEnvelope({ kind: 'mixed', packageId: 'parent-a', packageVersion: '1', dependencies: [{ packageId: dep.packageId, packageVersion: dep.packageVersion, contentHash: dep.contentHash }], payload: {} });
assert.equal(resolvePackageDependencies(parent, [dep])[0].contentHash, dep.contentHash);
assert.throws(() => resolvePackageDependencies(parent, []), /not resolved/);

const malformedProvider = validateProviderOutput({ schemaVersion: 1, provenance: {}, completeness: 'complete', items: [{ id: 'a' }] });
assert.equal(malformedProvider.ok, false);

const ambiguous = createMatchResult({ sourceEntityId: 'entity-a', packageEntryId: 'entry-a', packageContentHash: sameA.contentHash, candidates: [
  { packageEntryId: 'entry-a', score: 0.94, confidence: 0.94, tier: 'semantic', evidenceIds: ['e1'] },
  { packageEntryId: 'entry-b', score: 0.93, confidence: 0.93, tier: 'semantic', evidenceIds: ['e2'] },
] });
assert.equal(ambiguous.status, 'ambiguous');
assert.equal(recognitionCanClaimUnique(ambiguous), false);
const truncated = createMatchResult({ sourceEntityId: 'entity-a', packageEntryId: 'entry-a', candidates: [{ packageEntryId: 'entry-a', score: 0.99 }], candidateSearchTruncated: true });
assert.equal(truncated.completeness, 'partial');
assert.equal(truncated.unique, false);
assert.throws(() => promoteKnowledgeSuggestion(truncated, { approvalToken: { approved: true, targetMatchId: truncated.id }, actorId: 'actor-a' }), /ambiguous or truncated/);

const unique = createMatchResult({ sourceEntityId: 'entity-a', packageEntryId: 'entry-a', candidates: [{ packageEntryId: 'entry-a', score: 0.99, tier: 'exact-content' }], packageContentHash: sameA.contentHash });
const fact = promoteKnowledgeSuggestion(unique, { approvalToken: { approved: true, targetMatchId: unique.id }, actorId: 'local-user', name: 'localName' });
assert.equal(fact.confirmation, 'user-confirmed');
assert.equal(fact.externalProvenance.packageContentHash, sameA.contentHash);
console.log('[phase12] package/provenance/recognition tests passed');
