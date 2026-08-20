export {
  createManagedImageId,
  createManagedModuleId,
  createManagedTypeId,
  createManagedMethodId,
  createManagedFieldId,
  createVMOperationId,
  createVMValueId,
  createVMFrameStateId,
  createManagedCallSiteId,
  createManagedExceptionRegionId,
  createManagedTargetProfileId,
} from './identity.js';

export {
  MANAGED_FRONTEND_IDS,
  createManagedTargetProfile,
  validateManagedTargetProfile,
} from './profile.js';

export {
  VM_EFFECTS_SCHEMA_VERSION,
  VM_EFFECTS_CONTRACT_VERSION,
  VM_EFFECT_DEFAULT_BUDGET,
  VM_EFFECT_COMPLETENESS,
  VM_LOCATION_KINDS,
  VM_OPERATION_KINDS,
  VM_UNKNOWN_CATEGORIES,
  createVMEffectBundle,
  validateVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectFunction,
} from './vm-effects.js';

export {
  MANAGED_VALIDATION_STATUS,
  createManagedValidationReport,
  validateManagedValidationReport,
} from './validation.js';

export {
  MANAGED_BRIDGE_VERSION,
  lowerVMEffectsToSemanticIr,
  queryManagedSymbolicVerification,
  queryManagedRuntimeProvider,
} from './bridge.js';
