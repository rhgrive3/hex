import { deepFreeze } from '../core/identity/index.js';
import { CilFrontend } from './cil/frontend.js';
import { DexFrontend } from './dex/frontend.js';
import { JvmFrontend } from './jvm/frontend.js';
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
} from './shared/identity.js';
import {
  createManagedTargetProfile,
  MANAGED_FRONTEND_IDS,
  validateManagedTargetProfile,
} from './shared/profile.js';
import {
  createManagedValidationReport,
  MANAGED_VALIDATION_STATUS,
  validateManagedValidationReport,
} from './shared/validation.js';
import {
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectBundle,
  validateVMEffectFunction,
  VM_EFFECT_COMPLETENESS,
  VM_EFFECT_DEFAULT_BUDGET,
  VM_EFFECTS_CONTRACT_VERSION,
  VM_EFFECTS_SCHEMA_VERSION,
  VM_LOCATION_KINDS,
  VM_OPERATION_KINDS,
  VM_UNKNOWN_CATEGORIES,
} from './shared/vm-effects.js';
import {
  lowerVMEffectsToSemanticIr,
  MANAGED_BRIDGE_VERSION,
  queryManagedRuntimeProvider,
  queryManagedSymbolicVerification,
} from './shared/bridge.js';
import { WasmFrontend } from './wasm/frontend.js';

export {
  createManagedImageId,
  createManagedModuleId,
  createManagedTypeId,
  createManagedMethodId,
  createManagedFieldId,
  createVMOperationId,
  createVMValueId,
  createVMFrameStateId,
  createManagedExceptionRegionId,
  createManagedTargetProfileId,
  MANAGED_FRONTEND_IDS,
  createManagedTargetProfile,
  validateManagedTargetProfile,
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
  MANAGED_VALIDATION_STATUS,
  createManagedValidationReport,
  validateManagedValidationReport,
  MANAGED_BRIDGE_VERSION,
  lowerVMEffectsToSemanticIr,
  queryManagedSymbolicVerification,
  queryManagedRuntimeProvider,
  WasmFrontend,
  DexFrontend,
  CilFrontend,
  JvmFrontend,
};

export const MANAGED_FRONTENDS = Object.freeze({
  wasm: new WasmFrontend(),
  dex: new DexFrontend(),
  cil: new CilFrontend(),
  jvm: new JvmFrontend(),
});

export async function probeManagedFrontend(bytes, options = {}) {
  for (const [id, frontend] of Object.entries(MANAGED_FRONTENDS)) {
    const probe = await frontend.probe(bytes, options);
    if (probe && probe.supported) {
      return {
        frontendId: id,
        ...probe,
      };
    }
  }
  return {
    frontendId: null,
    supported: false,
    confidence: 0,
    reason: 'no-managed-frontend-matched',
  };
}

export async function openManagedImage(bytes, options = {}) {
  const probe = await probeManagedFrontend(bytes, options);
  if (!probe.supported || !probe.frontendId) {
    throw new TypeError('managed-image-unsupported-format');
  }
  const frontend = MANAGED_FRONTENDS[probe.frontendId];
  return frontend.open(bytes, options);
}
