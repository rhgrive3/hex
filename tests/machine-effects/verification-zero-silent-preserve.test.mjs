import assert from 'node:assert/strict';
import {
  assertNoSilentPreserve,
  silentPreserveAssessment,
} from '../../tools/validation/machine-effects/zero-silent-preserve.mjs';
import { exactWriteBundle, provenNoopBundle, unknownBundle } from './verification-helpers.mjs';

const decodedAdd = { mnemonic:'add', address:0x1000n };
assert.equal(assertNoSilentPreserve({ decodedInstruction:decodedAdd, liftResult:exactWriteBundle(), recognized:true }).safe, true);
assert.equal(assertNoSilentPreserve({ decodedInstruction:{ mnemonic:'nop' }, liftResult:provenNoopBundle(), recognized:true }).reason, 'architectural-preservation-explicitly-proven');
assert.equal(assertNoSilentPreserve({ decodedInstruction:{ mnemonic:'mystery' }, liftResult:unknownBundle(), recognized:true }).reason, 'effects-or-uncertainty-explicit');

const explicitUnsupported = { coverage:'unsupported', bundle:null, reason:'family not implemented' };
assert.equal(assertNoSilentPreserve({ decodedInstruction:{ mnemonic:'future' }, liftResult:explicitUnsupported, recognized:true }).reason, 'explicit-unsupported-without-preservation-claim');

const dangerousUnsupportedEmpty = {
  coverage:'unsupported',
  bundle:{
    completeness:'unknown',
    operations:[],
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:[],
    origin:{ instructionIds:['synthetic'] },
  },
  reason:'unsupported but accidentally emitted empty fallthrough bundle',
};
assert.equal(silentPreserveAssessment({ decodedInstruction:{ mnemonic:'future' }, liftResult:dangerousUnsupportedEmpty }).safe, false);
assert.throws(
  () => assertNoSilentPreserve({ decodedInstruction:{ mnemonic:'future' }, liftResult:dangerousUnsupportedEmpty, recognized:true }),
  /zero-silent-preserve: future: recognized-empty-bundle-looks-like-preservation/,
);

const dangerousUnknownEmpty = {
  coverage:'unknown',
  bundle:{
    completeness:'unknown',
    operations:[],
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:[],
    origin:{ instructionIds:['synthetic'] },
  },
};
assert.throws(
  () => assertNoSilentPreserve({ decodedInstruction:{ mnemonic:'paciasp' }, liftResult:dangerousUnknownEmpty, recognized:true }),
  /zero-silent-preserve/,
  'legacy empty PAC behavior must not become a MachineEffects preservation claim',
);

const unsupportedPretendingProvenNoop = {
  coverage:'unsupported',
  bundle:{
    completeness:'unknown',
    operations:[],
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:[],
    origin:{ instructionIds:['synthetic'] },
    statePreservation:{ proven:true, reason:'copied from legacy empty output' },
  },
};
assert.throws(
  () => assertNoSilentPreserve({ decodedInstruction:{ mnemonic:'autiasp' }, liftResult:unsupportedPretendingProvenNoop, recognized:true }),
  /unsupported-cannot-prove-state-preservation/,
);

console.log('machine-effects zero-silent-preserve gate: PASS');
