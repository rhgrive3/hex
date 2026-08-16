import assert from 'node:assert/strict';
import {
  aliasMemoryRegions,
  deriveMemoryRegion,
  effectSummaryAliasRelation,
  unknownStoreAliasRelation,
  unknownStoreClobbersRegion,
} from '../../js/analysis/alias/index-v2.js';

const origin = { instructionIds: ['instruction_alias_fixture'] };
const functionId = 'function_alias_fixture';
const binaryId = 'bin_alias_fixture';

function region(memoryRegion, widthBits = 32, extras = {}) {
  return deriveMemoryRegion({
    functionId,
    binaryId,
    memory: { addressSpace: extras.addressSpace ?? 'memory', addressExpr: { valueId: extras.addressValueId ?? 'value_addr' }, widthBits },
    origin: extras.origin === undefined ? origin : extras.origin,
    regionEvidence: memoryRegion,
    sourceEntityId: extras.sourceEntityId ?? 'node_access',
    unknownMetadata: extras.unknownMetadata,
  });
}

const stackA = region({ kind: 'stack-fixed', offset: -16 }, 32);
const stackSame = region({ kind: 'stack-fixed', offset: -16 }, 32);
const stackOverlap = region({ kind: 'stack-fixed', offset: -14 }, 32);
const stackDisjoint = region({ kind: 'stack-fixed', offset: -8 }, 32);
assert.equal(aliasMemoryRegions(stackA, stackSame), 'must', 'same exact stack slot');
assert.equal(aliasMemoryRegions(stackA, stackOverlap), 'may', 'overlapping stack slots');
assert.equal(aliasMemoryRegions(stackA, stackDisjoint), 'no', 'disjoint proven stack slots');

const globalA = region({ kind: 'global-absolute', address: 0x3000n }, 64);
const globalSame = region({ kind: 'global-absolute', address: '0x3000' }, 64);
const globalOverlap = region({ kind: 'global-absolute', address: 0x3004n }, 64);
assert.equal(aliasMemoryRegions(globalA, globalSame), 'must', 'same global address and range');
assert.equal(aliasMemoryRegions(globalA, globalOverlap), 'may', 'overlapping globals account for access size');
assert.equal(aliasMemoryRegions(stackA, globalA), 'no', 'legacy floor proves stack/global classes disjoint');

const fieldA = region({ kind: 'rooted-offset', rootEntityId: 'entity_root_a', offset: 16 }, 32);
const fieldSame = region({ kind: 'rooted-offset', rootEntityId: 'entity_root_a', offset: 16 }, 32);
const fieldOverlap = region({ kind: 'rooted-offset', rootEntityId: 'entity_root_a', offset: 18 }, 32);
const fieldOtherRoot = region({ kind: 'rooted-offset', rootEntityId: 'entity_root_b', offset: 16 }, 32);
assert.equal(aliasMemoryRegions(fieldA, fieldSame), 'must', 'same rooted field');
assert.equal(aliasMemoryRegions(fieldA, fieldOverlap), 'may', 'same root overlapping offsets');
assert.equal(aliasMemoryRegions(fieldA, fieldOtherRoot), 'no', 'different proven root identities');

const unknownRoot = region({ kind: 'rooted-offset', offset: 16 }, 32);
assert.equal(unknownRoot.kind, 'unknown');
assert.equal(aliasMemoryRegions(unknownRoot, fieldA), 'may', 'unknown root is not NoAlias');

const unknownIndexed = deriveMemoryRegion({
  functionId,
  binaryId,
  memory: { addressSpace: 'memory', addressExpr: { valueId: 'value_unknown_indexed' }, widthBits: 64 },
  origin,
  sourceEntityId: 'node_unknown_store',
});
assert.equal(unknownStoreAliasRelation(unknownIndexed, fieldA), 'may');
assert.equal(unknownStoreAliasRelation(unknownIndexed, globalA), 'may');
assert.equal(unknownStoreClobbersRegion(unknownIndexed, fieldA), true, 'unknown store must clobber object proof');
assert.equal(unknownStoreClobbersRegion(unknownIndexed, globalA), true, 'unknown store must clobber global proof');
assert.equal(unknownStoreClobbersRegion(unknownIndexed, stackA), true, 'stack is clobbered unless canonical disjointness is modeled');

const hintedUnknown = deriveMemoryRegion({
  functionId,
  binaryId,
  memory: { addressSpace: 'memory', addressExpr: { valueId: 'value_hinted_unknown' }, widthBits: 64 },
  origin,
  sourceEntityId: 'node_unknown_hint',
  unknownMetadata: { provenDisjointRegionKinds: ['stack-fixed'], prettyName: 'not-stack' },
});
assert.equal(unknownStoreAliasRelation(hintedUnknown, stackA), 'may', 'unvalidated metadata cannot create NoAlias');
assert.equal(unknownStoreClobbersRegion(hintedUnknown, stackA), true);
assert.equal(unknownStoreAliasRelation(hintedUnknown, globalA), 'may');
assert.equal(unknownStoreAliasRelation(hintedUnknown, fieldA), 'may');

const tls = deriveMemoryRegion({
  functionId,
  binaryId,
  memory: { addressSpace: 'tls', addressExpr: { valueId: 'value_tls' }, widthBits: 64 },
  origin,
});
const io = deriveMemoryRegion({
  functionId,
  binaryId,
  memory: { addressSpace: 'io', addressExpr: { valueId: 'value_io' }, widthBits: 64 },
  origin,
});
assert.equal(aliasMemoryRegions(tls, io), 'no', 'contract-proven distinct address spaces');
const physA = region({ kind: 'physical-space', addressSpace: 'shared-space', rootIdentity: { token: 'a' } }, 32);
const physB = region({ kind: 'physical-space', addressSpace: 'shared-space', rootIdentity: { token: 'b' } }, 32);
assert.equal(aliasMemoryRegions(physA, physB), 'unknown', 'same physical space without range proof is not NoAlias');

assert.equal(effectSummaryAliasRelation({ scope: 'unknown' }, globalA), 'may', 'unknown call/intrinsic is not pure');
assert.equal(effectSummaryAliasRelation({ scope: 'none' }, globalA), 'no', 'explicit no-write summary may prove NoAlias');
assert.equal(effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['io'] }, globalA), 'no');
assert.equal(effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['memory'] }, globalA), 'may');
assert.equal(effectSummaryAliasRelation({ scope: 'accesses', accesses: [{ id: 'a' }] }, fieldA, () => fieldSame), 'must');
assert.equal(effectSummaryAliasRelation({ scope: 'accesses', accesses: [{ id: 'a' }] }, fieldA, () => { throw new Error('bad summary'); }), 'unknown');

const malformed = region({ kind: 'global-absolute', address: 'bad' }, 32);
const missingProvenance = region({ kind: 'stack-fixed', offset: 0 }, 32, { origin: null });
assert.equal(malformed.kind, 'unknown');
assert.equal(missingProvenance.kind, 'unknown');
assert.equal(aliasMemoryRegions(malformed, globalA), 'may');
assert.equal(aliasMemoryRegions(missingProvenance, stackA), 'may');

console.log('semantic-v2 alias safety floor: PASS');
