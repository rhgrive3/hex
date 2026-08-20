import { deepFreeze, stableStringify } from '../../core/identity/index.js';

function fail(code) { throw new TypeError(code); }
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(code);
  return number;
}

export function createManagedImageId(binaryId, memberId = null) {
  const bin = nonEmpty(binaryId, 'managed-identity-binary-id-required');
  return memberId ? `managed-image:${bin}:${nonEmpty(memberId, 'managed-identity-member-id-required')}` : `managed-image:${bin}`;
}

export function createManagedModuleId(imageId, moduleNameOrIndex) {
  const img = nonEmpty(imageId, 'managed-identity-image-id-required');
  const mod = nonEmpty(String(moduleNameOrIndex ?? ''), 'managed-identity-module-id-required');
  return `managed-mod:${img}:${mod}`;
}

export function createManagedTypeId(moduleId, typeTokenOrName) {
  const mod = nonEmpty(moduleId, 'managed-identity-module-id-required');
  const typ = nonEmpty(String(typeTokenOrName ?? ''), 'managed-identity-type-id-required');
  return `managed-type:${mod}:${typ}`;
}

export function createManagedMethodId(typeIdOrModuleId, methodTokenOrIndex, signature = null) {
  const parent = nonEmpty(typeIdOrModuleId, 'managed-identity-parent-id-required');
  const meth = nonEmpty(String(methodTokenOrIndex ?? ''), 'managed-identity-method-id-required');
  return signature ? `managed-method:${parent}:${meth}:${nonEmpty(signature, 'managed-identity-signature-required')}` : `managed-method:${parent}:${meth}`;
}

export function createManagedFieldId(typeId, fieldTokenOrName) {
  const typ = nonEmpty(typeId, 'managed-identity-type-id-required');
  const fld = nonEmpty(String(fieldTokenOrName ?? ''), 'managed-identity-field-id-required');
  return `managed-field:${typ}:${fld}`;
}

export function createVMOperationId(methodId, bytecodeOffset, sequence = 0) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const off = nonNegativeInteger(bytecodeOffset, 'managed-identity-offset-required');
  const seq = nonNegativeInteger(sequence, 'managed-identity-sequence-required');
  return `vm-op:${meth}:0x${off.toString(16)}:${seq}`;
}

export function createVMValueId(methodId, opId, slotIndexOrName) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const op = nonEmpty(opId, 'managed-identity-op-id-required');
  const slot = nonEmpty(String(slotIndexOrName ?? ''), 'managed-identity-slot-required');
  return `vm-val:${meth}:${op}:${slot}`;
}

export function createVMFrameStateId(methodId, bytecodeOffset) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const off = nonNegativeInteger(bytecodeOffset, 'managed-identity-offset-required');
  return `vm-frame:${meth}:0x${off.toString(16)}`;
}

export function createManagedCallSiteId(methodId, bytecodeOffset, callIndex = 0) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const off = nonNegativeInteger(bytecodeOffset, 'managed-identity-offset-required');
  const idx = nonNegativeInteger(callIndex, 'managed-identity-call-index-required');
  return `managed-call:${meth}:0x${off.toString(16)}:${idx}`;
}

export function createManagedExceptionRegionId(methodId, handlerIndex) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const idx = nonNegativeInteger(handlerIndex, 'managed-identity-handler-index-required');
  return `managed-exc:${meth}:${idx}`;
}

export function createManagedTargetProfileId(frontendId, formatVersion, vmSpecEdition) {
  const front = nonEmpty(frontendId, 'managed-identity-frontend-id-required');
  const fmt = nonEmpty(String(formatVersion ?? ''), 'managed-identity-format-version-required');
  const spec = nonEmpty(String(vmSpecEdition ?? ''), 'managed-identity-spec-edition-required');
  return `managed-profile:${front}:${fmt}:${spec}`;
}
