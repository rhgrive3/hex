import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import {
  createBitVectorValue,
  createFlagValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';

const INST = createInstructionId({
  binaryId: 'bin_compat', sliceId: 'slice_compat', virtualAddress: 0x1000n,
  decodeMode: 'a64', decoderSemanticVersion: '1',
});
const ORIGIN = {
  instructionIds: [INST],
  byteRanges: [{ binaryId: 'bin_compat', start: 0x20n, end: 0x24n }],
  virtualRanges: [{ imageId: 'image_compat', sliceId: 'slice_compat', start: 0x1000n, end: 0x1004n }],
};
const reg = (id, bits = 64) => createRegisterValue(id, bits);
const tmp = (id, bits = 64) => createTemporaryValue(id, createBitVectorValue(bits));
const fallthrough = { kind: 'fallthrough' };

function bundle(overrides = {}) {
  return createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [],
    controlEffect: fallthrough,
    possibleFaults: [],
    origin: ORIGIN,
    completeness: 'exact',
    statePreservation: { proven: true, reason: 'test default no-op' },
    ...overrides,
  });
}

function exactWithOperations(operations, overrides = {}) {
  return bundle({ operations, statePreservation: undefined, ...overrides });
}

// Arithmetic: explicit reads -> temporary arithmetic -> architectural write.
{
  const t0 = tmp('lhs', 32);
  const t1 = tmp('sum', 32);
  const input = exactWithOperations([
    createMachineOperation({ id: 'read-x1', kind: 'register-read', register: reg('x1', 32), value: t0 }),
    createMachineOperation({ id: 'add', kind: 'value', opcode: 'add', inputs: [t0, createBitVectorValue(32, 5n)], outputs: [t1] }),
    createMachineOperation({ id: 'write-x0', kind: 'register-write', register: reg('x0', 32), value: t1 }),
  ]);
  const lowered = lowerMachineEffectsToLegacyV1(input);
  assert.deepEqual(lowered.map((x) => x.op), [OP.MOV, OP.BIN, OP.MOV]);
  assert.equal(lowered[1].sub, 'add');
  assert.equal(lowered[1].dstReg, '$me:sum');
  assert.equal(lowered[1].dstBits, 32);
  assert.equal(lowered[1].srcs[1].value, 5n);
  assert.equal(lowered[2].dstReg, 'x0');
  assert.equal(lowered[2].srcs[0].reg, '$me:sum');
}

// Flags and comparisons remain explicit. Individual flags use deterministic
// synthetic v1 register names instead of pretending they are the whole NZCV bank.
{
  const comparison = tmp('cmp-result', 1);
  const input = exactWithOperations([
    createMachineOperation({
      id: 'cmp', kind: 'value', opcode: 'compare.eq',
      inputs: [reg('x4', 64), createBitVectorValue(64, 0n)], outputs: [comparison],
      metadata: { predicate: 'eq', signed: false },
    }),
    createMachineOperation({ id: 'write-z', kind: 'flag-write', flag: createFlagValue('Z'), value: comparison }),
  ]);
  const lowered = lowerMachineEffectsToLegacyV1(input);
  assert.equal(lowered[0].op, OP.CMP);
  assert.equal(lowered[0].comparison, 'eq');
  assert.equal(lowered[0].bits, 64);
  assert.equal(lowered[1].op, OP.MOV);
  assert.equal(lowered[1].dstReg, '$flag:Z');
  assert.equal(lowered[1].dstBits, 1);
}

// Memory widths, address source, endianness/order metadata and value source survive.
{
  const loaded = tmp('load32', 32);
  const read = createMemoryAccess({
    space: 'memory', addressExpr: reg('x2', 64), widthBits: 32,
    alignment: 4, endian: 'little', atomic: true, ordering: 'acquire',
  });
  const write = createMemoryAccess({
    space: 'memory', addressExpr: reg('x3', 64), widthBits: 16,
    alignment: 2, endian: 'little',
  });
  const input = exactWithOperations([
    createMachineOperation({ id: 'load', kind: 'memory-read', access: read, value: loaded }),
    createMachineOperation({ id: 'store', kind: 'memory-write', access: write, value: createBitVectorValue(16, 0x1234n) }),
  ]);
  const lowered = lowerMachineEffectsToLegacyV1(input);
  assert.equal(lowered[0].op, OP.LOAD);
  assert.equal(lowered[0].dstBits, 32);
  assert.equal(lowered[0].widthBits, 32);
  assert.equal(lowered[0].size, 4);
  assert.equal(lowered[0].addr.base, 'x2');
  assert.equal(lowered[0].memoryAccess.ordering, 'acquire');
  assert.equal(lowered[1].op, OP.STORE);
  assert.equal(lowered[1].widthBits, 16);
  assert.equal(lowered[1].size, 2);
  assert.equal(lowered[1].srcs[0].value, 0x1234n);
}

// Calls carry architecture control only. No AAPCS64 x0-x7/v0-v7 argument rules
// or caller-saved list are invented by this compatibility layer.
{
  const input = bundle({
    statePreservation: undefined,
    controlEffect: { kind: 'call', target: createBitVectorValue(64, 0x2000n) },
  });
  const [call] = lowerMachineEffectsToLegacyV1(input);
  assert.equal(call.op, OP.CALL);
  assert.equal(call.target, 0x2000n);
  assert.equal(call.indirect, false);
  assert.deepEqual(call.clobbers, []);
  assert.equal(call.stackArgsUnknown, true);
  assert.equal(call.argumentEvidence, 'not-classified-by-machine-effects-compat');
  assert.equal(call.srcs.length, 0);
}

// Branches preserve explicit condition/value and fallthrough without re-decoding.
{
  const input = bundle({
    statePreservation: undefined,
    controlEffect: {
      kind: 'conditional-branch',
      target: createBitVectorValue(64, 0x3000n),
      fallthrough: createBitVectorValue(64, 0x1004n),
      condition: reg('x5', 64),
    },
  });
  const [branch] = lowerMachineEffectsToLegacyV1(input);
  assert.equal(branch.op, OP.CBR);
  assert.equal(branch.kind, 'cbnz');
  assert.equal(branch.target, 0x3000n);
  assert.equal(branch.srcs[0].reg, 'x5');
  assert.equal(branch.fallthrough.kind, 'bitvector');
}

// Completely unknown state never lowers to a clean no-op.
{
  const input = bundle({
    operations: [],
    statePreservation: undefined,
    controlEffect: { kind: 'unknown', reason: 'unsupported instruction' },
    completeness: 'unknown',
    unknownEffects: {
      categories: ['registers', 'flags', 'memory', 'control'],
      reason: 'unsupported instruction',
    },
  });
  const lowered = lowerMachineEffectsToLegacyV1(input);
  assert.equal(lowered.length, 1);
  assert.equal(lowered[0].op, OP.UNKNOWN);
  assert.deepEqual(lowered[0].unknownCategories, ['control', 'flags', 'memory', 'registers']);
  assert.equal(lowered[0].unknownRegisters, true);
}

// Partial bundles keep known effects and append a conservative unknown/clobber marker.
{
  const input = exactWithOperations([
    createMachineOperation({ id: 'known-write', kind: 'register-write', register: reg('x7', 64), value: createBitVectorValue(64, 7n) }),
  ], {
    completeness: 'partial',
    unknownEffects: { categories: ['memory', 'flags'], reason: 'remaining effects unavailable' },
  });
  const lowered = lowerMachineEffectsToLegacyV1(input);
  assert.equal(lowered[0].op, OP.CONST);
  assert.equal(lowered[0].dstReg, 'x7');
  assert.equal(lowered[0].value, 7n);
  assert.equal(lowered[1].op, OP.UNKNOWN);
  assert.deepEqual(lowered[1].unknownCategories, ['flags', 'memory']);
}

// Intrinsics preserve their effect summary. Register-only summaries use CLOBBER;
// memory-writing summaries additionally become a v1 UNKNOWN memory barrier.
{
  const authOut = tmp('auth-result', 64);
  const summary = createIntrinsicEffectSummary({
    inputs: [reg('x9', 64)], outputs: [authOut],
    registersRead: ['x9'], registersWritten: ['x10'],
    memoryRead: { scope: 'none' }, memoryWrite: { scope: 'all', spaces: ['memory'] },
    controlEffects: [], determinism: 'deterministic', symbolicDetail: 'summary-only',
  });
  const input = exactWithOperations([
    createMachineOperation({ id: 'intrinsic', kind: 'intrinsic', intrinsicId: 'arm64e.test', effectSummary: summary }),
  ], { completeness: 'exact-with-intrinsic' });
  const lowered = lowerMachineEffectsToLegacyV1(input);
  assert.equal(lowered[0].op, OP.CLOBBER);
  assert.equal(lowered[0].intrinsicId, 'arm64e.test');
  assert.deepEqual(lowered[0].clobbers, ['x10']);
  assert.deepEqual(lowered[0].extraWrites, ['$me:auth-result']);
  assert.equal(lowered[1].op, OP.UNKNOWN);
  assert.deepEqual(lowered[1].unknownCategories, ['memory']);
}

// Provenance is copied exactly onto every lowered instruction and operation IDs
// stay linked to the specific MachineEffect operation that produced them.
{
  const input = exactWithOperations([
    createMachineOperation({ id: 'provenance-write', kind: 'register-write', register: reg('x11', 64), value: createBitVectorValue(64, 1n) }),
  ]);
  const first = lowerMachineEffectsToLegacyV1(input);
  const second = lowerMachineEffectsToLegacyV1(input);
  assert.deepEqual(first, second, 'compat lowering must be deterministic');
  assert.equal(first[0].instructionId, INST);
  assert.equal(first[0].effectOperationId, 'provenance-write');
  assert.deepEqual(first[0].origin, input.origin);
  assert.equal(first[0].address, 0x1000n);
}

assert.throws(() => lowerMachineEffectsToLegacyV1(createMachineEffectBundle({
  instructionId: INST,
  architectureId: 'x86_64',
  mode: 'long',
  operations: [],
  controlEffect: fallthrough,
  possibleFaults: [],
  origin: ORIGIN,
  completeness: 'exact',
  statePreservation: { proven: true, reason: 'test no-op' },
})), /unsupported-architecture/);

console.log('machine-effects v1 compat lowering: PASS');
