import assert from 'node:assert/strict';
import { INTEGRATION_STATE } from '../../tools/validation/machine-effects/coverage-model.mjs';
import { createVerificationReport } from '../../tools/validation/machine-effects/report.mjs';

const report = createVerificationReport({
  coverageRecords:[],
  differential:null,
  integrationState:INTEGRATION_STATE.NOT_INTEGRATED,
});
assert.equal(report.integrationState, 'not-integrated');
assert.equal(report.integrationBlocking, true);
assert.equal(report.policy.missingIntegration, 'reported-as-not-integrated-and-never-counted-as-pass');
assert.equal(report.policy.productionSemanticsOwnedHere, false);
assert.equal(report.coverage.total, 0);
assert.deepEqual(report.coverage.counts, {
  exact:0,
  'exact-with-intrinsic':0,
  partial:0,
  unknown:0,
  unsupported:0,
});
assert.equal(report.legacy.oracleRole, 'compatibility-oracle-not-isa-truth');
assert.equal(report.externalOracles.defaultNetworkRequired, false);

console.log('machine-effects integration state reporting: PASS');
