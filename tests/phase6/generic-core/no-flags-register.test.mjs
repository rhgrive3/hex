import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../../js/core/identity/index.js';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

async function analyze(bytes, { address = 0x1000n, name = 'sample' } = {}) {
  const capstone = await createCapstoneRiscv64Session();
  try {
    const binaryId = createBinaryIdFromDigest('d'.repeat(64));
    const sliceId = createSliceId({ binaryId, index: 0, architecture: 'riscv64' });
    const decoded = capstone.decode(Uint8Array.from(bytes), address).map((instruction) => ({
      ...instruction,
      instructionId: createInstructionId({
        binaryId, sliceId, virtualAddress: instruction.address,
        decodeMode: 'rv64imc', decoderSemanticVersion: instruction.decoderSemanticVersion,
      }),
    }));
    return analyzeDecodedSemanticFunction({
      architecture: 'riscv64', platform: 'linux', abiId: 'lp64',
      binaryId, sliceId, decoderSemanticVersion: decoded[0].decoderSemanticVersion,
      instructions: decoded, name,
    });
  } finally { capstone.close(); }
}

/* blt a0,a1,+8 / ret / c.mv a0,a1 / ret */
const TWO_WAY = [
  0x63, 0x44, 0xb5, 0x00,
  0x67, 0x80, 0x00, 0x00,
  0x2e, 0x85,
  0x67, 0x80, 0x00, 0x00,
];

test('a direct register comparison drives CFG edges without any flag state', async () => {
  const analysis = await analyze(TWO_WAY);
  const flagOperations = analysis.pipeline.machineEffects
    .flatMap((bundle) => bundle.operations || [])
    .filter((operation) => operation.kind === 'flag-read' || operation.kind === 'flag-write');
  assert.deepEqual(flagOperations, [], 'no flag effect may appear anywhere in the function');

  const edges = analysis.pipeline.cfg.blocks.flatMap((block) => (block.successors || []).map((edge) => edge.kind));
  assert.ok(edges.includes('conditional-true'), 'the taken edge must be recovered');
  assert.ok(edges.includes('conditional-false'), 'the fallthrough edge must be recovered');
});

test('the branch condition survives into Semantic IR as a value, not as a flag read', async () => {
  const analysis = await analyze(TWO_WAY);
  const branchNodes = analysis.pipeline.semanticIr.nodes.filter((node) => node.kind === 'conditional-branch');
  assert.equal(branchNodes.length, 1, 'exactly one conditional branch is expected');
  const [branch] = branchNodes;
  assert.equal(branch.inputs.length, 1, 'the branch consumes exactly one condition value');

  const producer = analysis.pipeline.semanticIr.nodes.find((node) => (node.outputs || []).includes(branch.inputs[0]));
  assert.ok(producer, 'the condition must have an explicit producer in Semantic IR');
  assert.equal(producer.kind, 'compare', 'the condition is a comparison value, not a state read');

  // Nothing in the function reads architectural state to obtain the condition.
  const stateReads = analysis.pipeline.semanticIr.nodes.filter((node) => node.kind === 'state-read');
  for (const read of stateReads) {
    assert.notEqual(read.outputs?.[0], branch.inputs[0], 'the branch condition must not come from a state read');
  }
});

test('the condition reaches SSA and the shared decompiler with its comparison meaning intact', async () => {
  const analysis = await analyze(TWO_WAY);
  assert.ok(analysis.pipeline.ssa.definitions.length > 0, 'SSA must be built');
  const projected = analysis.pipeline.legacyV1.instructions.filter((instruction) => instruction.op === 'cbr');
  assert.equal(projected.length, 1, 'the conditional branch must survive the compatibility projection');

  assert.equal(analysis.decompiler.semantic, true);
  const text = String(analysis.decompiler.pseudocode);
  assert.match(text, /if \(/, 'the decompiler must recover an if from a flagless conditional branch');
  assert.doesNotMatch(text, /nzcv|NZCV|rflags|RFLAGS|__arm64_condition/i,
    'no AArch64 flag vocabulary may appear in RISC-V decompiler output');
});

test('generic middle-end modules do not name RISC-V or branch on architecture ids', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const modules = [
    'js/analysis/semantic-function.js',
    'js/semantics/compat/index.js',
    'js/semantics/compat/semantic-ir-v2-to-v1.js',
    'js/semantics/compat/semantic-ir-v2-to-v1-nodes.js',
    'js/semantics/ir/from-machine-effects.js',
    'js/semantics/ir/normalize-effects.js',
    'js/semantics/cfg/index.js',
    'js/semantics/ssa/index.js',
    'js/semantics/memoryssa/index.js',
    'js/analysis/alias/index-v2.js',
    'js/decompiler/semantic.js',
    'js/decompiler/semantic-core.js',
    'js/decompiler/type-recovery.js',
  ];
  for (const relative of modules) {
    const source = await readFile(path.join(root, relative), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.doesNotMatch(code, /riscv/i, `${relative} must not name RISC-V outside comments`);
    assert.doesNotMatch(code, /architectureId\s*===\s*['"]/, `${relative} must not branch on an architecture id`);
    assert.doesNotMatch(code, /\barch(?:itecture)?\s*===\s*['"]/, `${relative} must not branch on an architecture name`);
  }
});

test('unknown memory and unknown calls stay conservative on the RISC-V path', async () => {
  // sd a1,0(a0) / ld a2,0(a0) / jalr ra,0(a2) / ret
  const analysis = await analyze([
    0x23, 0x30, 0xb5, 0x00,
    0x03, 0x36, 0x05, 0x00,
    0xe7, 0x00, 0x06, 0x00,
    0x67, 0x80, 0x00, 0x00,
  ]);
  const regions = analysis.pipeline.regions || [];
  for (const region of regions) {
    assert.notEqual(region.kind, 'no-alias', 'an unproven memory region must never be classified as NoAlias');
  }
  const callBundles = analysis.pipeline.machineEffects.filter((bundle) => bundle.controlEffect?.kind === 'call');
  assert.equal(callBundles.length, 1, 'the indirect call must be recognised');
  assert.notEqual(callBundles[0].controlEffect.target?.kind, 'absolute-address',
    'an indirect call target must not be reported as a decode-time constant');
  assert.equal(analysis.pipeline.instrumentation.unsupportedInstructionCount, 0);
});
