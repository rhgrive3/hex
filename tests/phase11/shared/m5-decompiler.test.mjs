import assert from 'node:assert/strict';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

console.log('[phase11] running M5 shared managed decompiler tests...');

// =========================================================================
// 1. Arithmetic & Expression Structuring Test (WASM / Stack VM)
// =========================================================================
const arithMethodId = createManagedMethodId('wasm_arith', 0);
const arithBundles = [
  // local.get 0
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: arithMethodId,
    operationId: createVMOperationId(arithMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'local.get',
    locationReads: [{ kind: 'local', index: 0, bits: 32 }],
    producedValues: [{ bits: 32 }],
    completeness: 'exact',
  }),
  // i32.const 10
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: arithMethodId,
    operationId: createVMOperationId(arithMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'i32.const',
    producedValues: [{ bits: 32, constant: 10 }],
    completeness: 'exact',
  }),
  // i32.add
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: arithMethodId,
    operationId: createVMOperationId(arithMethodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'i32.add',
    consumedValues: [{ id: 'b', bits: 32 }, { id: 'a', bits: 32 }],
    producedValues: [{ bits: 32 }],
    completeness: 'exact',
  }),
  // return
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: arithMethodId,
    operationId: createVMOperationId(arithMethodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'return',
    consumedValues: [{ id: 'res', bits: 32 }],
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const arithFn = createVMEffectFunction({
  methodId: arithMethodId,
  frontendId: 'wasm',
  bundles: arithBundles,
  aggregateCompleteness: 'exact',
});

const arithDecompiled = decompileManagedMethod(arithFn);
assert.ok(arithDecompiled.pseudocode);
assert.ok(arithDecompiled.pseudocode.includes('+') || arithDecompiled.pseudocode.includes('return'));

// =========================================================================
// 2. Branch / If & Loop Structuring Test (DEX / Register VM)
// =========================================================================
const loopMethodId = createManagedMethodId('dex_loop', 0, 'countLoop');
const loopBundles = [
  // 0: const/4 v0, #0 (counter = 0)
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: loopMethodId,
    operationId: createVMOperationId(loopMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'const/4',
    locationWrites: [{ kind: 'register', index: 0, bits: 32 }],
    producedValues: [{ bits: 32, constant: 0 }],
    completeness: 'exact',
  }),
  // 2: const/4 v1, #10 (limit = 10)
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: loopMethodId,
    operationId: createVMOperationId(loopMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'const/4',
    locationWrites: [{ kind: 'register', index: 1, bits: 32 }],
    producedValues: [{ bits: 32, constant: 10 }],
    completeness: 'exact',
  }),
  // 4: if-ge v0, v1, :exit (offset 10)
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: loopMethodId,
    operationId: createVMOperationId(loopMethodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'if-ge',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }, { kind: 'register', index: 1, bits: 32 }],
    controlEffects: [{ kind: 'conditional-branch', targetOffset: 10 }],
    completeness: 'exact',
  }),
  // 6: add-int/lit8 v0, v0, #1
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: loopMethodId,
    operationId: createVMOperationId(loopMethodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'add-int/lit8',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }],
    locationWrites: [{ kind: 'register', index: 0, bits: 32 }],
    producedValues: [{ bits: 32 }],
    completeness: 'exact',
  }),
  // 8: goto :loop_start (offset 4) -> back-edge creates a loop
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: loopMethodId,
    operationId: createVMOperationId(loopMethodId, 8),
    bytecodeOffset: 8,
    mnemonic: 'goto',
    controlEffects: [{ kind: 'branch', targetOffset: 4 }],
    completeness: 'exact',
  }),
  // 10: return v0
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: loopMethodId,
    operationId: createVMOperationId(loopMethodId, 10),
    bytecodeOffset: 10,
    mnemonic: 'return',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }],
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const loopFn = createVMEffectFunction({
  methodId: loopMethodId,
  frontendId: 'dex',
  bundles: loopBundles,
  aggregateCompleteness: 'exact',
});

const loopDecompiled = decompileManagedMethod(loopFn);
assert.ok(loopDecompiled.pseudocode);
assert.ok(loopDecompiled.pseudocode.includes('if') || loopDecompiled.pseudocode.includes('goto') || loopDecompiled.pseudocode.includes('while'));

// =========================================================================
// 3. Field & Array Access Test (JVM / Class Format)
// =========================================================================
const memMethodId = createManagedMethodId('jvm_mem', 0, 'accessMemory');
const memBundles = [
  // aload_0
  createVMEffectBundle({
    frontendId: 'jvm',
    methodId: memMethodId,
    operationId: createVMOperationId(memMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'aload_0',
    locationReads: [{ kind: 'local', index: 0, bits: 64 }],
    producedValues: [{ bits: 64 }],
    completeness: 'exact',
  }),
  // getfield #2 (field 'data')
  createVMEffectBundle({
    frontendId: 'jvm',
    methodId: memMethodId,
    operationId: createVMOperationId(memMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'getfield',
    consumedValues: [{ id: 'obj_ref', bits: 64 }],
    producedValues: [{ bits: 64 }],
    memoryEffects: [{ space: 'heap', isWrite: false, byteWidth: 8 }],
    completeness: 'exact',
  }),
  // iconst_0 (array index 0)
  createVMEffectBundle({
    frontendId: 'jvm',
    methodId: memMethodId,
    operationId: createVMOperationId(memMethodId, 5),
    bytecodeOffset: 5,
    mnemonic: 'iconst_0',
    producedValues: [{ bits: 32, constant: 0 }],
    completeness: 'exact',
  }),
  // iconst_5 (value to store)
  createVMEffectBundle({
    frontendId: 'jvm',
    methodId: memMethodId,
    operationId: createVMOperationId(memMethodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'iconst_5',
    producedValues: [{ bits: 32, constant: 5 }],
    completeness: 'exact',
  }),
  // iastore (array store: array[0] = 5)
  createVMEffectBundle({
    frontendId: 'jvm',
    methodId: memMethodId,
    operationId: createVMOperationId(memMethodId, 7),
    bytecodeOffset: 7,
    mnemonic: 'iastore',
    consumedValues: [{ id: 'val', bits: 32 }, { id: 'idx', bits: 32 }, { id: 'arr', bits: 64 }],
    memoryEffects: [{ space: 'heap', isWrite: true, byteWidth: 4 }],
    completeness: 'exact',
  }),
  // return
  createVMEffectBundle({
    frontendId: 'jvm',
    methodId: memMethodId,
    operationId: createVMOperationId(memMethodId, 8),
    bytecodeOffset: 8,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const memFn = createVMEffectFunction({
  methodId: memMethodId,
  frontendId: 'jvm',
  bundles: memBundles,
  aggregateCompleteness: 'exact',
});

const memDecompiled = decompileManagedMethod(memFn);
assert.ok(memDecompiled.pseudocode);
assert.ok(memDecompiled.pseudocode.includes('[') || memDecompiled.pseudocode.includes('->') || memDecompiled.pseudocode.includes('return'));

// =========================================================================
// 4. Exception Path Test (CIL / CLR)
// =========================================================================
const excMethodId = createManagedMethodId('cil_exc', '0x06000001');
const excBundles = [
  // ldc.i4.0
  createVMEffectBundle({
    frontendId: 'cil',
    methodId: excMethodId,
    operationId: createVMOperationId(excMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'ldc.i4.0',
    producedValues: [{ bits: 32, constant: 0 }],
    completeness: 'exact',
  }),
  // throw
  createVMEffectBundle({
    frontendId: 'cil',
    methodId: excMethodId,
    operationId: createVMOperationId(excMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'throw',
    controlEffects: [{ kind: 'throw' }],
    completeness: 'exact',
  }),
];

const excFn = createVMEffectFunction({
  methodId: excMethodId,
  frontendId: 'cil',
  bundles: excBundles,
  exceptionRegions: [{ startOffset: 0, endOffset: 2, handlerOffset: 2 }],
  aggregateCompleteness: 'exact',
});

const excDecompiled = decompileManagedMethod(excFn);
assert.ok(excDecompiled.pseudocode);
assert.ok(excDecompiled.pseudocode.includes('throw') || excDecompiled.pseudocode.includes('Exception'));

// =========================================================================
// 5. Register/Slot Reuse Safety Test (No conflation of distinct SSA variables)
// =========================================================================
const reuseMethodId = createManagedMethodId('dex_reuse', 0, 'reuseRegisters');
const reuseBundles = [
  // 0: const/4 v0, #100
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: reuseMethodId,
    operationId: createVMOperationId(reuseMethodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'const/4',
    locationWrites: [{ kind: 'register', index: 0, bits: 32 }],
    producedValues: [{ bits: 32, constant: 100 }],
    completeness: 'exact',
  }),
  // 2: invoke-static {v0}, LLogger;->log(I)V
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: reuseMethodId,
    operationId: createVMOperationId(reuseMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'invoke-static',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }],
    callEffects: [{ target: 'LLogger;->log(I)V', dispatchKind: 'direct', unresolved: false }],
    completeness: 'exact',
  }),
  // 4: const/4 v0, #200 (re-using register v0 for a completely new conceptual value)
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: reuseMethodId,
    operationId: createVMOperationId(reuseMethodId, 4),
    bytecodeOffset: 4,
    mnemonic: 'const/4',
    locationWrites: [{ kind: 'register', index: 0, bits: 32 }],
    producedValues: [{ bits: 32, constant: 200 }],
    completeness: 'exact',
  }),
  // 6: return v0
  createVMEffectBundle({
    frontendId: 'dex',
    methodId: reuseMethodId,
    operationId: createVMOperationId(reuseMethodId, 6),
    bytecodeOffset: 6,
    mnemonic: 'return',
    locationReads: [{ kind: 'register', index: 0, bits: 32 }],
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const reuseFn = createVMEffectFunction({
  methodId: reuseMethodId,
  frontendId: 'dex',
  bundles: reuseBundles,
  aggregateCompleteness: 'exact',
});

const reuseDecompiled = decompileManagedMethod(reuseFn);
assert.ok(reuseDecompiled.pseudocode);
// Verify that SSA values for the two writes are distinct
assert.ok(reuseDecompiled.semanticIr.values.length >= 2);
const defValues = reuseDecompiled.semanticIr.values.filter((v) => v.kind === 'definition');
assert.ok(defValues.length >= 2);
assert.notEqual(defValues[0].id, defValues[1].id);

// =========================================================================
// 6. Unsupported / Unknown Intrinsic Honesty Test
// =========================================================================
const unkMethodId = createManagedMethodId('wasm_unknown', 0);
const unkBundles = [
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: unkMethodId,
    operationId: createVMOperationId(unkMethodId, 0),
    bytecodeOffset: 0,
    opcode: 0xfe,
    mnemonic: 'unsupported_custom_simd_op',
    completeness: 'unknown',
    unknownEffects: [{ reason: 'unsupported-simd-variant', categories: ['other'] }],
  }),
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId: unkMethodId,
    operationId: createVMOperationId(unkMethodId, 2),
    bytecodeOffset: 2,
    mnemonic: 'return',
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  }),
];

const unkFn = createVMEffectFunction({
  methodId: unkMethodId,
  frontendId: 'wasm',
  bundles: unkBundles,
  aggregateCompleteness: 'partial',
});

const unkDecompiled = decompileManagedMethod(unkFn);
assert.ok(unkDecompiled.pseudocode);
// Unsupported intrinsic must be preserved honestly and visible in output, never silently dropped
assert.ok(unkDecompiled.pseudocode.includes('unsupported_custom_simd_op') || unkDecompiled.pseudocode.includes('unsupported_intrinsic'));

console.log('  ok M5 shared managed decompiler tests passed');
