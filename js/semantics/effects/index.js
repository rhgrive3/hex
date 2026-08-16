import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const MACHINE_EFFECTS_SCHEMA_VERSION = 1;
export const MACHINE_EFFECTS_CONTRACT_VERSION = '1.0.0';
export const MACHINE_EFFECT_DEFAULT_BUDGET = Object.freeze({
  maxOperations: 4096,
  maxPossibleFaults: 256,
  maxValuesPerOperation: 256,
  maxIntrinsicValues: 4096,
  maxIntrinsicRegisters: 4096,
  maxIntrinsicControlEffects: 256,
});

export const MACHINE_EFFECT_COMPLETENESS = Object.freeze([
  'exact',
  'exact-with-intrinsic',
  'partial',
  'unknown',
]);

export const PHYSICAL_ADDRESS_SPACES = Object.freeze([
  'register',
  'memory',
  'code',
  'tls',
  'io',
  'unique',
]);

export const MEMORY_ENDIANNESS = Object.freeze(['little', 'big']);
export const MEMORY_ORDERINGS = Object.freeze(['relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst']);
export const CONTROL_EFFECT_KINDS = Object.freeze([
  'fallthrough',
  'branch',
  'conditional-branch',
  'call',
  'return',
  'trap',
  'indirect',
  'unknown',
]);
export const MACHINE_VALUE_KINDS = Object.freeze([
  'bitvector',
  'float',
  'vector',
  'predicate',
  'register',
  'memory',
  'code',
  'tls',
  'io',
  'temporary',
  'flag',
]);
export const MACHINE_OPERATION_KINDS = Object.freeze([
  'value',
  'register-read',
  'register-write',
  'flag-read',
  'flag-write',
  'memory-read',
  'memory-write',
  'intrinsic',
  'barrier',
  'unknown',
]);
export const UNKNOWN_EFFECT_CATEGORIES = Object.freeze([
  'registers',
  'flags',
  'memory',
  'control',
  'faults',
  'other',
]);
export const INTRINSIC_MEMORY_SCOPES = Object.freeze(['none', 'accesses', 'all', 'unknown']);
export const INTRINSIC_DETERMINISM = Object.freeze(['deterministic', 'input-dependent', 'nondeterministic', 'unknown']);
export const INTRINSIC_SYMBOLIC_DETAIL = Object.freeze(['available', 'summary-only', 'unavailable']);

const SETS = Object.freeze({
  completeness: new Set(MACHINE_EFFECT_COMPLETENESS),
  spaces: new Set(PHYSICAL_ADDRESS_SPACES),
  endian: new Set(MEMORY_ENDIANNESS),
  orderings: new Set(MEMORY_ORDERINGS),
  controls: new Set(CONTROL_EFFECT_KINDS),
  values: new Set(MACHINE_VALUE_KINDS),
  operations: new Set(MACHINE_OPERATION_KINDS),
  unknownCategories: new Set(UNKNOWN_EFFECT_CATEGORIES),
  intrinsicMemoryScopes: new Set(INTRINSIC_MEMORY_SCOPES),
  intrinsicDeterminism: new Set(INTRINSIC_DETERMINISM),
  intrinsicSymbolicDetail: new Set(INTRINSIC_SYMBOLIC_DETAIL),
});

function fail(code) { throw new TypeError(code); }
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function optionalPositiveInteger(value, code) {
  return value == null ? undefined : positiveInteger(value, code);
}
function booleanOrUndefined(value, code) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') fail(code);
  return value;
}
function enumValue(value, allowed, code) {
  const text = nonEmpty(value, code);
  if (!allowed.has(text)) fail(code);
  return text;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function budgetLimit(options, key) {
  const fallback = MACHINE_EFFECT_DEFAULT_BUDGET[key];
  const candidate = options?.budget?.[key];
  return candidate == null ? fallback : positiveInteger(candidate, `machine-effects-invalid-budget-${key}`);
}
function boundedArray(value, code, options, budgetKey) {
  const values = array(value, code);
  if (values.length > budgetLimit(options, budgetKey)) fail(`machine-effects-budget-exceeded-${budgetKey}`);
  return values;
}
function uniqueSortedStrings(value, code) {
  return [...new Set(array(value, code).map((item) => nonEmpty(item, code)))].sort();
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('machine-effects-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function strictSerializable(value, code, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') fail(code);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return;
  if (typeof value !== 'object') fail(code);
  if (seen.has(value)) fail(code);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) strictSerializable(item, code, seen);
  } else {
    for (const item of Object.values(value)) strictSerializable(item, code, seen);
  }
  seen.delete(value);
}
function serializable(value, code) {
  strictSerializable(value, code);
  return jsonSafe(value);
}

function bigintValue(value, code) {
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { fail(code); }
}

function normalizeBitvectorValue(input) {
  assertAllowedKeys(input, new Set(['kind','widthBits','value']), 'machine-effects-unexpected-value-field');
  const widthBits = positiveInteger(input.widthBits, 'machine-effects-invalid-bitvector-width');
  const out = { kind: 'bitvector', widthBits };
  if (input.value != null) {
    const value = bigintValue(input.value, 'machine-effects-invalid-bitvector-value');
    if (value < 0n || value >= (1n << BigInt(widthBits))) fail('machine-effects-bitvector-value-out-of-range');
    out.value = value.toString();
  }
  return out;
}

function normalizeFloatValue(input) {
  assertAllowedKeys(input, new Set(['kind','widthBits','format','bitPattern','semanticValue']), 'machine-effects-unexpected-value-field');
  const widthBits = positiveInteger(input.widthBits, 'machine-effects-invalid-float-width');
  const format = nonEmpty(input.format, 'machine-effects-float-format-required');
  const out = { kind: 'float', widthBits, format };
  if (input.bitPattern != null) {
    const bitPattern = bigintValue(input.bitPattern, 'machine-effects-invalid-float-bit-pattern');
    if (bitPattern < 0n || bitPattern >= (1n << BigInt(widthBits))) fail('machine-effects-float-bit-pattern-out-of-range');
    out.bitPattern = bitPattern.toString();
  }
  if (input.semanticValue != null) out.semanticValue = nonEmpty(input.semanticValue, 'machine-effects-invalid-float-value');
  return out;
}

export function createMachineValue(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-invalid-value');
  const kind = enumValue(input.kind, SETS.values, 'machine-effects-invalid-value-kind');
  let out;

  switch (kind) {
    case 'bitvector': out = normalizeBitvectorValue(input); break;
    case 'float': out = normalizeFloatValue(input); break;
    case 'vector': {
      assertAllowedKeys(input, new Set(['kind','laneCount','elementType']), 'machine-effects-unexpected-value-field');
      const laneCount = positiveInteger(input.laneCount, 'machine-effects-invalid-vector-lane-count');
      const elementType = createMachineValue(input.elementType, options);
      if (!['bitvector', 'float', 'predicate'].includes(elementType.kind)) fail('machine-effects-invalid-vector-element-type');
      out = { kind, laneCount, elementType };
      break;
    }
    case 'predicate': {
      assertAllowedKeys(input, new Set(['kind','widthBits','laneCount']), 'machine-effects-unexpected-value-field');
      out = { kind, widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-predicate-width') };
      if (input.laneCount != null) out.laneCount = positiveInteger(input.laneCount, 'machine-effects-invalid-predicate-lane-count');
      break;
    }
    case 'register':
      assertAllowedKeys(input, new Set(['kind','registerId','widthBits','view']), 'machine-effects-unexpected-value-field');
      out = {
        kind,
        registerId: nonEmpty(input.registerId, 'machine-effects-register-id-required'),
        widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-register-width'),
      };
      if (input.view != null) out.view = nonEmpty(input.view, 'machine-effects-invalid-register-view');
      break;
    case 'flag':
      assertAllowedKeys(input, new Set(['kind','flagId','widthBits']), 'machine-effects-unexpected-value-field');
      out = {
        kind,
        flagId: nonEmpty(input.flagId, 'machine-effects-flag-id-required'),
        widthBits: input.widthBits == null ? 1 : positiveInteger(input.widthBits, 'machine-effects-invalid-flag-width'),
      };
      break;
    case 'temporary':
      assertAllowedKeys(input, new Set(['kind','temporaryId','id','valueType']), 'machine-effects-unexpected-value-field');
      out = {
        kind,
        temporaryId: nonEmpty(input.temporaryId ?? input.id, 'machine-effects-temporary-id-required'),
        valueType: createMachineValue(input.valueType, options),
      };
      break;
    case 'memory':
    case 'code':
    case 'tls':
    case 'io':
      assertAllowedKeys(input, new Set(['kind','addressExpr','widthBits']), 'machine-effects-unexpected-value-field');
      out = {
        kind,
        addressExpr: serializable(input.addressExpr, 'machine-effects-invalid-address-expression'),
        widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-location-width'),
      };
      break;
    default:
      fail('machine-effects-invalid-value-kind');
  }

  return deepFreeze(out);
}

export function createBitVectorValue(widthBits, value) {
  return createMachineValue({ kind: 'bitvector', widthBits, ...(value == null ? {} : { value }) });
}
export function createRegisterValue(registerId, widthBits, options = {}) {
  return createMachineValue({ kind: 'register', registerId, widthBits, ...options });
}
export function createFlagValue(flagId, widthBits = 1) {
  return createMachineValue({ kind: 'flag', flagId, widthBits });
}
export function createTemporaryValue(temporaryId, valueType) {
  return createMachineValue({ kind: 'temporary', temporaryId, valueType });
}
export function createFloatValue(widthBits, format, options = {}) {
  return createMachineValue({ kind: 'float', widthBits, format, ...options });
}
export function createVectorValue(laneCount, elementType) {
  return createMachineValue({ kind: 'vector', laneCount, elementType });
}
export function createPredicateValue(widthBits, laneCount) {
  return createMachineValue({ kind: 'predicate', widthBits, ...(laneCount == null ? {} : { laneCount }) });
}
export function createLocationValue(kind, addressExpr, widthBits) {
  if (!['memory','code','tls','io'].includes(kind)) fail('machine-effects-invalid-location-kind');
  return createMachineValue({ kind, addressExpr, widthBits });
}

export function createMemoryAccess(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-invalid-memory-access');
  assertAllowedKeys(input, new Set(['space','addressExpr','widthBits','alignment','endian','volatility','atomic','ordering']), 'machine-effects-unexpected-memory-access-field');
  const space = enumValue(input.space, SETS.spaces, 'machine-effects-invalid-memory-space');
  if (space === 'register' || space === 'unique') fail('machine-effects-memory-space-not-addressable');
  const out = {
    space,
    addressExpr: serializable(input.addressExpr, 'machine-effects-invalid-address-expression'),
    widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-memory-width'),
    endian: enumValue(input.endian, SETS.endian, 'machine-effects-invalid-endian'),
  };
  const alignment = optionalPositiveInteger(input.alignment, 'machine-effects-invalid-memory-alignment');
  if (alignment != null) out.alignment = alignment;
  const volatility = booleanOrUndefined(input.volatility, 'machine-effects-invalid-volatility');
  if (volatility != null) out.volatility = volatility;
  const atomic = booleanOrUndefined(input.atomic, 'machine-effects-invalid-atomic');
  if (atomic != null) out.atomic = atomic;
  if (input.ordering != null) {
    out.ordering = enumValue(input.ordering, SETS.orderings, 'machine-effects-invalid-memory-ordering');
    if (atomic === false) fail('machine-effects-ordering-requires-atomic-access');
  }
  return deepFreeze(out);
}

function normalizeControlEffect(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-control-effect-required');
  assertAllowedKeys(input, new Set(['kind','target','targets','condition','fallthrough','reason']), 'machine-effects-unexpected-control-effect-field');
  const kind = enumValue(input.kind, SETS.controls, 'machine-effects-invalid-control-effect');
  const out = { kind };
  if (input.target != null) out.target = serializable(input.target, 'machine-effects-invalid-control-target');
  if (input.targets != null) out.targets = array(input.targets, 'machine-effects-invalid-control-targets').map((value) => serializable(value, 'machine-effects-invalid-control-target'));
  if (input.condition != null) out.condition = serializable(input.condition, 'machine-effects-invalid-control-condition');
  if (input.fallthrough != null) out.fallthrough = serializable(input.fallthrough, 'machine-effects-invalid-control-fallthrough');
  if (input.reason != null) out.reason = nonEmpty(input.reason, 'machine-effects-invalid-control-reason');
  if (kind === 'unknown' && !out.reason) fail('machine-effects-unknown-control-reason-required');
  return deepFreeze(out);
}

function normalizeFault(input) {
  input = object(input, 'machine-effects-invalid-fault');
  assertAllowedKeys(input, new Set(['kind','condition','detail']), 'machine-effects-unexpected-fault-field');
  const out = { kind: nonEmpty(input.kind, 'machine-effects-fault-kind-required') };
  if (input.condition != null) out.condition = serializable(input.condition, 'machine-effects-invalid-fault-condition');
  if (input.detail != null) out.detail = serializable(input.detail, 'machine-effects-invalid-fault-detail');
  return deepFreeze(out);
}

function normalizeIntrinsicMemoryScope(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-intrinsic-memory-scope-required');
  assertAllowedKeys(input, new Set(['scope','accesses','spaces','detail']), 'machine-effects-unexpected-intrinsic-memory-field');
  const scope = enumValue(input.scope, SETS.intrinsicMemoryScopes, 'machine-effects-invalid-intrinsic-memory-scope');
  const out = { scope };
  if (scope === 'accesses') {
    const accesses = array(input.accesses, 'machine-effects-intrinsic-memory-accesses-required').map((access) => createMemoryAccess(access, options));
    if (accesses.length === 0) fail('machine-effects-intrinsic-memory-accesses-required');
    out.accesses = accesses;
  }
  if (scope === 'all') {
    out.spaces = uniqueSortedStrings(input.spaces, 'machine-effects-intrinsic-memory-spaces-required');
    if (out.spaces.length === 0 || out.spaces.some((space) => !SETS.spaces.has(space) || space === 'register' || space === 'unique')) {
      fail('machine-effects-invalid-intrinsic-memory-spaces');
    }
  }
  if (input.detail != null) out.detail = serializable(input.detail, 'machine-effects-invalid-intrinsic-memory-detail');
  return deepFreeze(out);
}

export function createIntrinsicEffectSummary(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-intrinsic-summary-required');
  assertAllowedKeys(input, new Set(['inputs','outputs','registersRead','registersWritten','memoryRead','memoryWrite','controlEffects','determinism','symbolicDetail']), 'machine-effects-unexpected-intrinsic-summary-field');
  const out = {
    inputs: boundedArray(input.inputs, 'machine-effects-intrinsic-inputs-required', options, 'maxIntrinsicValues').map((value) => createMachineValue(value, options)),
    outputs: boundedArray(input.outputs, 'machine-effects-intrinsic-outputs-required', options, 'maxIntrinsicValues').map((value) => createMachineValue(value, options)),
    registersRead: uniqueSortedStrings(boundedArray(input.registersRead, 'machine-effects-intrinsic-registers-read-required', options, 'maxIntrinsicRegisters'), 'machine-effects-intrinsic-registers-read-required'),
    registersWritten: uniqueSortedStrings(boundedArray(input.registersWritten, 'machine-effects-intrinsic-registers-written-required', options, 'maxIntrinsicRegisters'), 'machine-effects-intrinsic-registers-written-required'),
    memoryRead: normalizeIntrinsicMemoryScope(input.memoryRead, options),
    memoryWrite: normalizeIntrinsicMemoryScope(input.memoryWrite, options),
    controlEffects: boundedArray(input.controlEffects, 'machine-effects-intrinsic-control-effects-required', options, 'maxIntrinsicControlEffects').map((effect) => normalizeControlEffect(effect, options)),
    determinism: enumValue(input.determinism, SETS.intrinsicDeterminism, 'machine-effects-invalid-intrinsic-determinism'),
    symbolicDetail: enumValue(input.symbolicDetail, SETS.intrinsicSymbolicDetail, 'machine-effects-invalid-intrinsic-symbolic-detail'),
  };
  return deepFreeze(out);
}

function intrinsicSummaryIsComplete(summary) {
  if (summary.memoryRead.scope === 'unknown' || summary.memoryWrite.scope === 'unknown') return false;
  if (summary.controlEffects.some((effect) => effect.kind === 'unknown')) return false;
  return summary.determinism !== 'unknown';
}

export function createMachineOperation(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-invalid-operation');
  assertAllowedKeys(input, new Set(['kind','id','opcode','inputs','outputs','register','flag','access','value','intrinsicId','effectSummary','scope','reason','categories','metadata']), 'machine-effects-unexpected-operation-field');
  const kind = enumValue(input.kind, SETS.operations, 'machine-effects-invalid-operation-kind');
  const out = { kind };
  if (input.id != null) out.id = nonEmpty(input.id, 'machine-effects-invalid-operation-id');

  if (kind === 'value') {
    out.opcode = nonEmpty(input.opcode, 'machine-effects-value-opcode-required');
    out.inputs = boundedArray(input.inputs ?? [], 'machine-effects-invalid-operation-inputs', options, 'maxValuesPerOperation').map((value) => createMachineValue(value, options));
    out.outputs = boundedArray(input.outputs, 'machine-effects-operation-outputs-required', options, 'maxValuesPerOperation').map((value) => createMachineValue(value, options));
    if (out.outputs.length === 0) fail('machine-effects-operation-outputs-required');
  } else if (kind === 'register-read' || kind === 'register-write') {
    out.register = createMachineValue(input.register, options);
    if (out.register.kind !== 'register') fail('machine-effects-register-operation-requires-register-value');
    out.value = createMachineValue(input.value, options);
  } else if (kind === 'flag-read' || kind === 'flag-write') {
    out.flag = createMachineValue(input.flag, options);
    if (out.flag.kind !== 'flag') fail('machine-effects-flag-operation-requires-flag-value');
    out.value = createMachineValue(input.value, options);
  } else if (kind === 'memory-read' || kind === 'memory-write') {
    out.access = createMemoryAccess(input.access, options);
    out.value = createMachineValue(input.value, options);
  } else if (kind === 'intrinsic') {
    out.intrinsicId = nonEmpty(input.intrinsicId, 'machine-effects-intrinsic-id-required');
    out.effectSummary = createIntrinsicEffectSummary(input.effectSummary, options);
  } else if (kind === 'barrier') {
    out.scope = serializable(input.scope, 'machine-effects-barrier-scope-required');
  } else if (kind === 'unknown') {
    out.reason = nonEmpty(input.reason, 'machine-effects-unknown-operation-reason-required');
    out.categories = uniqueSortedStrings(input.categories, 'machine-effects-unknown-operation-categories-required');
    if (out.categories.length === 0 || out.categories.some((category) => !SETS.unknownCategories.has(category))) {
      fail('machine-effects-invalid-unknown-operation-categories');
    }
  }

  if (input.metadata != null) out.metadata = serializable(input.metadata, 'machine-effects-invalid-operation-metadata');
  return deepFreeze(out);
}

export function createUnknownEffects(input) {
  input = object(input, 'machine-effects-unknown-effects-required');
  assertAllowedKeys(input, new Set(['categories','reason','detail','preservation']), 'machine-effects-unexpected-unknown-effects-field');
  const categories = uniqueSortedStrings(input.categories, 'machine-effects-unknown-categories-required');
  if (categories.length === 0 || categories.some((category) => !SETS.unknownCategories.has(category))) {
    fail('machine-effects-invalid-unknown-categories');
  }
  if (input.preservation != null && input.preservation !== 'not-assumed') fail('machine-effects-unknown-effects-cannot-assume-preservation');
  const out = {
    categories,
    reason: nonEmpty(input.reason, 'machine-effects-unknown-reason-required'),
    preservation: 'not-assumed',
  };
  if (input.detail != null) out.detail = serializable(input.detail, 'machine-effects-invalid-unknown-detail');
  return deepFreeze(out);
}

function normalizeStatePreservation(input) {
  input = object(input, 'machine-effects-state-preservation-proof-required');
  assertAllowedKeys(input, new Set(['proven','reason']), 'machine-effects-unexpected-state-preservation-field');
  if (input.proven !== true) fail('machine-effects-state-preservation-proof-required');
  return deepFreeze({ proven: true, reason: nonEmpty(input.reason, 'machine-effects-state-preservation-reason-required') });
}

function validateCompletenessSemantics(bundle) {
  const hasUnknownOperation = bundle.operations.some((operation) => operation.kind === 'unknown');
  const intrinsics = bundle.operations.filter((operation) => operation.kind === 'intrinsic');
  const intrinsicIsIncomplete = intrinsics.some((operation) => !intrinsicSummaryIsComplete(operation.effectSummary));
  const controlUnknown = bundle.controlEffect.kind === 'unknown';
  const unresolved = hasUnknownOperation || intrinsicIsIncomplete || controlUnknown;

  if (bundle.completeness === 'exact') {
    if (bundle.unknownEffects != null || unresolved || intrinsics.length !== 0) fail('machine-effects-exact-has-unresolved-effects');
  }
  if (bundle.completeness === 'exact-with-intrinsic') {
    if (bundle.unknownEffects != null || unresolved || intrinsics.length === 0) fail('machine-effects-intrinsic-completeness-invalid');
  }
  if (bundle.completeness === 'partial') {
    if (bundle.unknownEffects == null) fail('machine-effects-partial-requires-explicit-unknown-effects');
  }
  if (bundle.completeness === 'unknown') {
    if (bundle.unknownEffects == null) fail('machine-effects-unknown-requires-explicit-unknown-effects');
    if (bundle.operations.length !== 0 || bundle.controlEffect.kind !== 'unknown') fail('machine-effects-unknown-bundle-must-not-imply-known-state');
  }

  const silentPreserve = (bundle.completeness === 'exact' || bundle.completeness === 'exact-with-intrinsic')
    && bundle.operations.length === 0
    && bundle.controlEffect.kind === 'fallthrough'
    && bundle.possibleFaults.length === 0;
  if (silentPreserve && bundle.statePreservation == null) fail('machine-effects-silent-preserve-requires-proof');
  if (!silentPreserve && bundle.statePreservation != null) fail('machine-effects-state-preservation-conflicts-with-effects');
}

function normalizeBundle(input, options = {}, requireVersion = false) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-invalid-bundle');
  assertAllowedKeys(input, new Set(['schemaVersion','contractVersion','instructionId','architectureId','mode','operations','controlEffect','possibleFaults','origin','completeness','unknownEffects','statePreservation','metadata']), 'machine-effects-unexpected-bundle-field');

  if (requireVersion) {
    if (input.schemaVersion !== MACHINE_EFFECTS_SCHEMA_VERSION || input.contractVersion !== MACHINE_EFFECTS_CONTRACT_VERSION) {
      fail('machine-effects-unsupported-contract-version');
    }
  } else {
    if (input.schemaVersion != null && input.schemaVersion !== MACHINE_EFFECTS_SCHEMA_VERSION) fail('machine-effects-unsupported-schema-version');
    if (input.contractVersion != null && input.contractVersion !== MACHINE_EFFECTS_CONTRACT_VERSION) fail('machine-effects-unsupported-contract-version');
  }

  const instructionId = nonEmpty(input.instructionId, 'machine-effects-instruction-id-required');
  const origin = createOriginSet(input.origin);
  if (!origin.instructionIds.includes(instructionId)) fail('machine-effects-origin-must-reference-instruction');

  const bundle = {
    schemaVersion: MACHINE_EFFECTS_SCHEMA_VERSION,
    contractVersion: MACHINE_EFFECTS_CONTRACT_VERSION,
    instructionId,
    architectureId: nonEmpty(input.architectureId, 'machine-effects-architecture-id-required'),
    mode: nonEmpty(input.mode, 'machine-effects-mode-required'),
    operations: boundedArray(input.operations, 'machine-effects-operations-required', options, 'maxOperations').map((operation) => createMachineOperation(operation, options)),
    controlEffect: normalizeControlEffect(input.controlEffect, options),
    possibleFaults: boundedArray(input.possibleFaults, 'machine-effects-possible-faults-required', options, 'maxPossibleFaults').map(normalizeFault),
    origin,
    completeness: enumValue(input.completeness, SETS.completeness, 'machine-effects-invalid-completeness'),
  };

  if (input.unknownEffects != null) bundle.unknownEffects = createUnknownEffects(input.unknownEffects);
  if (input.statePreservation != null) bundle.statePreservation = normalizeStatePreservation(input.statePreservation);
  if (input.metadata != null) bundle.metadata = serializable(input.metadata, 'machine-effects-invalid-metadata');

  validateCompletenessSemantics(bundle);
  return deepFreeze(bundle);
}

export function createMachineEffectBundle(input, options = {}) {
  return normalizeBundle(input, options, false);
}

export function validateMachineEffectBundle(input, options = {}) {
  return normalizeBundle(input, options, true);
}

export function serializeMachineEffectBundle(input, options = {}) {
  assertNotAborted(options);
  return stableStringify(validateMachineEffectBundle(input, options));
}

export function deserializeMachineEffectBundle(text, options = {}) {
  assertNotAborted(options);
  if (typeof text !== 'string') fail('machine-effects-serialized-text-required');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail('machine-effects-invalid-serialized-json'); }
  return validateMachineEffectBundle(parsed, options);
}
