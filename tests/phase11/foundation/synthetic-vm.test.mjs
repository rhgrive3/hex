import assert from 'node:assert/strict';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

console.log('[phase11] running synthetic VM vertical pipeline test...');

const methodId = createManagedMethodId('mod-synth', 'testMethod');

// Construct synthetic bytecode operations:
// 0: const 10
// 2: const 20
// 4: add
// 6: return
const bundles = [
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 0),
    bytecodeOffset: 0,
    opcode: 0x41,
    mnemonic: 'i32.const',
    producedValues: [{ bits: 32, constant: 10 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 2),
    bytecodeOffset: 2,
    opcode: 0x41,
    mnemonic: 'i32.const',
    producedValues: [{ bits: 32, constant: 20 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 4),
    bytecodeOffset: 4,
    opcode: 0x6a,
    mnemonic: 'i32.add',
    consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
    producedValues: [{ bits: 32 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, 6),
    bytecodeOffset: 6,
    opcode: 0x0f,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const vmFn = createVMEffectFunction({
  methodId,
  frontendId: 'wasm',
  bundles,
  aggregateCompleteness: 'exact',
});

const lowered = lowerVMEffectsToSemanticIr(vmFn);
assert.ok(lowered.semanticIr, 'lowered Semantic IR must exist');
assert.ok(lowered.cfg, 'lowered CFG must exist');
assert.ok(lowered.ssa, 'lowered SSA must exist');

assert.equal(lowered.semanticIr.blocks.length, 1);
assert.equal(lowered.cfg.blocks.length, 1);
assert.equal(lowered.ssa.functionId, methodId);

console.log('  ok synthetic VM pipeline passed');
