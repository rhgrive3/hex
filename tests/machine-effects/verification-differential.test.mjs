import assert from 'node:assert/strict';
import {
  LEGACY_ORACLE_ROLE,
  assertDifferentialMatch,
  assertDifferentialReady,
  compareDecodedInstruction,
  runDifferentialSuite,
} from '../../tools/validation/machine-effects/differential-harness.mjs';
import { INTEGRATION_STATE } from '../../tools/validation/machine-effects/coverage-model.mjs';
import { TEST_SEMANTIC_VERSIONS, exactWriteBundle } from './verification-helpers.mjs';

const decoded = Object.freeze({ mnemonic:'movz', address:0x1000n, immediate:7n, ops:[] });
const machineLifter = (instruction) => exactWriteBundle({ address:instruction.address, value:instruction.immediate });
const compatibilityLowering = (bundle) => [{
  op:'const',
  dstReg:bundle.operations[0].register.registerId,
  dstBits:bundle.operations[0].register.widthBits,
  value:BigInt(bundle.operations[0].value.value),
}];
const legacyV1Oracle = (instruction) => [{ op:'const', dstReg:'x0', dstBits:64, value:instruction.immediate }];

const match = await compareDecodedInstruction({
  decodedInstruction:decoded,
  semanticVersions:TEST_SEMANTIC_VERSIONS,
  machineLifter,
  compatibilityLowering,
  legacyV1Oracle,
  family:'move',
});
assert.equal(match.status, 'match');
assert.equal(match.matched, true);
assert.equal(match.oracleRole, LEGACY_ORACLE_ROLE);
assert.equal(match.coverage, 'exact');
assert.equal(assertDifferentialMatch(match), true);
const serializedEffects = JSON.parse(match.machineEffectsCanonical);
assert.equal(serializedEffects.schemaVersion, 1);
assert.equal(serializedEffects.contractVersion, '1.0.0');

const mismatch = await compareDecodedInstruction({
  decodedInstruction:decoded,
  semanticVersions:TEST_SEMANTIC_VERSIONS,
  machineLifter,
  compatibilityLowering,
  legacyV1Oracle:() => [{ op:'const', dstReg:'x0', dstBits:64, value:8n }],
});
assert.equal(mismatch.status, 'mismatch');
assert.equal(mismatch.blocking, true);
assert.throws(() => assertDifferentialMatch(mismatch), /machine-effects-v1-compatibility-mismatch/);

const unsupported = await compareDecodedInstruction({
  decodedInstruction:{ mnemonic:'future', address:0x2000n },
  semanticVersions:TEST_SEMANTIC_VERSIONS,
  machineLifter:() => ({ coverage:'unsupported', bundle:null, reason:'not implemented' }),
  compatibilityLowering,
  legacyV1Oracle,
});
assert.equal(unsupported.status, 'unsupported');
assert.equal(unsupported.coverage, 'unsupported');
assert.equal(unsupported.matched, null);

let accidentallyCalled = false;
const pending = await compareDecodedInstruction({
  decodedInstruction:decoded,
  semanticVersions:TEST_SEMANTIC_VERSIONS,
  integrationState:INTEGRATION_STATE.NOT_INTEGRATED,
  machineLifter:() => { accidentallyCalled = true; },
  compatibilityLowering:() => { accidentallyCalled = true; },
  legacyV1Oracle:() => { accidentallyCalled = true; },
});
assert.equal(pending.status, INTEGRATION_STATE.NOT_INTEGRATED);
assert.equal(pending.blocking, true);
assert.equal(accidentallyCalled, false, 'not-integrated is a report state, not a silent fake execution');
assert.throws(() => assertDifferentialReady(pending), /machine-effects-differential-not-integrated/);

const suite = await runDifferentialSuite([
  { key:'move:7', decodedInstruction:decoded, family:'move' },
  { key:'move:9', decodedInstruction:{ ...decoded, address:0x1004n, immediate:9n }, family:'move' },
], {
  semanticVersions:TEST_SEMANTIC_VERSIONS,
  machineLifter,
  compatibilityLowering,
  legacyV1Oracle,
});
assert.equal(suite.total, 2);
assert.equal(suite.matches, 2);
assert.equal(suite.mismatches, 0);
assert.equal(suite.oracleRole, 'compatibility-oracle-not-isa-truth');
assert.deepEqual(suite.coverage.counts, {
  exact:2,
  'exact-with-intrinsic':0,
  partial:0,
  unknown:0,
  unsupported:0,
});

console.log('machine-effects differential harness: PASS');
