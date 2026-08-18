import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { classifyMachineValueOpcode } from '../../js/semantics/ir/normalize-effects.js';

assert.equal(classifyMachineValueOpcode('srem').kind, 'binary');
assert.equal(classifyMachineValueOpcode('urem').kind, 'binary');

const instructionId = createInstructionId({
  binaryId: 'bin_riscv_remainder',
  sliceId: 'slice_riscv_remainder',
  virtualAddress: 0x8000n,
  decodeMode: 'rv64gc',
  decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'bin_riscv_remainder', start: 0n, end: 4n }],
};
const bv = (bits, value) => createBitVectorValue(bits, value);
const tmp = (id, bits) => createTemporaryValue(id, bv(bits));
const reg = (id, bits = 64) => createRegisterValue(id, bits, { view: id });
const left = tmp('left', 64);
const right = tmp('right', 64);
const signedResult = tmp('signed-result', 64);
const unsignedResult = tmp('unsigned-result', 64);

const bundle = createMachineEffectBundle({
  instructionId,
  architectureId: 'riscv64',
  mode: 'rv64gc',
  operations: [
    createMachineOperation({ kind: 'register-read', id: 'effect.read.left', register: reg('x10'), value: left }),
    createMachineOperation({ kind: 'register-read', id: 'effect.read.right', register: reg('x11'), value: right }),
    createMachineOperation({
      kind: 'value', id: 'effect.srem', opcode: 'srem', inputs: [left, right], outputs: [signedResult],
      metadata: { divisionByZero: 'dividend', signedOverflow: 'zero' },
    }),
    createMachineOperation({
      kind: 'value', id: 'effect.urem', opcode: 'urem', inputs: [left, right], outputs: [unsignedResult],
      metadata: { divisionByZero: 'dividend' },
    }),
  ],
  controlEffect: { kind: 'fallthrough' },
  possibleFaults: [],
  origin,
  completeness: 'exact',
});

const lowered = lowerMachineEffectBundleToSemanticIr(bundle, {
  functionId: 'function_riscv_remainder',
  blockId: 'block_riscv_remainder',
  addressWidthBits: 64,
});
for (const [effectId, opcode] of [['effect.srem', 'srem'], ['effect.urem', 'urem']]) {
  const node = lowered.nodes.find((candidate) => candidate.sourceEffectIds.includes(effectId));
  assert.ok(node, `missing ${opcode} node`);
  assert.equal(node.kind, 'binary', `${opcode} must stay arithmetic, not intrinsic`);
  assert.equal(node.operator, opcode);
  assert.equal(node.inputs.length, 2);
  assert.equal(node.outputs.length, 1);
  assert.equal(node.attributes.machineEffects.architectureId, 'riscv64');
  assert.ok(node.attributes.machineEffects.operationMetadata.divisionByZero);
}
assert.equal(lowered.nodes.some((node) => node.sourceEffectIds.includes('effect.srem') && node.kind === 'intrinsic'), false);
assert.equal(lowered.nodes.some((node) => node.sourceEffectIds.includes('effect.urem') && node.kind === 'intrinsic'), false);
assert.equal(lowered.unknowns.length, 0);
console.log('issue 866 RISC-V remainder Semantic IR lowering: PASS');
