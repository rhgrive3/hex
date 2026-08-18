import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperands } from '../../../js/arm64.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { analyzeDecodedSemanticFunction, SEMANTIC_FUNCTION_ROUTE } from '../../../js/analysis/semantic-function.js';
import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../../js/core/identity/index.js';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { createCapstoneX86Session } from '../../phase5/helpers/capstone-session.mjs';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

/**
 * The Phase 6 exit condition "cross-architecture tests demonstrate the SAME
 * middle-end" made checkable.
 *
 * The same source-level function -- `long max(long a, long b)` -- is lowered by
 * three very different machines:
 *
 *   arm64   : `cmp` writes NZCV, `b.lt` reads it        (explicit flags)
 *   x86_64  : `cmp` writes RFLAGS, `jl` reads it        (explicit flags)
 *   riscv64 : `blt` compares two registers in the branch (no flags at all)
 *
 * All three then travel the identical generic pipeline. The assertions below
 * check that the *middle-end* produced structurally equivalent results without
 * knowing which ISA it was fed, and -- crucially -- that RISC-V got there with
 * no flag state anywhere in its effects.
 */

function binaryIdentity(seed) {
  const binaryId = createBinaryIdFromDigest(seed.repeat(64).slice(0, 64));
  return { binaryId };
}

function withIds(instructions, { binaryId, sliceId, mode }) {
  return instructions.map((instruction) => ({
    ...instruction,
    instructionId: createInstructionId({
      binaryId,
      sliceId,
      virtualAddress: BigInt(instruction.address),
      decodeMode: mode,
      decoderSemanticVersion: instruction.decoderSemanticVersion,
    }),
  }));
}

/** arm64: cmp x0,x1 / b.lt L / mov x0,x0 / ret / L: mov x0,x1 / ret */
function arm64Function() {
  const { binaryId } = binaryIdentity('a');
  const sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });
  const rows = [
    { address: 0x1000n, mnemonic: 'cmp', operands: 'x0, x1' },
    { address: 0x1004n, mnemonic: 'b.lt', operands: '#0x1010', branchTarget: 0x1010n },
    { address: 0x1008n, mnemonic: 'mov', operands: 'x0, x0' },
    { address: 0x100cn, mnemonic: 'ret', operands: '' },
    { address: 0x1010n, mnemonic: 'mov', operands: 'x0, x1' },
    { address: 0x1014n, mnemonic: 'ret', operands: '' },
  ].map((row) => ({
    ...row,
    size: 4,
    length: 4,
    mode: 'a64',
    ops: parseOperands(row.operands),
    decoderSemanticVersion: 'arm64-test-decoder-v1',
  }));
  return {
    architecture: 'arm64',
    abiId: 'aapcs64',
    platform: 'linux',
    binaryId,
    sliceId,
    instructions: withIds(rows, { binaryId, sliceId, mode: 'a64' }),
    decoderSemanticVersion: 'arm64-test-decoder-v1',
  };
}

/** x86_64: cmpq %rsi,%rdi / jl L / movq %rdi,%rax / retq / L: movq %rsi,%rax / retq */
async function x86Function() {
  const capstone = await createCapstoneX86Session();
  try {
    const bytes = Uint8Array.from([
      0x48, 0x39, 0xf7,
      0x7c, 0x04,
      0x48, 0x89, 0xf8,
      0xc3,
      0x48, 0x89, 0xf0,
      0xc3,
    ]);
    const { binaryId } = binaryIdentity('b');
    const sliceId = createSliceId({ binaryId, index: 0, architecture: 'x86_64' });
    const rows = capstone.decode(bytes, 0x1000n).map((row) => createX86DecodedInstruction(row));
    return {
      architecture: 'x86_64',
      abiId: 'sysv-amd64',
      platform: 'linux',
      binaryId,
      sliceId,
      instructions: withIds(rows, { binaryId, sliceId, mode: 'long-64' }),
      decoderSemanticVersion: rows[0].decoderSemanticVersion,
    };
  } finally { capstone.close(); }
}

/** riscv64: blt a0,a1,L / ret / L: mv a0,a1 / ret */
async function riscvFunction() {
  const capstone = await createCapstoneRiscv64Session();
  try {
    const bytes = Uint8Array.from([
      0x63, 0x44, 0xb5, 0x00,       // blt a0, a1, +8
      0x67, 0x80, 0x00, 0x00,       // ret  (jalr x0, 0(ra))
      0x2e, 0x85,                   // c.mv a0, a1
      0x67, 0x80, 0x00, 0x00,       // ret
    ]);
    const { binaryId } = binaryIdentity('c');
    const sliceId = createSliceId({ binaryId, index: 0, architecture: 'riscv64' });
    const rows = capstone.decode(bytes, 0x1000n);
    return {
      architecture: 'riscv64',
      abiId: 'lp64',
      platform: 'linux',
      binaryId,
      sliceId,
      instructions: withIds(rows, { binaryId, sliceId, mode: 'rv64imc' }),
      decoderSemanticVersion: rows[0].decoderSemanticVersion,
    };
  } finally { capstone.close(); }
}

/*
 * The same loop -- `long sum(long v, long n) { long s = 0; for (long i = 0; i < n; i++) s += v; return s; }`
 * -- for each machine. A loop is the case that exercises back edges and phi
 * placement, so proving all three recover it identically is a stronger claim
 * than a single two-way branch.
 */
function arm64Loop() {
  const { binaryId } = binaryIdentity('1');
  const sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });
  const rows = [
    { address: 0x2000n, mnemonic: 'mov', operands: 'x2, #0' },
    { address: 0x2004n, mnemonic: 'mov', operands: 'x3, #0' },
    { address: 0x2008n, mnemonic: 'cmp', operands: 'x3, x1' },
    { address: 0x200cn, mnemonic: 'b.ge', operands: '#0x201c', branchTarget: 0x201cn },
    { address: 0x2010n, mnemonic: 'add', operands: 'x2, x2, x0' },
    { address: 0x2014n, mnemonic: 'add', operands: 'x3, x3, #1' },
    { address: 0x2018n, mnemonic: 'b', operands: '#0x2008', branchTarget: 0x2008n },
    { address: 0x201cn, mnemonic: 'mov', operands: 'x0, x2' },
    { address: 0x2020n, mnemonic: 'ret', operands: '' },
  ].map((row) => ({
    ...row, size: 4, length: 4, mode: 'a64',
    ops: parseOperands(row.operands), decoderSemanticVersion: 'arm64-test-decoder-v1',
  }));
  return {
    architecture: 'arm64', abiId: 'aapcs64', platform: 'linux', binaryId, sliceId,
    instructions: withIds(rows, { binaryId, sliceId, mode: 'a64' }),
    decoderSemanticVersion: 'arm64-test-decoder-v1',
  };
}

async function x86Loop() {
  const capstone = await createCapstoneX86Session();
  try {
    const bytes = Uint8Array.from([
      0x31, 0xc0, 0x31, 0xc9,
      0x48, 0x39, 0xf1, 0x7d, 0x09,
      0x48, 0x01, 0xf8, 0x48, 0x83, 0xc1, 0x01,
      0xeb, 0xf2, 0xc3,
    ]);
    const { binaryId } = binaryIdentity('2');
    const sliceId = createSliceId({ binaryId, index: 0, architecture: 'x86_64' });
    const rows = capstone.decode(bytes, 0x2000n).map((row) => createX86DecodedInstruction(row));
    return {
      architecture: 'x86_64', abiId: 'sysv-amd64', platform: 'linux', binaryId, sliceId,
      instructions: withIds(rows, { binaryId, sliceId, mode: 'long-64' }),
      decoderSemanticVersion: rows[0].decoderSemanticVersion,
    };
  } finally { capstone.close(); }
}

async function riscvLoop() {
  const capstone = await createCapstoneRiscv64Session();
  try {
    const bytes = Uint8Array.from([
      0x01, 0x46, 0x81, 0x46,
      0x63, 0xd5, 0xb6, 0x00,
      0x2a, 0x96, 0x85, 0x06,
      0xe5, 0xbf,
      0x32, 0x85,
      0x82, 0x80,
    ]);
    const { binaryId } = binaryIdentity('3');
    const sliceId = createSliceId({ binaryId, index: 0, architecture: 'riscv64' });
    const rows = capstone.decode(bytes, 0x2000n);
    return {
      architecture: 'riscv64', abiId: 'lp64', platform: 'linux', binaryId, sliceId,
      instructions: withIds(rows, { binaryId, sliceId, mode: 'rv64imc' }),
      decoderSemanticVersion: rows[0].decoderSemanticVersion,
    };
  } finally { capstone.close(); }
}

function cfgHasCycle(cfg) {
  const successors = new Map((cfg?.blocks || []).map((block) => [block.id, (block.successors || []).map((edge) => edge.to)]));
  const state = new Map();
  const visit = (id) => {
    const current = state.get(id);
    if (current === 'active') return true;
    if (current === 'done') return false;
    state.set(id, 'active');
    for (const next of successors.get(id) || []) if (successors.has(next) && visit(next)) return true;
    state.set(id, 'done');
    return false;
  };
  for (const id of successors.keys()) if (visit(id)) return true;
  return false;
}

function structuralShape(analysis) {
  const cfg = analysis.pipeline.cfg;
  const edgeKinds = cfg.blocks.flatMap((block) => (block.successors || []).map((edge) => edge.kind)).sort();
  return {
    route: analysis.route,
    pipelineVersion: analysis.pipeline.pipelineVersion,
    path: analysis.pipeline.path.join('>'),
    blockCount: cfg.blocks.length,
    edgeKinds,
    conditionalEdges: edgeKinds.filter((kind) => kind.startsWith('conditional-')).length,
    hasSsa: (analysis.pipeline.ssa?.definitions?.length ?? 0) > 0,
    hasMemorySsa: Boolean(analysis.pipeline.memorySsa?.definitions),
    projection: analysis.pipeline.legacyV1?.compat?.projection,
    decompiled: analysis.decompiler?.semantic === true,
    v2Executed: analysis.pipeline.instrumentation.v2Executed,
    provenanceLossCount: analysis.pipeline.instrumentation.provenanceLossCount,
    unsupportedInstructionCount: analysis.pipeline.instrumentation.unsupportedInstructionCount,
  };
}

function flagOperationCount(analysis) {
  return (analysis.pipeline.machineEffects || [])
    .flatMap((bundle) => bundle.operations || [])
    .filter((operation) => operation.kind === 'flag-read' || operation.kind === 'flag-write')
    .length;
}

test('arm64, x86_64 and riscv64 lower an equivalent function through the same generic middle-end', async () => {
  const inputs = [arm64Function(), await x86Function(), await riscvFunction()];
  const analyses = inputs.map((input) => analyzeDecodedSemanticFunction({ ...input, name: 'max' }));

  const shapes = analyses.map(structuralShape);
  for (const [index, shape] of shapes.entries()) {
    const architecture = inputs[index].architecture;
    assert.equal(shape.route, SEMANTIC_FUNCTION_ROUTE, `${architecture} must use the shared route`);
    assert.equal(shape.path, 'machine-effects>semantic-ir-v2>scalar-ssa>region-resolver>memoryssa>v1-compat',
      `${architecture} must traverse the same pipeline stages`);
    assert.equal(shape.v2Executed, true, `${architecture} must actually execute the v2 pipeline`);
    assert.equal(shape.provenanceLossCount, 0, `${architecture} must not lose provenance`);
    assert.equal(shape.unsupportedInstructionCount, 0, `${architecture} must not silently fall back`);
    assert.equal(shape.hasSsa, true, `${architecture} must reach SSA`);
    assert.equal(shape.hasMemorySsa, true, `${architecture} must reach MemorySSA`);
    assert.equal(shape.projection, 'semantic-ir-v2-to-v1', `${architecture} must use the shared compatibility projection`);
    assert.equal(shape.decompiled, true, `${architecture} must reach the shared decompiler`);
  }

  // The generic pipeline identity is byte-identical across architectures.
  assert.equal(new Set(shapes.map((shape) => shape.pipelineVersion)).size, 1, 'one pipeline version serves every architecture');
  assert.equal(new Set(shapes.map((shape) => shape.path)).size, 1, 'one pipeline path serves every architecture');

  // The recovered control-flow shape is the same: one two-way decision.
  for (const [index, shape] of shapes.entries()) {
    assert.equal(shape.conditionalEdges, 2,
      `${inputs[index].architecture} must recover both edges of the two-way decision (got ${JSON.stringify(shape.edgeKinds)})`);
  }
  assert.equal(new Set(shapes.map((shape) => shape.blockCount)).size, 1,
    `equivalent sources must recover the same block count: ${JSON.stringify(shapes.map((s) => [inputs[shapes.indexOf(s)]?.architecture, s.blockCount]))}`);

  // The defining Phase 6 property: the flags-bearing architectures use flag
  // effects, RISC-V uses none, and the middle-end handled both identically.
  const byArchitecture = new Map(analyses.map((analysis) => [analysis.architectureId, analysis]));
  assert.ok(flagOperationCount(byArchitecture.get('arm64')) > 0, 'arm64 genuinely models NZCV, so this is a real contrast');
  assert.ok(flagOperationCount(byArchitecture.get('x86_64')) > 0, 'x86_64 genuinely models RFLAGS, so this is a real contrast');
  assert.equal(flagOperationCount(byArchitecture.get('riscv64')), 0,
    'riscv64 must reach the same middle-end without any synthetic flag state');

  // And RISC-V has no flags register in its physical state model at all.
  assert.equal(architecturePluginV2('riscv64').registerFile().filter((r) => r.kind === 'flags').length, 0);
  assert.ok(architecturePluginV2('arm64').registerFile().some((r) => r.kind === 'flags'),
    'arm64 does declare a flags register, so the RISC-V absence is meaningful');
});

test('each architecture reaches the middle-end through its own plugin boundary, not through generic special cases', async () => {
  const inputs = [arm64Function(), await x86Function(), await riscvFunction()];
  for (const input of inputs) {
    const plugin = architecturePluginV2(input.architecture);
    assert.equal(plugin.id, input.architecture);
    assert.equal(typeof plugin.liftExact, 'function', `${input.architecture} must supply its own exact lifter`);
    assert.equal(typeof plugin.classifyControlFlow, 'function');
    assert.equal(typeof plugin.directControlTarget, 'function',
      `${input.architecture} must own direct-target recovery; the generic driver must not decode operands itself`);
    const analysis = analyzeDecodedSemanticFunction({ ...input, name: 'max' });
    assert.equal(analysis.architectureId, input.architecture);
    assert.equal(analysis.pipeline.architectureId, input.architecture);
    assert.equal(analysis.pipeline.architectureSemanticVersion, plugin.semanticVersion,
      'artifact identity must move with the architecture semantic version');
  }
});


test('all three architectures recover the same loop through the same middle-end', async () => {
  const inputs = [arm64Loop(), await x86Loop(), await riscvLoop()];
  const analyses = inputs.map((input) => analyzeDecodedSemanticFunction({ ...input, name: 'sum' }));

  for (const [index, analysis] of analyses.entries()) {
    const architecture = inputs[index].architecture;
    const shape = structuralShape(analysis);
    assert.equal(shape.v2Executed, true, `${architecture} must execute the v2 pipeline`);
    assert.equal(shape.unsupportedInstructionCount, 0, `${architecture} must lift every instruction of the loop`);
    assert.equal(shape.provenanceLossCount, 0, `${architecture} must not lose provenance across the loop`);
    assert.equal(cfgHasCycle(analysis.pipeline.cfg), true, `${architecture} must recover the loop back edge`);
    assert.equal(shape.conditionalEdges, 2, `${architecture} must recover both loop-exit edges`);
    assert.ok(shape.hasSsa, `${architecture} must build SSA across the back edge`);
    // A loop-carried value means SSA must place phis; the same generic pass
    // does it for all three.
    assert.ok((analysis.pipeline.ssa.phis?.length ?? 0) > 0 || analysis.pipeline.legacyV1.instructions.some((instruction) => instruction.op === 'phi'),
      `${architecture} must place phi nodes for the loop-carried values`);
    assert.equal(shape.decompiled, true, `${architecture} must reach the shared decompiler`);
  }

  // Same pipeline identity and same recovered topology across all three.
  const shapes = analyses.map(structuralShape);
  assert.equal(new Set(shapes.map((shape) => shape.pipelineVersion)).size, 1);
  assert.equal(new Set(shapes.map((shape) => shape.path)).size, 1);
  assert.equal(new Set(shapes.map((shape) => shape.blockCount)).size, 1,
    `equivalent loops must recover the same block count: ${JSON.stringify(shapes.map((shape, index) => [inputs[index].architecture, shape.blockCount]))}`);

  // And again: only the flag-bearing machines use flags.
  const byArchitecture = new Map(analyses.map((analysis) => [analysis.architectureId, analysis]));
  assert.ok(flagOperationCount(byArchitecture.get('arm64')) > 0);
  assert.ok(flagOperationCount(byArchitecture.get('x86_64')) > 0);
  assert.equal(flagOperationCount(byArchitecture.get('riscv64')), 0,
    'riscv64 must recover the same loop without any flag state');
});
