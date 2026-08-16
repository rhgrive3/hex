import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

function decoded(address, mnemonic, operands) {
  return {
    address,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
  };
}

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: ARM64_ARCHITECTURE,
  decoderSemanticVersion: 'phase3-add-with-carry-regression-1',
  binaryId: 'binary_phase3_add_with_carry_projection',
  sliceId: 'slice_phase3_add_with_carry_projection',
  addressWidthBits: 64,
  entryBlockKey: 'entry',
  blocks: [{
    key: 'entry',
    startAddress: 0x1000n,
    instructions: [
      { decoded: decoded(0x1000n, 'add', 'w8, w8, #10') },
      { decoded: decoded(0x1004n, 'ret', '') },
    ],
    successors: [],
  }],
});

const machineAdd = result.machineEffects[0].operations.find((operation) => operation.kind === 'value' && operation.opcode === 'add-with-carry');
assert.ok(machineAdd, 'ARM64 exact effects must expose add-with-carry as the semantic source');

const semanticAdd = result.semanticIr.nodes.find((node) => node.kind === 'intrinsic' && node.operator === 'add-with-carry');
assert.ok(semanticAdd, 'Semantic IR must preserve the exact add-with-carry operation');

const legacyAdd = result.legacyV1.instructions.find((instruction) => instruction.sourceEntityId === semanticAdd.id);
assert.ok(legacyAdd, 'v1 compatibility must project the exact arithmetic node');
assert.equal(legacyAdd.op, 'bin');
assert.equal(legacyAdd.sub, 'add');
assert.equal(legacyAdd.extra.compatSource, 'exact-add-with-carry-intrinsic');
assert.equal(legacyAdd.args.length, 2, 'the projected add must retain lhs and rhs values');
assert.notEqual(legacyAdd.op, 'clobber', 'exact arithmetic must not degrade into a compatibility clobber');

console.log('Phase 3 exact add-with-carry v1 projection: PASS');
