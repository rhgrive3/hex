import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { createManagedTargetProfileId } from './identity.js';

export const MANAGED_FRONTEND_IDS = Object.freeze(['wasm', 'dex', 'cil', 'jvm']);
const FRONTEND_SET = new Set(MANAGED_FRONTEND_IDS);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function sortedUniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))].sort();
}

export function createManagedTargetProfile(input) {
  input = object(input, 'managed-profile-invalid-input');
  const frontendId = nonEmpty(input.frontendId, 'managed-profile-frontend-id-required').toLowerCase();
  if (!FRONTEND_SET.has(frontendId)) fail('managed-profile-unsupported-frontend');

  const frontendSemanticVersion = nonEmpty(input.frontendSemanticVersion ?? '1.0.0', 'managed-profile-version-required');
  const formatVersion = nonEmpty(String(input.formatVersion ?? '1'), 'managed-profile-format-version-required');
  const vmSpecEdition = nonEmpty(String(input.vmSpecEdition ?? 'default'), 'managed-profile-spec-edition-required');
  const featureSet = sortedUniqueStrings(input.featureSet);
  const runtimeVersionHint = input.runtimeVersionHint ? String(input.runtimeVersionHint).trim() : null;
  const validationPolicy = nonEmpty(input.validationPolicy ?? 'strict', 'managed-profile-validation-policy-required');
  
  const options = input.options ? input.options : {};
  const decodingOptionsHash = stableDigest(options);
  const id = createManagedTargetProfileId(frontendId, formatVersion, vmSpecEdition);

  return deepFreeze({
    id,
    frontendId,
    frontendSemanticVersion,
    formatVersion,
    vmSpecEdition,
    featureSet,
    runtimeVersionHint,
    validationPolicy,
    decodingOptionsHash,
  });
}

export function validateManagedTargetProfile(profile) {
  if (!profile || typeof profile !== 'object') fail('managed-profile-invalid');
  if (!FRONTEND_SET.has(profile.frontendId)) fail('managed-profile-unsupported-frontend');
  if (!profile.id || typeof profile.id !== 'string') fail('managed-profile-missing-id');
  return true;
}
