import assert from 'node:assert/strict';
import { createUnknownOracleCases, runUnknownOracle, verifyUnknownCase } from '../../tools/validation/semantic-v2/unknown-oracle.mjs';

const result = await runUnknownOracle({ adapter:{
  async observeUnknown(input) {
    if (input.domain === 'semantic-ir') return { state:'unsupported', reason:'operation has no exact semantic model', sourceEntityId:input.operation.sourceEntityId };
    if (input.domain === 'ssa') return { state:'undef', reason:'no reaching definition exists', sourceEntityId:input.sourceEntityId };
    return { state:'unknown', reason:'memory address cannot be resolved safely', sourceEntityId:input.operation.sourceEntityId };
  },
} });
assert.equal(result.integrated, true);
assert.equal(result.failed, 0);
assert.equal(result.hiddenUnknownCount, 0);
assert.equal(result.passed, createUnknownOracleCases().length);

const testCase = createUnknownOracleCases()[0];
assert.equal(verifyUnknownCase(testCase, { state:'exact', reason:'guessed', sourceEntityId:'unsupported-op' }).passed, false);
assert.equal(verifyUnknownCase(testCase, { state:'unknown', reason:'', sourceEntityId:'unsupported-op' }).passed, false);

const missing = await runUnknownOracle({ adapter:null });
assert.equal(missing.integrated, false);
assert.equal(missing.blocking, true);
assert.equal(missing.hiddenUnknownCount, createUnknownOracleCases().length);
console.log('explicit unknown verification tests passed');
