import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createFloatValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
  createTemporaryValue,
  createVectorValue,
} from '../../js/semantics/effects/index.js';
import { canonicalSerializeSemanticIr } from '../../js/semantics/ir/function.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

let nextAddress = 0x7000n;
function bundle(overrides = {}) {
  const instructionId = createInstructionId({
    binaryId: 'bin_lowering_intrinsic',
    sliceId: 'slice_lowering_intrinsic',
    virtualAddress: nextAddress,
    decodeMode: 'neutral-mode',
    decoderSemanticVersion: '1',
  });
  nextAddress += 4n;
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'artificial-vector-machine',
    mode: 'neutral-mode',
    operations: [createMachineOperation({
      kind: 'register-write', id: 'effect.default.write',
      register: createRegisterValue('result-state', 32), value: createBitVectorValue(32, 1n),
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: { instructionIds: [instructionId], byteRanges: [{ binaryId: 'bin_lowering_intrinsic', start: nextAddress - 4n, end: nextAddress }] },
    completeness: 'exact',
    ...overrides,
  });
}
function context(name) {
  return { functionId: `function_${name}`, blockId: `block_${name}`, addressWidthBits: 64 };
}
const tmp = (id, type) => createTemporaryValue(id, type);

{
  const vectorType = createVectorValue(4, createFloatValue(32, 'ieee754-binary32'));
  const out = tmp('vector-result', vectorType);
  const access = createMemoryAccess({
    space: 'memory',
    addressExpr: { kind: 'bitvector', widthBits: 64, value: '4096' },
    widthBits: 128,
    alignment: 16,
    endian: 'little',
    volatility: false,
    atomic: true,
    ordering: 'acquire',
  });
  const summary = createIntrinsicEffectSummary({
    inputs: [createRegisterValue('vector-source', 128)],
    outputs: [out],
    registersRead: ['vector-source', 'vector-control'],
    registersWritten: ['vector-destination'],
    memoryRead: { scope: 'accesses', accesses: [access] },
    memoryWrite: { scope: 'all', spaces: ['memory', 'io'] },
    controlEffects: [{ kind: 'fallthrough' }],
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
  });
  const source = bundle({
    operations: [createMachineOperation({ kind: 'intrinsic', id: 'effect.vector.intrinsic', intrinsicId: 'synthetic.vector.fp.summary', effectSummary: summary })],
    completeness: 'exact-with-intrinsic',
  });
  const ir = lowerMachineEffectBundleToSemanticIr(source, context('intrinsic'));
  assert.equal(ir.completeness, 'complete');
  const intrinsic = ir.nodes.find((node) => node.kind === 'intrinsic' && node.operator === 'synthetic.vector.fp.summary');
  assert.ok(intrinsic);
  assert.equal(intrinsic.intrinsic.memoryRead.scope, 'accesses');
  assert.equal(intrinsic.intrinsic.memoryRead.accesses[0].widthBits, 128);
  assert.equal(intrinsic.intrinsic.memoryRead.accesses[0].atomic, true);
  assert.equal(intrinsic.intrinsic.memoryRead.accesses[0].ordering, 'acquire');
  assert.equal(intrinsic.intrinsic.memoryWrite.scope, 'all');
  assert.deepEqual(intrinsic.intrinsic.memoryWrite.addressSpaces, ['io', 'memory']);
  assert.deepEqual(intrinsic.intrinsic.stateReads.map((item) => item.physicalIdentity.registerId).sort(), ['vector-control', 'vector-source']);
  assert.deepEqual(intrinsic.intrinsic.stateWrites.map((item) => item.physicalIdentity.registerId), ['vector-destination']);
  assert.equal(intrinsic.intrinsic.controlEffects[0].kind, 'fallthrough');
  assert.equal(intrinsic.intrinsic.determinism, 'input-dependent');
  assert.equal(intrinsic.intrinsic.symbolicDetail, 'summary-only');
  assert.ok(intrinsic.origin.operationIds.includes('effect.vector.intrinsic'));
  assert.ok(intrinsic.origin.transforms.some((transform) => transform.consumedEntityIds.includes('effect.vector.intrinsic')));
}

{
  const vectorType = createVectorValue(16, createBitVectorValue(8));
  const source = bundle({
    operations: [createMachineOperation({
      kind: 'value', id: 'effect.pure.vector', opcode: 'opaque-vector-permute',
      inputs: [tmp('vector-input', vectorType)], outputs: [tmp('vector-output', vectorType)],
    })],
    completeness: 'exact',
  });
  const ir = lowerMachineEffectBundleToSemanticIr(source, context('value-intrinsic'));
  const intrinsic = ir.nodes.find((node) => node.kind === 'intrinsic' && node.operator === 'opaque-vector-permute');
  assert.ok(intrinsic, 'an unnormalized pure value operation should be summarized rather than guessed');
  assert.equal(intrinsic.intrinsic.memoryRead.scope, 'none');
  assert.equal(intrinsic.intrinsic.memoryWrite.scope, 'none');
  assert.deepEqual(intrinsic.intrinsic.stateWrites, []);
  assert.equal(intrinsic.completeness, 'complete');
}

{
  const known = createMachineOperation({
    kind: 'register-write', id: 'effect.known.write',
    register: createRegisterValue('known-state', 64), value: createBitVectorValue(64, 9n),
  });
  const source = bundle({
    operations: [known],
    completeness: 'partial',
    unknownEffects: { categories: ['flags', 'memory', 'faults'], reason: 'synthetic-partial-effects', detail: { missing: 'secondary-effects' } },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(source, context('partial'));
  assert.equal(ir.completeness, 'partial');
  assert.ok(ir.nodes.some((node) => node.kind === 'state-write' && node.variable.physicalIdentity.registerId === 'known-state'));
  assert.ok(ir.nodes.some((node) => node.kind === 'unknown-state-write'));
  assert.ok(ir.nodes.some((node) => node.kind === 'unknown-memory-effect'));
  assert.ok(ir.nodes.some((node) => node.kind === 'incomplete' && node.unknown.categories.includes('faults')));
  assert.ok(ir.unknowns.some((unknown) => unknown.reason === 'synthetic-partial-effects'));
}

{
  const source = bundle({
    operations: [],
    controlEffect: { kind: 'unknown', reason: 'synthetic-unknown-control' },
    completeness: 'unknown',
    unknownEffects: {
      categories: ['registers', 'memory', 'control', 'faults'],
      reason: 'synthetic-unknown-instruction',
    },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(source, context('unknown'));
  assert.equal(ir.completeness, 'unknown');
  assert.ok(ir.nodes.some((node) => node.kind === 'unknown-state-write'));
  assert.ok(ir.nodes.some((node) => node.kind === 'unknown-memory-effect'));
  assert.ok(ir.nodes.some((node) => node.kind === 'unknown-control-effect'));
  assert.ok(ir.nodes.some((node) => node.kind === 'incomplete'));
}

{
  const source = bundle({
    operations: [],
    statePreservation: { proven: true, reason: 'synthetic architectural no-op' },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(source, context('noop'));
  assert.equal(ir.completeness, 'complete');
  const annotation = ir.nodes.find((node) => node.operator === 'machine-effects.annotation');
  assert.ok(annotation);
  assert.equal(annotation.attributes.statePreservation.proven, true);
}

{
  const source = bundle();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => lowerMachineEffectBundleToSemanticIr(source, context('abort'), { signal: controller.signal }), /cancelled/);
  assert.throws(() => lowerMachineEffectBundleToSemanticIr(source, context('budget'), { budget: { maxNodes: 1 } }), /budget-exceeded-maxNodes/);
}

{
  const source = bundle();
  const first = lowerMachineEffectBundleToSemanticIr(source, context('determinism'));
  const second = lowerMachineEffectBundleToSemanticIr(source, context('determinism'));
  assert.equal(canonicalSerializeSemanticIr(first), canonicalSerializeSemanticIr(second));
}

console.log('semantic-v2 MachineEffects lowering intrinsic/unknown: PASS');
