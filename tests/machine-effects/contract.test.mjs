import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  MACHINE_EFFECTS_CONTRACT_VERSION,
  MACHINE_EFFECTS_SCHEMA_VERSION,
  createBitVectorValue,
  createFlagValue,
  createFloatValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createLocationValue,
  createMemoryAccess,
  createPredicateValue,
  createRegisterValue,
  createVectorValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';

const INST = createInstructionId({ binaryId: 'bin_test', sliceId: 'slice_test', virtualAddress: 0x1000n, decodeMode: 'a64', decoderSemanticVersion: '1' });
const origin = () => ({ instructionIds: [INST], byteRanges: [{ binaryId: 'bin_test', start: 16n, end: 20n }] });
const reg = (id = 'x0', bits = 64) => createRegisterValue(id, bits);
const tmp = (id = 't0', bits = 64) => createTemporaryValue(id, createBitVectorValue(bits));
const fallthrough = { kind: 'fallthrough' };

function exactBundle(overrides = {}) {
  return createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [createMachineOperation({ kind: 'register-write', register: reg(), value: createBitVectorValue(64, 1n) })],
    controlEffect: fallthrough,
    possibleFaults: [],
    origin: origin(),
    completeness: 'exact',
    ...overrides,
  });
}

{
  const bundle = exactBundle();
  assert.equal(bundle.schemaVersion, MACHINE_EFFECTS_SCHEMA_VERSION);
  assert.equal(bundle.contractVersion, MACHINE_EFFECTS_CONTRACT_VERSION);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.operations[0].register.widthBits, 64);
}

{
  const summary = createIntrinsicEffectSummary({
    inputs: [reg('x0')],
    outputs: [tmp('t-auth')],
    registersRead: ['x0'],
    registersWritten: ['x0'],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  });
  const bundle = exactBundle({
    completeness: 'exact-with-intrinsic',
    operations: [createMachineOperation({ kind: 'intrinsic', intrinsicId: 'arm64e.pac', effectSummary: summary })],
  });
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.equal(bundle.operations[0].effectSummary.registersRead[0], 'x0');
}

{
  const knownWrite = createMachineOperation({ kind: 'register-write', register: reg('x1'), value: createBitVectorValue(64, 7n) });
  const bundle = exactBundle({
    operations: [knownWrite],
    completeness: 'partial',
    unknownEffects: { categories: ['memory', 'flags'], reason: 'instruction extension is not modelled' },
  });
  assert.equal(bundle.operations.length, 1, 'known effects must survive partial lowering');
  assert.deepEqual(bundle.unknownEffects.categories, ['flags', 'memory']);
  assert.equal(bundle.unknownEffects.preservation, 'not-assumed');
}

{
  const bundle = exactBundle({
    operations: [],
    controlEffect: { kind: 'unknown', reason: 'instruction semantics unsupported' },
    completeness: 'unknown',
    unknownEffects: { categories: ['registers', 'flags', 'memory', 'control', 'faults'], reason: 'instruction semantics unsupported' },
  });
  assert.equal(bundle.completeness, 'unknown');
  assert.equal(bundle.unknownEffects.preservation, 'not-assumed');
}

assert.throws(() => exactBundle({ operations: [] }), /silent-preserve/,
  'an empty fallthrough exact bundle must not be a silent unsupported-instruction fallback');
assert.doesNotThrow(() => exactBundle({
  operations: [],
  statePreservation: { proven: true, reason: 'architecturally defined no-op' },
}), 'a proven no-op may explicitly preserve state');
assert.throws(() => exactBundle({ unknownEffects: { categories: ['memory'], reason: 'unresolved' } }), /exact-has-unresolved-effects/, 'exact plus unknown effects is invalid');
assert.throws(() => exactBundle({ completeness: 'partial' }), /partial-requires-explicit-unknown-effects/);
assert.throws(() => exactBundle({ completeness: 'unknown', operations: [], controlEffect: { kind: 'unknown', reason: 'unsupported' } }), /unknown-requires-explicit-unknown-effects/);
assert.throws(() => exactBundle({ completeness: 'bogus' }), /invalid-completeness/);
assert.throws(() => exactBundle({ origin: { instructionIds: [] } }), /origin-must-reference-instruction/);
assert.throws(() => exactBundle({ callingConvention: 'aapcs64' }), /unexpected-bundle-field/, 'ABI semantics do not belong in MachineEffects');
assert.throws(() => exactBundle({ statePreservation: { proven: true, reason: 'contradiction' } }), /state-preservation-conflicts-with-effects/);

{
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => createMachineEffectBundle({
    instructionId: INST, architectureId: 'arm64', mode: 'a64',
    operations: [createMachineOperation({ kind: 'register-write', register: reg(), value: createBitVectorValue(64, 1n) })],
    controlEffect: fallthrough, possibleFaults: [], origin: origin(), completeness: 'exact',
  }, { signal: controller.signal }), /cancelled/);
  assert.throws(() => createMachineEffectBundle({
    instructionId: INST, architectureId: 'arm64', mode: 'a64',
    operations: [
      createMachineOperation({ kind: 'register-write', register: reg('x0'), value: createBitVectorValue(64, 1n) }),
      createMachineOperation({ kind: 'register-write', register: reg('x1'), value: createBitVectorValue(64, 2n) }),
    ],
    controlEffect: fallthrough, possibleFaults: [], origin: origin(), completeness: 'exact',
  }, { budget: { maxOperations: 1 } }), /budget-exceeded-maxOperations/);
}

{
  const f32 = createFloatValue(32, 'ieee754-binary32', { bitPattern: 0x3f800000n });
  const lanes = createVectorValue(4, createBitVectorValue(32));
  const mask = createPredicateValue(4, 4);
  const memory = createLocationValue('memory', { kind: 'register', registerId: 'x3', widthBits: 64 }, 64);
  const code = createLocationValue('code', { kind: 'bitvector', widthBits: 64, value: 4096n }, 32);
  const tls = createLocationValue('tls', { kind: 'register', registerId: 'tpidr', widthBits: 64 }, 64);
  assert.deepEqual([f32.kind, lanes.kind, mask.kind, memory.kind, code.kind, tls.kind], ['float','vector','predicate','memory','code','tls']);
  assert.equal(lanes.laneCount, 4, 'vectors are fixed-width by lane count');
}

{
  const narrow = createBitVectorValue(5, 0x1fn);
  assert.equal(narrow.widthBits, 5);
  assert.equal(narrow.value, '31');
  assert.throws(() => createBitVectorValue(5, 0x20n), /out-of-range/);
}

{
  const access = createMemoryAccess({
    space: 'memory',
    addressExpr: { kind: 'register', registerId: 'x2', widthBits: 64 },
    widthBits: 32,
    alignment: 4,
    endian: 'little',
    volatility: true,
    atomic: true,
    ordering: 'acquire',
  });
  const op = createMachineOperation({ kind: 'memory-read', access, value: tmp('load', 32) });
  const bundle = exactBundle({ operations: [op] });
  assert.deepEqual(bundle.operations[0].access, access);
  assert.throws(() => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 0, endian: 'little' }), /invalid-memory-width/);
  assert.throws(() => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 8, endian: 'middle' }), /invalid-endian/);
}

{
  const flag = createFlagValue('Z', 1);
  const op = createMachineOperation({ kind: 'flag-write', flag, value: createBitVectorValue(1, 1n) });
  const bundle = exactBundle({ operations: [op] });
  assert.equal(bundle.operations[0].flag.kind, 'flag');
  assert.equal(bundle.operations[0].flag.flagId, 'Z');
  assert.equal(bundle.operations[0].flag.widthBits, 1);
}

assert.throws(() => createMachineOperation({
  kind: 'register-write', register: reg(), value: createBitVectorValue(64, 1n), intrinsicId: 'ignored-before-fix',
}), /unexpected-operation-field/, 'kind-incompatible operation fields must fail closed');
assert.throws(() => createIntrinsicEffectSummary({
  inputs: [], outputs: [], registersRead: [], registersWritten: [],
  memoryRead: { scope: 'none', accesses: [{ space: 'memory', addressExpr: {}, widthBits: 8, endian: 'little' }] },
  memoryWrite: { scope: 'none' }, controlEffects: [], determinism: 'deterministic', symbolicDetail: 'available',
}), /accesses-not-allowed/, 'intrinsic memory scope must reject ignored access metadata');
assert.throws(() => createMachineOperation({ kind: 'intrinsic', intrinsicId: 'opaque' }), /intrinsic-summary-required/);
assert.throws(() => exactBundle({
  completeness: 'exact-with-intrinsic',
  operations: [createMachineOperation({
    kind: 'intrinsic', intrinsicId: 'opaque', effectSummary: {
      inputs: [], outputs: [], registersRead: [], registersWritten: [],
      memoryRead: { scope: 'unknown' }, memoryWrite: { scope: 'none' }, controlEffects: [],
      determinism: 'deterministic', symbolicDetail: 'unavailable',
    },
  })],
}), /intrinsic-completeness-invalid/, 'an incomplete intrinsic summary must not be exact');

console.log('machine-effects contract: PASS');
