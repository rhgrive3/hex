import { jsonSafe } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const SEMANTIC_IR_SCHEMA_VERSION = 2;
export const SEMANTIC_IR_CONTRACT_VERSION = '2.0.0';
export const SEMANTIC_IR_DEFAULT_BUDGET = Object.freeze({
  maxBlocks: 16384,
  maxNodes: 131072,
  maxValues: 262144,
  maxReferences: 1048576,
});
export const SEMANTIC_COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown']);
export const SEMANTIC_MACHINE_TYPE_KINDS = Object.freeze(['bitvector', 'float', 'vector', 'predicate', 'address']);
export const SEMANTIC_VARIABLE_KINDS = Object.freeze(['physical-state', 'semantic-temporary', 'logical-state', 'external-state', 'unknown-state']);
export const SEMANTIC_VARIABLE_SCOPES = Object.freeze(['function', 'module', 'thread', 'process', 'global', 'unknown']);
export const SEMANTIC_OPERATION_KINDS = Object.freeze([
  'const', 'copy', 'unary', 'binary', 'compare', 'select', 'zext', 'sext', 'trunc', 'bitcast',
  'extract', 'insert', 'concat', 'state-read', 'state-write', 'address', 'load', 'store', 'call',
  'return', 'branch', 'conditional-branch', 'switch', 'trap', 'barrier', 'intrinsic', 'unknown-value',
  'unknown-state-write', 'unknown-memory-effect', 'unknown-control-effect', 'incomplete',
]);
export const SEMANTIC_VALUE_KINDS = Object.freeze(['definition', 'entry', 'unknown', 'undef']);
export const SEMANTIC_MEMORY_ENDIANNESS = Object.freeze(['little', 'big']);
export const SEMANTIC_MEMORY_ORDERINGS = Object.freeze(['relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst', 'unknown']);
export const SEMANTIC_INTRINSIC_MEMORY_SCOPES = Object.freeze(['none', 'accesses', 'all', 'unknown']);
export const SEMANTIC_INTRINSIC_DETERMINISM = Object.freeze(['deterministic', 'input-dependent', 'nondeterministic', 'unknown']);
export const SEMANTIC_INTRINSIC_SYMBOLIC_DETAIL = Object.freeze(['available', 'summary-only', 'unavailable']);
export const SEMANTIC_CALL_COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown']);
export const SEMANTIC_UNKNOWN_OPERATION_KINDS = Object.freeze([
  'unknown-value', 'unknown-state-write', 'unknown-memory-effect', 'unknown-control-effect', 'incomplete',
]);

export const SEMANTIC_SETS = Object.freeze({
  completeness: new Set(SEMANTIC_COMPLETENESS),
  machineTypes: new Set(SEMANTIC_MACHINE_TYPE_KINDS),
  variables: new Set(SEMANTIC_VARIABLE_KINDS),
  variableScopes: new Set(SEMANTIC_VARIABLE_SCOPES),
  operations: new Set(SEMANTIC_OPERATION_KINDS),
  values: new Set(SEMANTIC_VALUE_KINDS),
  endian: new Set(SEMANTIC_MEMORY_ENDIANNESS),
  orderings: new Set(SEMANTIC_MEMORY_ORDERINGS),
  intrinsicMemoryScopes: new Set(SEMANTIC_INTRINSIC_MEMORY_SCOPES),
  intrinsicDeterminism: new Set(SEMANTIC_INTRINSIC_DETERMINISM),
  intrinsicSymbolicDetail: new Set(SEMANTIC_INTRINSIC_SYMBOLIC_DETAIL),
  callCompleteness: new Set(SEMANTIC_CALL_COMPLETENESS),
  unknownOperations: new Set(SEMANTIC_UNKNOWN_OPERATION_KINDS),
});

export function fail(code) { throw new TypeError(code); }
export function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
export function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
export function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
export function optionalPositiveInteger(value, code) {
  return value == null ? null : positiveInteger(value, code);
}
export function enumValue(value, set, code) {
  const text = nonEmpty(value, code);
  if (!set.has(text)) fail(code);
  return text;
}
export function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
export function uniqueStrings(values, code, sort = true) {
  const out = array(values ?? [], code).map((value) => nonEmpty(value, code));
  if (new Set(out).size !== out.length) fail(`${code}-duplicate`);
  return sort ? out.slice().sort() : out;
}
export function sortedUniqueStrings(values, code) {
  return [...new Set(array(values ?? [], code).map((value) => nonEmpty(value, code)))].sort();
}
export function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
export function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ir-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
export function budgetLimit(options, key) {
  const fallback = SEMANTIC_IR_DEFAULT_BUDGET[key];
  return options?.budget?.[key] == null ? fallback : positiveInteger(options.budget[key], `semantic-ir-invalid-budget-${key}`);
}
export function assertWithinBudget(length, options, key) {
  if (length > budgetLimit(options, key)) fail(`semantic-ir-budget-exceeded-${key}`);
}
function strictSerializable(value, code, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') fail(code);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return;
  if (typeof value !== 'object' || seen.has(value)) fail(code);
  seen.add(value);
  if (Array.isArray(value)) for (const item of value) strictSerializable(item, code, seen);
  else for (const item of Object.values(value)) strictSerializable(item, code, seen);
  seen.delete(value);
}
export function serializable(value, code) {
  strictSerializable(value, code);
  return jsonSafe(value);
}
export function requiredOrigin(input, code) {
  if (!Object.hasOwn(input, 'origin')) fail(code);
  const origin = createOriginSet(input.origin);
  const hasOrigin = origin.byteRanges.length || origin.virtualRanges.length || origin.instructionIds.length
    || origin.operationIds.length || origin.sourceLocations.length || origin.parentEntityIds.length || origin.transforms.length;
  if (!hasOrigin) fail('semantic-ir-empty-origin');
  return origin;
}
export function normalizeBooleanKnowledge(value, code) {
  if (value == null) return null;
  if (value === true || value === false || value === 'unknown') return value;
  fail(code);
}
