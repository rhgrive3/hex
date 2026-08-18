import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aliasMemoryRegions,
  deriveMemoryRegion,
  effectSummaryAliasRelation,
  unknownStoreAliasRelation,
  unknownStoreClobbersRegion,
} from '../../../js/analysis/alias/index-v2.js';

const functionId = 'function_p5_6_safety';
const binaryId = 'bin_p5_6_safety';
const origin = { instructionIds:['instruction_p5_6_safety'] };

function region(regionEvidence, widthBits = 64, extras = {}) {
  return deriveMemoryRegion({
    functionId,
    binaryId,
    memory:{ addressSpace:extras.addressSpace ?? 'memory', addressExpr:{ valueId:extras.valueId ?? 'value_p5_6' }, widthBits },
    origin:extras.origin === undefined ? origin : extras.origin,
    regionEvidence,
    sourceEntityId:extras.sourceEntityId ?? 'node_p5_6',
    unknownMetadata:extras.unknownMetadata,
  });
}

test('P5-6 unknown stores never preserve a reaching-memory proof without alias evidence', () => {
  const stack = region({ kind:'stack-fixed', offset:-32 }, 64);
  const global = region({ kind:'global-absolute', address:0x500000n }, 64);
  const object = region({ kind:'rooted-offset', rootEntityId:'entity_object', offset:24 }, 64);
  const unknown = deriveMemoryRegion({
    functionId,
    binaryId,
    memory:{ addressSpace:'memory', addressExpr:{ valueId:'value_unknown_pointer' }, widthBits:64 },
    origin,
    sourceEntityId:'node_unknown_store',
  });
  const targets = [stack, global, object];
  const failures = targets.filter((target) => unknownStoreAliasRelation(unknown, target) === 'no' || unknownStoreClobbersRegion(unknown, target) !== true);
  console.log(`P5_6_UNKNOWN_STORE_SAFETY=${JSON.stringify({ measuredTargets:targets.map((target) => target.kind), relations:targets.map((target) => unknownStoreAliasRelation(unknown, target)), unknownStoreSafetyFailures:failures.length })}`);
  assert.equal(failures.length, 0);
});

test('P5-6 unknown calls are conservatively may-alias rather than silently pure', () => {
  const global = region({ kind:'global-absolute', address:0x700000n }, 32);
  const object = region({ kind:'rooted-offset', rootEntityId:'entity_call_object', offset:8 }, 32);
  const targets = [global, object];
  const relations = targets.map((target) => effectSummaryAliasRelation({ scope:'unknown' }, target));
  const failures = relations.filter((relation) => !['may','unknown'].includes(relation));
  const explicitNone = effectSummaryAliasRelation({ scope:'none' }, global);
  console.log(`P5_6_UNKNOWN_CALL_SAFETY=${JSON.stringify({ relations, explicitNoWriteRelation:explicitNone, unknownCallSafetyFailures:failures.length })}`);
  assert.equal(failures.length, 0);
  assert.equal(explicitNone, 'no');
});

test('P5-6 malformed provenance cannot manufacture a NoAlias proof', () => {
  const exact = region({ kind:'stack-fixed', offset:0 }, 32);
  const missing = region({ kind:'stack-fixed', offset:0 }, 32, { origin:null });
  const malformed = region({ kind:'global-absolute', address:'not-an-address' }, 32);
  const relations = [aliasMemoryRegions(missing, exact), aliasMemoryRegions(malformed, exact)];
  const failures = relations.filter((relation) => relation === 'no');
  console.log(`P5_6_PROVENANCE_SAFETY=${JSON.stringify({ relations, provenanceSafetyFailures:failures.length })}`);
  assert.equal(failures.length, 0);
});
