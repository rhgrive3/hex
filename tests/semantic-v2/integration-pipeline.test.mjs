import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import {
  SEMANTIC_V2_COMPAT_PATH,
  SEMANTIC_V2_MIGRATION_MODES,
  buildSemanticV2CompatibilityPipeline,
} from '../../js/semantics/compat/index.js';

const plugin = Object.freeze({
  id: 'test-architecture',
  semanticVersion: 'test-semantics-1',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    const base = {
      instructionId: decoded.instructionId,
      architectureId: 'test-architecture',
      mode: decoded.mode,
      possibleFaults: [],
      origin: decoded.origin,
    };
    const address = (value) => ({ kind: 'absolute-address', value: `0x${BigInt(value).toString(16)}`, widthBits: 64 });
    const reg = { kind: 'register', registerId: 'state0', widthBits: 32 };
    if (decoded.testKind === 'cond') return createMachineEffectBundle({
      ...base,
      operations: [],
      controlEffect: {
        kind: 'conditional-branch',
        target: address(decoded.trueTarget),
        fallthrough: address(decoded.falseTarget),
        condition: { kind: 'bitvector', widthBits: 1, value: '1' },
      },
      completeness: 'exact',
    });
    if (decoded.testKind === 'write-branch') return createMachineEffectBundle({
      ...base,
      operations: [{
        id: `${decoded.instructionId}:write`, kind: 'register-write', register: reg,
        value: { kind: 'bitvector', widthBits: 32, value: String(decoded.value) },
      }],
      controlEffect: { kind: 'branch', target: address(decoded.target) },
      completeness: 'exact',
    });
    if (decoded.testKind === 'read-return') return createMachineEffectBundle({
      ...base,
      operations: [{
        id: `${decoded.instructionId}:read`, kind: 'register-read', register: reg,
        value: { kind: 'bitvector', widthBits: 32 },
      }],
      controlEffect: { kind: 'return' },
      completeness: 'exact',
    });
    return null;
  },
});

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'test-decoder-1',
  binaryId: 'binary_integration_fixture',
  sliceId: 'slice_integration_fixture',
  addressWidthBits: 64,
  entryBlockKey: 'entry',
  blocks: [
    {
      key: 'entry', startAddress: 0x1000n,
      instructions: [{ decoded: { address: 0x1000n, mode: 'test', testKind: 'cond', trueTarget: 0x1010n, falseTarget: 0x1020n } }],
      successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }],
    },
    {
      key: 'left', startAddress: 0x1010n,
      instructions: [{ decoded: { address: 0x1010n, mode: 'test', testKind: 'write-branch', value: 1, target: 0x1030n } }],
      successors: [{ to: 'merge', kind: 'branch' }],
    },
    {
      key: 'right', startAddress: 0x1020n,
      instructions: [{ decoded: { address: 0x1020n, mode: 'test', testKind: 'write-branch', value: 2, target: 0x1030n } }],
      successors: [{ to: 'merge', kind: 'branch' }],
    },
    {
      key: 'merge', startAddress: 0x1030n,
      instructions: [{ decoded: { address: 0x1030n, mode: 'test', testKind: 'read-return' } }],
      successors: [],
    },
  ],
});

assert.equal(result.mode, SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
assert.deepEqual(result.path, SEMANTIC_V2_COMPAT_PATH);
assert.equal(result.semanticSchemaVersion, 2);
assert.equal(result.scalarSsaPassVersion, '1.0.0');
assert.equal(result.memorySsaPassVersion, '1.0.0');
assert.equal(result.instrumentation.v2Executed, true);
assert.equal(result.instrumentation.unsupportedInstructionCount, 0);
assert.equal(result.machineEffects.length, 4);
assert.equal(result.ssa.definitions.some((definition) => definition.kind === 'phi' && definition.variableKey?.includes('state0')), true);
assert.equal(result.legacyV1.compat.scalarSsa, true);
assert.equal(result.legacyV1.compat.memorySsa, true);
console.log('Phase 3 explicit Semantic IR v2 SSA pipeline: PASS');
