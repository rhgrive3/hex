import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { createBitVectorValue, createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';

const instructionId = createInstructionId({
  binaryId: 'bin_compat_return', sliceId: 'slice_compat_return', virtualAddress: 0x4000n,
  decodeMode: 'a64', decoderSemanticVersion: '1',
});

const effects = createMachineEffectBundle({
  instructionId,
  architectureId: 'arm64',
  mode: 'a64',
  operations: [],
  controlEffect: { kind: 'return', target: createBitVectorValue(64, 0x5000n) },
  possibleFaults: [],
  origin: { instructionIds: [instructionId], virtualRanges: [{ start: 0x4000n, end: 0x4004n }] },
  completeness: 'exact',
});

const [ret] = lowerMachineEffectsToLegacyV1(effects);
assert.equal(ret.op, OP.RET);
assert.deepEqual(ret.srcs, [], 'architecture return target must not be invented as an ABI return value');
assert.equal(ret.returnReg, null);
assert.equal(ret.returnEvidence, null);
assert.equal(ret.architectureReturnTarget.kind, 'bitvector');
assert.equal(ret.architectureReturnTarget.value, '20480');
assert.equal(ret.origin.instructionIds[0], instructionId);

console.log('machine-effects v1 compat return: PASS');
