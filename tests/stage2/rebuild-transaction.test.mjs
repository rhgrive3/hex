import assert from 'node:assert/strict';
import { stableDigest } from '../../js/core/identity/index.js';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  rebuildProfileSupport,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';

const source = Uint8Array.from([1, 2, 3, 4]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
const transaction = createRebuildTransaction({
  binaryId: 'binary:test',
  sourceHash,
  format: 'macho',
  architecture: 'arm64',
  loaderVersion: 'loader:test',
  operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
  impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
  requireIndependentOracle: true,
});
assert.equal(transaction.sizeDelta, 1);
assert.ok(transaction.requiredValidators.includes('relocations'));
assert.ok(transaction.requiredValidators.includes('independent-differential'));

const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');
assert.deepEqual([...materialized.bytes], [1, 9, 8, 3, 4]);
assert.equal(materialized.outputLength, 5);

const external = {
  layout: ({ materialized }) => ({ ok: materialized.outputLength === 5 }),
  relocations: () => ({ ok: true, checked: 1 }),
  'branch-ranges': () => ({ ok: true, checked: 1 }),
  unwind: () => ({ ok: true, checked: 1 }),
  'imports-exports': () => ({ ok: true, checked: 1 }),
  'signature-consequence': () => ({ ok: true, consequence: 'signature-invalidated-and-requires-resign' }),
};

const missingRelocation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: () => ({ ok: true }),
  validators: { ...external, relocations: undefined },
});
assert.equal(missingRelocation.status, 'invalid');
const relocationFailure = missingRelocation.validators.find((item) => item.validator === 'relocations');
assert.equal(relocationFailure.executed, false);
assert.equal(relocationFailure.status, 'failed');
assert.equal(relocationFailure.reason, 'required-validator-unavailable');

const validation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: ({ output }) => ({ ok: output.length === 5 }),
  independentOracle: ({ output }) => ({ ok: output[1] === 9 && output[2] === 8 }),
  validators: external,
});
assert.equal(validation.status, 'valid');
assert.equal(validation.allRequiredExecuted, true);
assert.equal(validation.validators.every((item) => item.executed && item.status === 'passed'), true);

assert.equal((await publishRebuildTransaction(materialized, validation)).reason, 'rebuild-v2-atomic-promotion-required');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: false }) })).reason, 'rebuild-v2-publication-not-atomic');
const publication = await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true, publicationIdentity: 'artifact:rebuilt:1' }) });
assert.equal(publication.status, 'published');
assert.equal(publication.atomic, true);

const truth = rebuildProfileSupport({ transaction, validation, publication, proof: { exactHead: true, negativeValidatorTest: true, staleIdentityTest: true } });
assert.equal(truth.status, 'supported-for-exact-rebuild-profile');

const stale = await materializeRebuildTransaction(transaction, Uint8Array.from([1, 7, 3, 4]));
assert.equal(stale.reason, 'rebuild-v2-source-identity-mismatch');
console.log('[stage2] validated size-changing rebuild tests passed');
