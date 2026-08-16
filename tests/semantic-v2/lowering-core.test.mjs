import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createFlagValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { canonicalSerializeSemanticIr } from '../../js/semantics/ir/function.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const functionId = 'function_lowering_core';
const blockId = 'block_lowering_core';
const instructionId = createInstructionId({
  binaryId: 'bin_lowering_core',
  sliceId: 'slice_lowering_core',
  virtualAddress: 0x4000n,
  decodeMode: 'synthetic-mode',
  decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'bin_lowering_core', start: 0n, end: 4n }],
};
const bv = (bits, value) => createBitVectorValue(bits, value);
const tmp = (id, bits) => createTemporaryValue(id, bv(bits));
const reg = (id, bits = 32) => createRegisterValue(id, bits, { view: `view:${id}` });

const tLeft = tmp('left', 32);
const tRight = tmp('right', 32);
const tSum = tmp('sum', 32);
const tNeg = tmp('neg', 32);
const tCmp = tmp('cmp', 1);
const tFlag = tmp('flag-read', 1);
const tSelected = tmp('selected', 32);
const tWide = tmp('wide', 64);
const tNarrow = tmp('narrow', 16);

const bundle = createMachineEffectBundle({
  instructionId,
  architectureId: 'synthetic-neutral-isa',
  mode: 'synthetic-mode',
  operations: [
    createMachineOperation({ kind: 'register-read', id: 'effect.read.left', register: reg('bank.a'), value: tLeft }),
    createMachineOperation({ kind: 'register-read', id: 'effect.read.right', register: reg('bank.b'), value: tRight }),
    createMachineOperation({ kind: 'value', id: 'effect.add', opcode: 'add', inputs: [tLeft, tRight], outputs: [tSum] }),
    createMachineOperation({ kind: 'value', id: 'effect.neg', opcode: 'neg', inputs: [tSum], outputs: [tNeg] }),
    createMachineOperation({ kind: 'value', id: 'effect.compare', opcode: 'compare.eq', inputs: [tNeg, bv(32, 7n)], outputs: [tCmp], metadata: { predicate: 'eq' } }),
    createMachineOperation({ kind: 'flag-write', id: 'effect.flag.write', flag: createFlagValue('condition-bit', 1), value: tCmp }),
    createMachineOperation({ kind: 'flag-read', id: 'effect.flag.read', flag: createFlagValue('condition-bit', 1), value: tFlag }),
    createMachineOperation({ kind: 'value', id: 'effect.select', opcode: 'select', inputs: [tFlag, tSum, bv(32, 3n)], outputs: [tSelected] }),
    createMachineOperation({ kind: 'value', id: 'effect.zext', opcode: 'zero-extend', inputs: [tSelected], outputs: [tWide], metadata: { fromBits: 32, toBits: 64 } }),
    createMachineOperation({ kind: 'value', id: 'effect.trunc', opcode: 'trunc', inputs: [tWide], outputs: [tNarrow], metadata: { fromBits: 64, toBits: 16 } }),
    createMachineOperation({ kind: 'register-write', id: 'effect.write.result', register: reg('bank.result', 16), value: tNarrow }),
  ],
  controlEffect: { kind: 'fallthrough' },
  possibleFaults: [],
  origin,
  completeness: 'exact',
});

const lowered = lowerMachineEffectBundleToSemanticIr(bundle, { functionId, blockId, addressWidthBits: 64 });
assert.equal(lowered.completeness, 'complete');
assert.equal(lowered.unknowns.length, 0);
assert.equal(lowered.blocks.length, 1);

for (const kind of ['state-read', 'binary', 'unary', 'compare', 'state-write', 'select', 'zext', 'trunc']) {
  assert.ok(lowered.nodes.some((node) => node.kind === kind), `missing lowered ${kind}`);
}

const add = lowered.nodes.find((node) => node.sourceEffectIds.includes('effect.add'));
assert.equal(add.kind, 'binary');
assert.equal(add.operator, 'add');
assert.equal(add.inputs.length, 2);
assert.equal(add.outputs.length, 1);

const compare = lowered.nodes.find((node) => node.sourceEffectIds.includes('effect.compare') && node.kind === 'compare');
assert.ok(compare);
assert.equal(compare.operator, 'compare.eq');
assert.ok(compare.attributes.machineEffects.operationMetadata.predicate === 'eq');

const constantSeven = lowered.nodes.find((node) => node.kind === 'const' && node.attributes.constant?.value === '7');
assert.ok(constantSeven, 'exact-width bitvector constants must become const nodes');
const constantSevenValue = lowered.values.find((value) => value.definitionNodeId === constantSeven.id);
assert.equal(constantSevenValue.machineType.widthBits, 32);

const resultWrite = lowered.nodes.find((node) => node.sourceEffectIds.includes('effect.write.result'));
assert.equal(resultWrite.kind, 'state-write');
assert.equal(resultWrite.variable.physicalIdentity.registerId, 'bank.result');
assert.equal(resultWrite.variable.physicalIdentity.widthBits, 16);
assert.equal(resultWrite.attributes.machineEffects.architectureId, 'synthetic-neutral-isa');

const flagNodes = lowered.nodes.filter((node) => node.variable?.physicalIdentity?.flagId === 'condition-bit');
assert.equal(flagNodes.length, 2, 'flag read/write relationship must be preserved without flag-name interpretation');

for (const entity of [...lowered.nodes, ...lowered.values]) {
  assert.ok(entity.origin.instructionIds.includes(instructionId));
  assert.ok(entity.origin.transforms.some((transform) => transform.passId === 'semantic-ir.from-machine-effects'));
}

const text = canonicalSerializeSemanticIr(lowered);
const second = lowerMachineEffectBundleToSemanticIr(bundle, { functionId, blockId, addressWidthBits: 64 });
assert.equal(text, canonicalSerializeSemanticIr(second), 'deterministic input must serialize identically');
assert.ok(!text.includes('arm64'));
assert.ok(!text.includes('x0'));
assert.ok(text.includes('synthetic-neutral-isa'));

console.log('semantic-v2 MachineEffects lowering core: PASS');
