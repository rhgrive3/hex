import assert from 'node:assert/strict';
import {
  COVERAGE_STATUS,
  INTEGRATION_STATE,
  assertCoverageFullyAccounted,
  assertIntegrated,
  createCoverageRecord,
  summarizeCoverage,
} from '../../tools/validation/machine-effects/coverage-model.mjs';
import {
  classifyLegacyInstruction,
  legacyInventoryReport,
  loadLegacyInventory,
  validateLegacyInventory,
} from '../../tools/validation/machine-effects/legacy-inventory.mjs';

const inventory = loadLegacyInventory();
const validation = validateLegacyInventory(inventory);
assert.equal(validation.valid, true);
assert.equal(validation.oracleRole, 'compatibility-oracle-not-isa-truth');
assert.ok(validation.familyCount >= 20, 'legacy inventory must enumerate semantic families rather than a generic ARM64 bucket');

const legacy = legacyInventoryReport(inventory);
assert.equal(legacy.scope.decoderSupportIncluded, false);
assert.equal(legacy.scope.newMachineEffectsSupportIncluded, false);
assert.equal(legacy.counts.emptyCompatibilityFamilies, 1);
assert.equal(legacy.counts.unknownFallbackFamilies, 1);
assert.match(legacy.percentagePolicy, /not-applicable/);

assert.equal(classifyLegacyInstruction({ mnemonic:'add' }, inventory).familyId, 'binary');
assert.equal(classifyLegacyInstruction({ mnemonic:'ldr', memory:{ kind:'load' } }, inventory).familyId, 'memory');
assert.equal(classifyLegacyInstruction({ mnemonic:'paciasp' }, inventory).familyId, 'legacy-explicit-empty');
assert.equal(classifyLegacyInstruction({ mnemonic:'madeup', writes:['x0'] }, inventory).familyId, 'fallback-unknown');
assert.equal(classifyLegacyInstruction({ mnemonic:'movi', ops:[{k:'reg'}, {k:'imm', value:0n}] }, inventory).familyId, 'vector-zero-immediate');
assert.equal(classifyLegacyInstruction({ mnemonic:'movi', ops:[{k:'reg'}, {k:'imm', value:1n}] }, inventory).familyId, 'fallback-unknown');

const records = [
  createCoverageRecord({ key:'a', mnemonic:'add', family:'binary', coverage:COVERAGE_STATUS.EXACT }),
  createCoverageRecord({ key:'b', mnemonic:'paciza', family:'arm64e', coverage:COVERAGE_STATUS.EXACT_WITH_INTRINSIC }),
  createCoverageRecord({ key:'c', mnemonic:'ldr', family:'memory', coverage:COVERAGE_STATUS.PARTIAL }),
  createCoverageRecord({ key:'d', mnemonic:'mystery', family:'system', coverage:COVERAGE_STATUS.UNKNOWN }),
  createCoverageRecord({ key:'e', mnemonic:'future', family:'system', coverage:COVERAGE_STATUS.UNSUPPORTED }),
];
const report = summarizeCoverage(records);
assertCoverageFullyAccounted(report);
assert.deepEqual(report.counts, {
  exact: 1,
  'exact-with-intrinsic': 1,
  partial: 1,
  unknown: 1,
  unsupported: 1,
});
assert.equal(report.total, 5);
assert.equal('percentage' in report, false, 'coverage must not collapse unknown/unsupported into a percentage');
assert.match(report.percentagePolicy, /unknown and unsupported/);
assert.equal(assertIntegrated(report), true);

const notIntegrated = summarizeCoverage([
  createCoverageRecord({
    key:'pending:add',
    mnemonic:'add',
    family:'binary',
    coverage:COVERAGE_STATUS.UNKNOWN,
    integrationState:INTEGRATION_STATE.NOT_INTEGRATED,
    reason:'composed lifter absent',
  }),
]);
assert.equal(notIntegrated.integrationState, INTEGRATION_STATE.NOT_INTEGRATED);
assert.throws(() => assertIntegrated(notIntegrated), /machine-effects-not-integrated/);
assert.throws(() => summarizeCoverage([
  { key:'dup', coverage:'exact' },
  { key:'dup', coverage:'unknown' },
]), /duplicate-coverage-key/);

console.log('machine-effects verification coverage: PASS');
