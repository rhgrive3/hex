import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const VM_EFFECTS_SCHEMA_VERSION = 1;
export const VM_EFFECTS_CONTRACT_VERSION = '1.0.0';

export const VM_EFFECT_DEFAULT_BUDGET = Object.freeze({
  maxOperations: 16384,
  maxValues: 32768,
  maxExceptionRegions: 1024,
});

export const VM_EFFECT_COMPLETENESS = Object.freeze([
  'exact',
  'exact-with-intrinsic',
  'partial',
  'unknown',
]);

export const VM_LOCATION_KINDS = Object.freeze([
  'stack',
  'local',
  'register',
  'argument',
  'global',
  'field',
  'static-field',
  'array-element',
  'linear-memory',
  'table',
  'runtime',
]);

export const VM_OPERATION_KINDS = Object.freeze([
  'const',
  'copy',
  'unary',
  'binary',
  'compare',
  'select',
  'local-read',
  'local-write',
  'register-read',
  'register-write',
  'stack-push',
  'stack-pop',
  'stack-dup',
  'stack-swap',
  'arg-read',
  'conversion',
  'alloc-object',
  'alloc-array',
  'field-read',
  'field-write',
  'static-field-read',
  'static-field-write',
  'array-read',
  'array-write',
  'memory-read',
  'memory-write',
  'global-read',
  'global-write',
  'table-read',
  'table-write',
  'type-check',
  'type-cast',
  'call',
  'dispatch',
  'indirect-call',
  'return',
  'branch',
  'cond-branch',
  'switch',
  'throw',
  'rethrow',
  'monitor-enter',
  'monitor-exit',
  'trap',
  'barrier',
  'intrinsic',
  'unknown',
]);

export const VM_UNKNOWN_CATEGORIES = Object.freeze([
  'stack',
  'locals',
  'registers',
  'memory',
  'heap',
  'control',
  'exceptions',
  'calls',
  'types',
  'other',
]);

const SETS = Object.freeze({
  completeness: new Set(VM_EFFECT_COMPLETENESS),
  locations: new Set(VM_LOCATION_KINDS),
  operations: new Set(VM_OPERATION_KINDS),
  unknownCategories: new Set(VM_UNKNOWN_CATEGORIES),
});

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
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
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('vm-effects-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

export function createVMEffectBundle(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'vm-effect-bundle-invalid');
  assertAllowedKeys(input, new Set([
    'schemaVersion', 'contractVersion', 'frontendId', 'frontendSemanticVersion',
    'profileId', 'methodId', 'operationId', 'bytecodeOffset', 'opcode', 'mnemonic',
    'consumedValues', 'producedValues', 'locationReads', 'locationWrites',
    'memoryEffects', 'callEffects', 'controlEffects', 'possibleExceptions',
    'origin', 'completeness', 'unknownEffects', 'metadata',
  ]), 'vm-effect-bundle-unexpected-key');

  const frontendId = nonEmpty(input.frontendId, 'vm-effect-frontend-id-required');
  const methodId = nonEmpty(input.methodId, 'vm-effect-method-id-required');
  const operationId = nonEmpty(input.operationId, 'vm-effect-operation-id-required');
  const bytecodeOffset = nonNegativeInteger(input.bytecodeOffset ?? 0, 'vm-effect-offset-required');
  const completeness = nonEmpty(input.completeness ?? 'exact', 'vm-effect-completeness-required');
  if (!SETS.completeness.has(completeness)) fail('vm-effect-invalid-completeness');

  const consumedValues = array(input.consumedValues ?? [], 'vm-effect-invalid-consumed-values');
  const producedValues = array(input.producedValues ?? [], 'vm-effect-invalid-produced-values');
  const locationReads = array(input.locationReads ?? [], 'vm-effect-invalid-location-reads');
  const locationWrites = array(input.locationWrites ?? [], 'vm-effect-invalid-location-writes');
  const memoryEffects = array(input.memoryEffects ?? [], 'vm-effect-invalid-memory-effects');
  const callEffects = array(input.callEffects ?? [], 'vm-effect-invalid-call-effects');
  const controlEffects = array(input.controlEffects ?? [], 'vm-effect-invalid-control-effects');
  const possibleExceptions = array(input.possibleExceptions ?? [], 'vm-effect-invalid-exceptions');

  if (completeness === 'partial' || completeness === 'unknown') {
    if (!input.unknownEffects || !Array.isArray(input.unknownEffects) || input.unknownEffects.length === 0) {
      fail('vm-effect-partial-must-specify-unknown-effects');
    }
  }

  const schemaVersion = Number(input.schemaVersion ?? VM_EFFECTS_SCHEMA_VERSION);
  if (schemaVersion !== VM_EFFECTS_SCHEMA_VERSION) fail('vm-effect-schema-version-mismatch');

  const contractVersion = String(input.contractVersion ?? VM_EFFECTS_CONTRACT_VERSION);
  if (contractVersion !== VM_EFFECTS_CONTRACT_VERSION) fail('vm-effect-contract-version-mismatch');

  const out = {
    schemaVersion,
    contractVersion,
    frontendId,
    frontendSemanticVersion: String(input.frontendSemanticVersion ?? '1.0.0'),
    profileId: input.profileId ? String(input.profileId) : null,
    methodId,
    operationId,
    bytecodeOffset,
    opcode: input.opcode != null ? Number(input.opcode) : null,
    mnemonic: input.mnemonic ? String(input.mnemonic) : null,
    consumedValues: deepFreeze(consumedValues.map((v) => jsonSafe(v))),
    producedValues: deepFreeze(producedValues.map((v) => jsonSafe(v))),
    locationReads: deepFreeze(locationReads.map((r) => jsonSafe(r))),
    locationWrites: deepFreeze(locationWrites.map((w) => jsonSafe(w))),
    memoryEffects: deepFreeze(memoryEffects.map((m) => jsonSafe(m))),
    callEffects: deepFreeze(callEffects.map((c) => jsonSafe(c))),
    controlEffects: deepFreeze(controlEffects.map((c) => jsonSafe(c))),
    possibleExceptions: deepFreeze(possibleExceptions.map((e) => jsonSafe(e))),
    origin: createOriginSet(input.origin ?? { operationIds: [operationId] }),
    completeness,
    unknownEffects: input.unknownEffects ? deepFreeze(input.unknownEffects.map((u) => jsonSafe(u))) : Object.freeze([]),
    metadata: input.metadata ? deepFreeze(jsonSafe(input.metadata)) : Object.freeze({}),
  };

  return deepFreeze(out);
}

export function validateVMEffectBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') fail('vm-effect-bundle-invalid');
  if (!bundle.operationId || !bundle.methodId || !bundle.frontendId) fail('vm-effect-bundle-missing-identity');
  if (!SETS.completeness.has(bundle.completeness)) fail('vm-effect-bundle-invalid-completeness');
  return true;
}

export function createVMEffectFunction(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'vm-effect-function-invalid');
  assertAllowedKeys(input, new Set([
    'methodId', 'profileId', 'frontendId', 'entryState', 'bundles',
    'exceptionRegions', 'validationReportId', 'aggregateCompleteness',
    'resolutionCompleteness', 'origin', 'metadata',
  ]), 'vm-effect-function-unexpected-key');

  const methodId = nonEmpty(input.methodId, 'vm-effect-method-id-required');
  const frontendId = nonEmpty(input.frontendId, 'vm-effect-frontend-id-required');
  const bundles = array(input.bundles ?? [], 'vm-effect-function-bundles-required');
  const exceptionRegions = array(input.exceptionRegions ?? [], 'vm-effect-function-exceptions-invalid');

  const outBundles = bundles.map((b) => createVMEffectBundle(b, options));
  const aggregateCompleteness = nonEmpty(input.aggregateCompleteness ?? (
    outBundles.some((b) => b.completeness === 'unknown') ? 'unknown' :
    outBundles.some((b) => b.completeness === 'partial') ? 'partial' :
    outBundles.some((b) => b.completeness === 'exact-with-intrinsic') ? 'exact-with-intrinsic' : 'exact'
  ), 'vm-effect-aggregate-completeness-required');

  const out = {
    methodId,
    profileId: input.profileId ? String(input.profileId) : null,
    frontendId,
    entryState: input.entryState ? deepFreeze(jsonSafe(input.entryState)) : Object.freeze({}),
    bundles: deepFreeze(outBundles),
    exceptionRegions: deepFreeze(exceptionRegions.map((r) => jsonSafe(r))),
    validationReportId: input.validationReportId ? String(input.validationReportId) : null,
    aggregateCompleteness,
    resolutionCompleteness: input.resolutionCompleteness ? String(input.resolutionCompleteness) : 'complete',
    origin: createOriginSet(input.origin ?? { parentEntityIds: [methodId] }),
    metadata: input.metadata ? deepFreeze(jsonSafe(input.metadata)) : Object.freeze({}),
  };

  return deepFreeze(out);
}

export function validateVMEffectFunction(fn) {
  if (!fn || typeof fn !== 'object') fail('vm-effect-function-invalid');
  if (!fn.methodId || !fn.frontendId || !Array.isArray(fn.bundles)) fail('vm-effect-function-invalid-structure');
  for (const b of fn.bundles) validateVMEffectBundle(b);
  return true;
}
