import assert from 'node:assert/strict';
import {
  analyzeManagedInterprocedural,
  buildManagedMethodSummary,
  buildManagedTypeConstraintGraph,
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

console.log('[phase11] running M4 managed types and interprocedural analysis tests...');

// =========================================================================
// 1. Stack VM Counterexample (WASM / JVM)
// =========================================================================
const wasmMethodId = createManagedMethodId('wasm_mod', 1);
const wasmBundles = [
  // local.get 0
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: wasmMethodId,
    operationId: createVMOperationId(wasmMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'local.get',
    locationReads: [{ kind: 'local', index: 0, bits: 32 }],
    producedValues: [{ bits: 32 }],
    completeness: 'exact',
  }),
  // call func_2 (direct call)
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: wasmMethodId,
    operationId: createVMOperationId(wasmMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'call',
    consumedValues: [{ id: 'arg0', bits: 32 }],
    producedValues: [{ bits: 32 }],
    callEffects: [{ target: 'func_2', dispatchKind: 'direct', unresolved: false }],
    completeness: 'exact',
  }),
  // call_indirect (dynamic/indirect dispatch)
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: wasmMethodId,
    operationId: createVMOperationId(wasmMethodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'call_indirect',
    consumedValues: [{ id: 'table_idx', bits: 32 }],
    callEffects: [{ dispatchKind: 'indirect', unresolved: true }],
    completeness: 'partial',
    unknownEffects: [{ reason: 'indirect-call-target-unknown', categories: ['control'] }],
  }),
  // host_import call (external boundary)
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: wasmMethodId,
    operationId: createVMOperationId(wasmMethodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'call',
    callEffects: [{ target: 'env.imported_api', dispatchKind: 'host-import', unresolved: true }],
    completeness: 'partial',
    unknownEffects: [{ reason: 'external-host-call', categories: ['other'] }],
  }),
  // return
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: wasmMethodId,
    operationId: createVMOperationId(wasmMethodId, 8),
    bytecodeOffset: 8,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const wasmFn = createVMEffectFunction({
  methodId: wasmMethodId,
  frontendId: 'wasm',
  bundles: wasmBundles,
  exceptionRegions: [{ startOffset: 0, endOffset: 6, handlerOffset: 8 }],
  aggregateCompleteness: 'partial',
});

// A. Authoritative metadata vs Debug metadata separation
const wasmTypeGraph = buildManagedTypeConstraintGraph({
  methodId: wasmMethodId,
  returnType: 'i32',
  params: ['i32'],
  debugLocalVariables: [{ slot: 0, name: 'inputCount', type: 'uint32_t' }],
});

const wasmReturn = wasmTypeGraph.solveEntity(`${wasmMethodId}:return`);
assert.equal(wasmReturn.layers.nominal?.selected?.descriptor?.name, 'i32');
assert.equal(wasmReturn.layers.nominal?.confidence, 'certain'); // Authoritative metadata -> hard constraint

const wasmLocal = wasmTypeGraph.solveEntity(`${wasmMethodId}:local_0`);
assert.equal(wasmLocal.layers.nominal?.selected?.descriptor?.name, 'uint32_t');
assert.equal(wasmLocal.layers.nominal?.confidence, 'probable'); // Debug metadata -> soft evidence (never certain)

// B. Method Summary & Call Resolution
const wasmSummary = buildManagedMethodSummary(wasmFn);
assert.equal(wasmSummary.directCalls.length, 1);
assert.equal(wasmSummary.directCalls[0].target, 'func_2');
assert.equal(wasmSummary.directCalls[0].unresolved, false);

assert.equal(wasmSummary.dynamicCalls.length, 1);
assert.equal(wasmSummary.dynamicCalls[0].unresolved, true);

assert.equal(wasmSummary.externalCalls.length, 1);
assert.equal(wasmSummary.externalCalls[0].target, 'env.imported_api');
assert.equal(wasmSummary.externalCalls[0].unresolved, true);

assert.ok(wasmSummary.hasExceptionEdges);
assert.equal(wasmSummary.completeness, 'partial'); // Unresolved dynamic/external calls keep completeness partial

// =========================================================================
// 2. Register VM Counterexample (DEX)
// =========================================================================
const dexMethodId = createManagedMethodId('dex_mod', 0, 'calculate');
const dexBundles = [
  // const/4 v0, #5
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: dexMethodId,
    operationId: createVMOperationId(dexMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'const/4',
    locationWrites: [{ kind: 'register', index: 0, bits: 32 }],
    producedValues: [{ bits: 32, constant: 5 }],
    completeness: 'exact',
  }),
  // invoke-direct {v0}, LTarget;->init()V
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: dexMethodId,
    operationId: createVMOperationId(dexMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'invoke-direct',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }],
    callEffects: [{ target: 'LTarget;->init()V', dispatchKind: 'direct', unresolved: false }],
    completeness: 'exact',
  }),
  // invoke-virtual {v0}, LTarget;->process()V (virtual dispatch with candidate uncertainty)
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: dexMethodId,
    operationId: createVMOperationId(dexMethodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'invoke-virtual',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }],
    callEffects: [{ target: 'LTarget;->process()V', dispatchKind: 'virtual', unresolved: true }],
    completeness: 'partial',
    unknownEffects: [{ reason: 'virtual-dispatch-target-uncertain', categories: ['control'] }],
  }),
  // native JNI call
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: dexMethodId,
    operationId: createVMOperationId(dexMethodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'jni_native_method',
    callEffects: [{ target: 'LNative;->computeNative()V', dispatchKind: 'jni-native', unresolved: true }],
    completeness: 'partial',
    unknownEffects: [{ reason: 'jni-native-call-unresolved', categories: ['other'] }],
  }),
  // return-void
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: dexMethodId,
    operationId: createVMOperationId(dexMethodId, 8),
    bytecodeOffset: 8,
    mnemonic: 'return-void',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const dexFn = createVMEffectFunction({
  methodId: dexMethodId,
  frontendId: 'dex',
  bundles: dexBundles,
  exceptionRegions: [{ startOffset: 0, endOffset: 6, handlerOffset: 8 }],
  aggregateCompleteness: 'partial',
});

const dexTypeGraph = buildManagedTypeConstraintGraph({
  methodId: dexMethodId,
  returnType: 'V',
  params: ['LContext;'],
  debugLocalVariables: [{ slot: 0, name: 'contextObj', signature: 'LContext;' }],
});

const dexParam = dexTypeGraph.solveEntity(`${dexMethodId}:param_0`);
assert.equal(dexParam.layers.nominal?.selected?.descriptor?.name, 'LContext;');
assert.equal(dexParam.layers.nominal?.confidence, 'certain');

const dexSummary = buildManagedMethodSummary(dexFn);
assert.equal(dexSummary.directCalls.length, 1);
assert.equal(dexSummary.directCalls[0].target, 'LTarget;->init()V');

assert.equal(dexSummary.dynamicCalls.length, 1);
assert.equal(dexSummary.dynamicCalls[0].unresolved, true);

assert.equal(dexSummary.externalCalls.length, 1);
assert.equal(dexSummary.externalCalls[0].target, 'LNative;->computeNative()V');

// =========================================================================
// 3. Multi-Method Interprocedural Call Graph Condensation
// =========================================================================
const calleeMethodId = 'func_2';
const calleeBundles = [
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: calleeMethodId,
    operationId: createVMOperationId(calleeMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'const',
    producedValues: [{ bits: 32, constant: 42 }],
    completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: calleeMethodId,
    operationId: createVMOperationId(calleeMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];
const calleeFn = createVMEffectFunction({
  methodId: calleeMethodId,
  frontendId: 'wasm',
  bundles: calleeBundles,
  aggregateCompleteness: 'exact',
});

const interproc = analyzeManagedInterprocedural([wasmFn, calleeFn]);
assert.ok(interproc.components.length >= 2);
assert.ok(interproc.summaries.has(wasmMethodId));
assert.ok(interproc.summaries.has(calleeMethodId));

console.log('  ok M4 managed types and interprocedural analysis tests passed');
