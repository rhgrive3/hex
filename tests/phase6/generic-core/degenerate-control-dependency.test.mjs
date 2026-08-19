import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../../js/core/identity/index.js';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

async function analyze(bytes, address = 0x1000n) {
  const capstone = await createCapstoneRiscv64Session();
  try {
    const binaryId = createBinaryIdFromDigest('e'.repeat(64));
    const sliceId = createSliceId({ binaryId, index: 0, architecture: 'riscv64' });
    const decoded = capstone.decode(Uint8Array.from(bytes), address).map((instruction) => ({
      ...instruction,
      instructionId: createInstructionId({
        binaryId, sliceId, virtualAddress: instruction.address,
        decodeMode: 'rv64imc', decoderSemanticVersion: instruction.decoderSemanticVersion,
      }),
    }));
    return analyzeDecodedSemanticFunction({
      architecture: 'riscv64', platform: 'linux', abiId: 'lp64', binaryId, sliceId,
      decoderSemanticVersion: decoded[0].decoderSemanticVersion, instructions: decoded,
      name: 'degenerate_control_dependency',
    });
  } finally { capstone.close(); }
}

const SAME_TARGET = [
  0x83, 0x20, 0x01, 0x00,
  0x63, 0x92, 0x00, 0x00,
  0x23, 0x20, 0x32, 0x00,
  0x67, 0x80, 0x00, 0x00,
];

test('same-target RISC-V branch remains a typed conditional operation', async () => {
  const analysis = await analyze(SAME_TARGET);
  console.error('DEGENERATE_DIAG', JSON.stringify(analysis.pipeline.machineEffects.map((item) => ({
    control:item.controlEffect, metadata:item.metadata,
  }))));
  const bundle = analysis.pipeline.machineEffects.find((item) => item.metadata?.degenerateConditional === true);
  assert.ok(bundle, 'the same-target branch must remain identifiable');
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(BigInt(bundle.controlEffect.target.value), 0x1008n);
  assert.equal(BigInt(bundle.controlEffect.fallthrough.value), 0x1008n);
  assert.ok(bundle.controlEffect.condition?.temporaryId, 'the syntactic comparison value must survive');
  assert.equal(bundle.metadata.conditionKind, 'direct-register-comparison');
});

test('same-target condition survives MachineEffects -> Semantic IR with an explicit producer', async () => {
  const analysis = await analyze(SAME_TARGET);
  const branches = analysis.pipeline.semanticIr.nodes.filter((node) => node.kind === 'conditional-branch');
  assert.equal(branches.length, 1, 'the degenerate operation must not lower as an unconditional branch');
  const branch = branches[0];
  assert.equal(branch.inputs.length, 1, 'the conditional node must consume its condition value');
  const producer = analysis.pipeline.semanticIr.nodes.find((node) => (node.outputs || []).includes(branch.inputs[0]));
  assert.ok(producer, 'the condition must remain queryable by typed semantic value');
  assert.equal(producer.kind, 'compare');
  assert.equal(producer.operator, 'icmp.ne', 'the canonical Semantic IR compare operator must retain the predicate');
});

test('CFG may deduplicate the same successor without erasing conditional identity', async () => {
  const analysis = await analyze(SAME_TARGET);
  const blocks = analysis.pipeline.cfg.blocks || [];
  const branchBlock = blocks.find((block) => (block.instructions || block.instructionIds || []).length || (block.successors || []).length);
  assert.ok(branchBlock || blocks.length > 0);
  for (const block of blocks) {
    const successors = block.successors || [];
    const targets = successors.map((edge) => String(edge.targetBlockId ?? edge.target ?? edge.to ?? edge.block ?? ''));
    assert.equal(new Set(targets).size, targets.length, 'duplicate successor identity must be deduplicated');
  }
  const projected = analysis.pipeline.legacyV1.instructions.filter((instruction) => instruction.op === 'cbr');
  assert.equal(projected.length, 1, 'compatibility projection must retain a conditional branch');
  assert.ok(projected[0].args?.length > 0, 'the projected cbr must retain its condition input');
});

test('ordinary two-way BNE remains unchanged', async () => {
  const analysis = await analyze([
    0x63, 0x94, 0x00, 0x00,
    0x67, 0x80, 0x00, 0x00,
    0x67, 0x80, 0x00, 0x00,
  ]);
  const bundle = analysis.pipeline.machineEffects.find((item) => item.controlEffect?.kind === 'conditional-branch');
  assert.ok(bundle);
  assert.equal(BigInt(bundle.controlEffect.target.value), 0x1008n);
  assert.equal(BigInt(bundle.controlEffect.fallthrough.value), 0x1004n);
  assert.equal(bundle.metadata.degenerateConditional, undefined);
});

test('constant compare sources do not collapse syntactic conditional identity early', async () => {
  const analysis = await analyze([
    0x93, 0x00, 0x00, 0x00,
    0x63, 0x82, 0x00, 0x00,
    0x23, 0x20, 0x32, 0x00,
    0x67, 0x80, 0x00, 0x00,
  ]);
  const bundle = analysis.pipeline.machineEffects.find((item) => item.metadata?.degenerateConditional === true);
  assert.ok(bundle);
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  const branch = analysis.pipeline.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.ok(branch?.inputs?.length === 1, 'constant truth must not erase the syntactic condition at lowering time');
});
