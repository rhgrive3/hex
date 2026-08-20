import assert from 'node:assert/strict';
import {
  createManagedExceptionRegionId,
  createManagedFieldId,
  createManagedImageId,
  createManagedMethodId,
  createManagedModuleId,
  createManagedTargetProfileId,
  createManagedTypeId,
  createVMFrameStateId,
  createVMOperationId,
  createVMValueId,
  createManagedTargetProfile,
  validateManagedTargetProfile,
  createVMEffectBundle,
  validateVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectFunction,
  createManagedValidationReport,
  validateManagedValidationReport,
  VM_EFFECTS_SCHEMA_VERSION,
  VM_EFFECTS_CONTRACT_VERSION,
} from '../../../js/managed/index.js';

console.log('[phase11] running foundation contract tests...');

// 1. Identity contracts
const imageId = createManagedImageId('bin-123', 'sub-entry');
assert.equal(imageId, 'managed-image:bin-123:sub-entry');

const moduleId = createManagedModuleId(imageId, 'classes.dex');
assert.equal(moduleId, 'managed-mod:managed-image:bin-123:sub-entry:classes.dex');

const typeId = createManagedTypeId(moduleId, 'Lcom/example/MyClass;');
assert.equal(typeId, 'managed-type:managed-mod:managed-image:bin-123:sub-entry:classes.dex:Lcom/example/MyClass;');

const methodId = createManagedMethodId(typeId, 'doSomething', '(I)V');
assert.equal(methodId, 'managed-method:managed-type:managed-mod:managed-image:bin-123:sub-entry:classes.dex:Lcom/example/MyClass;:doSomething:(I)V');

const fieldId = createManagedFieldId(typeId, 'mField');
assert.equal(fieldId, 'managed-field:managed-type:managed-mod:managed-image:bin-123:sub-entry:classes.dex:Lcom/example/MyClass;:mField');

const opId = createVMOperationId(methodId, 0x14, 1);
assert.equal(opId, `vm-op:${methodId}:0x14:1`);

const valId = createVMValueId(methodId, opId, 'r0');
assert.equal(valId, `vm-val:${methodId}:${opId}:r0`);

const frameId = createVMFrameStateId(methodId, 0x14);
assert.equal(frameId, `vm-frame:${methodId}:0x14`);

const excId = createManagedExceptionRegionId(methodId, 0);
assert.equal(excId, `managed-exc:${methodId}:0`);

const profileId = createManagedTargetProfileId('wasm', '1', 'core-3.0');
assert.equal(profileId, 'managed-profile:wasm:1:core-3.0');

// 2. Profile validation
const profile = createManagedTargetProfile({
  frontendId: 'wasm',
  formatVersion: '1',
  vmSpecEdition: 'core-3.0',
  featureSet: ['simd', 'multi-memory'],
});
assert.equal(profile.id, 'managed-profile:wasm:1:core-3.0');
assert.equal(validateManagedTargetProfile(profile), true);

assert.throws(() => {
  createManagedTargetProfile({ frontendId: 'unsupported_arch' });
}, /managed-profile-unsupported-frontend/);

// 3. VMEffectBundle contracts
const bundle = createVMEffectBundle({
  frontendId: 'wasm',
  methodId,
  operationId: opId,
  bytecodeOffset: 0x14,
  opcode: 0x6a,
  mnemonic: 'i32.add',
  completeness: 'exact',
  consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
  producedValues: [{ id: 'res', bits: 32 }],
});
assert.equal(bundle.schemaVersion, VM_EFFECTS_SCHEMA_VERSION);
assert.equal(bundle.contractVersion, VM_EFFECTS_CONTRACT_VERSION);
assert.equal(bundle.completeness, 'exact');
assert.equal(validateVMEffectBundle(bundle), true);

// Partial must specify unknown effects
assert.throws(() => {
  createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: opId,
    bytecodeOffset: 0x14,
    opcode: 0xff,
    completeness: 'partial',
  });
}, /vm-effect-partial-must-specify-unknown-effects/);

const partialBundle = createVMEffectBundle({
  frontendId: 'wasm',
  methodId,
  operationId: opId,
  bytecodeOffset: 0x14,
  opcode: 0xff,
  completeness: 'partial',
  unknownEffects: [{ category: 'other', reason: 'unsupported-opcode-0xff' }],
});
assert.equal(partialBundle.completeness, 'partial');
assert.equal(partialBundle.unknownEffects.length, 1);

// 4. VMEffectFunction contracts
const fn = createVMEffectFunction({
  methodId,
  frontendId: 'wasm',
  bundles: [bundle, partialBundle],
  exceptionRegions: [
    { id: excId, startOffset: 0, endOffset: 0x20, handlerOffset: 0x20 },
  ],
});
assert.equal(fn.methodId, methodId);
assert.equal(fn.bundles.length, 2);
assert.equal(fn.aggregateCompleteness, 'partial');
assert.equal(validateVMEffectFunction(fn), true);

// 5. Validation report contracts
const report = createManagedValidationReport({
  targetId: methodId,
  status: 'valid',
  verifierFacts: ['stack-balanced-at-all-joins'],
});
assert.equal(report.status, 'valid');
assert.equal(report.completeness.specValidation, 'valid');
assert.equal(validateManagedValidationReport(report), true);

console.log('  ok foundation contracts passed');
