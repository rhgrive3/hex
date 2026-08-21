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
function transactionFor(format) {
  return createRebuildTransaction({
    binaryId: `binary:${format}:test`,
    sourceHash,
    format,
    architecture: format === 'pe' ? 'x86_64' : 'arm64',
    loaderVersion: `loader:${format}:test`,
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: true,
  });
}

const transaction = transactionFor('macho');
assert.equal(transaction.sizeDelta, 1);
assert.ok(transaction.requiredValidators.includes('relocations'));
assert.ok(transaction.requiredValidators.includes('independent-differential'));
assert.equal((await materializeRebuildTransaction(transaction, source, { maxOutputBytes: Number.NaN })).reason, 'rebuild-v2-max-output-budget-invalid');
assert.equal((await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 4 })).reason, 'rebuild-v2-output-budget-exceeded');

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
assert.equal(validation.validators.find((item) => item.validator === 'evidence').reason, null);

assert.equal((await publishRebuildTransaction(materialized, validation)).reason, 'rebuild-v2-atomic-promotion-required');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true }) })).reason, 'rebuild-v2-publication-not-atomic');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'unsafe-copy', publicationIdentity: 'x' }) })).reason, 'rebuild-v2-publication-protocol-invalid');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store' }) })).reason, 'rebuild-v2-publication-identity-required');
const publication = await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'artifact:rebuilt:1' }) });
assert.equal(publication.status, 'published');
assert.equal(publication.atomic, true);
assert.equal(publication.committed, true);

const incompleteTruth = rebuildProfileSupport({ transaction, validation, publication, proof: { exactHead: true, negativeValidatorTest: true, staleIdentityTest: true } });
assert.equal(incompleteTruth.status, 'unsupported', 'one green operation must not promote a whole format F6 profile');
const truth = rebuildProfileSupport({ transaction, validation, publication, proof: {
  exactHead: true,
  negativeValidatorTest: true,
  staleIdentityTest: true,
  formatSpecificValidatorTests: true,
  atomicInterruptionTest: true,
  realFixture: true,
  profileDenominatorComplete: true,
  formatProfileIds: ['macho:64'],
} });
assert.equal(truth.status, 'supported-for-exact-rebuild-profile');
assert.equal(truth.formatCoverageComplete, true);

for (const format of ['macho', 'elf', 'pe']) {
  const tx = transactionFor(format);
  const material = await materializeRebuildTransaction(tx, source, { maxOutputBytes: 1024 });
  assert.equal(material.status, 'materialized', `${format} transaction contract should materialize`);
  assert.equal(tx.format, format);
}

const stale = await materializeRebuildTransaction(transaction, Uint8Array.from([1, 7, 3, 4]));
assert.equal(stale.reason, 'rebuild-v2-source-identity-mismatch');
console.log('[stage2] validated size-changing rebuild tests passed');
