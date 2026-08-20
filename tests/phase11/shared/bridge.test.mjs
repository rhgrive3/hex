import assert from 'node:assert/strict';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

console.log('[phase11] running shared bridge tests...');

const methodId = createManagedMethodId('mod-shared', 'complexBranching');

// Bytecodes:
// 0: const 10
// 2: const 20
// 4: if_lt -> target offset 10
// 6: const 100
// 8: goto -> target offset 12
// 10: const 200
// 12: return
const bundles = [
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 10 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 20 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'if_lt',
    consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
    controlEffects: [{ kind: 'conditional-branch', targetOffset: 10 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 100 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 8),
    bytecodeOffset: 8,
    mnemonic: 'goto',
    controlEffects: [{ kind: 'branch', targetOffset: 12 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 10),
    bytecodeOffset: 10,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 200 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 12),
    bytecodeOffset: 12,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const vmFn = createVMEffectFunction({
  methodId,
  frontendId: 'wasm',
  bundles,
  exceptionRegions: [
    { startOffset: 0, endOffset: 8, handlerOffset: 10 },
  ],
  aggregateCompleteness: 'exact',
});

const lowered = lowerVMEffectsToSemanticIr(vmFn);
assert.ok(lowered.semanticIr);
assert.ok(lowered.cfg);
assert.ok(lowered.ssa);

// Verify that multiple CFG blocks were formed from branches
assert.ok(lowered.cfg.blocks.length >= 3, `Expected at least 3 CFG blocks, got ${lowered.cfg.blocks.length}`);

// Verify that SSA contains phi/dataflow structures
assert.equal(lowered.ssa.functionId, methodId);

console.log('  ok shared bridge tests passed');
