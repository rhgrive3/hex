import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import {
  SEMANTIC_SETS,
  array,
  assertAllowedKeys,
  enumValue,
  fail,
  nonEmpty,
  normalizeBooleanKnowledge,
  object,
  optionalPositiveInteger,
  positiveInteger,
  serializable,
  sortedUniqueStrings,
  uniqueStrings,
} from './common.js';

export function createSemanticMachineType(input) {
  input = object(input, 'semantic-ir-invalid-machine-type');
  assertAllowedKeys(input, new Set(['kind', 'widthBits', 'format', 'laneCount', 'elementType', 'addressSpace']), 'semantic-ir-unexpected-machine-type-field');
  const kind = enumValue(input.kind, SEMANTIC_SETS.machineTypes, 'semantic-ir-invalid-machine-type-kind');
  let out;
  if (kind === 'bitvector') {
    out = { kind, widthBits: positiveInteger(input.widthBits, 'semantic-ir-invalid-width') };
  } else if (kind === 'float') {
    out = { kind, widthBits: positiveInteger(input.widthBits, 'semantic-ir-invalid-width'), format: nonEmpty(input.format, 'semantic-ir-float-format-required') };
  } else if (kind === 'vector') {
    out = { kind, laneCount: positiveInteger(input.laneCount, 'semantic-ir-invalid-vector-lane-count'), elementType: createSemanticMachineType(input.elementType) };
    if (out.elementType.kind === 'vector' || out.elementType.kind === 'address') fail('semantic-ir-invalid-vector-element-type');
  } else if (kind === 'predicate') {
    out = { kind, widthBits: positiveInteger(input.widthBits, 'semantic-ir-invalid-width') };
    if (input.laneCount != null) out.laneCount = positiveInteger(input.laneCount, 'semantic-ir-invalid-predicate-lane-count');
  } else {
    out = { kind, widthBits: positiveInteger(input.widthBits, 'semantic-ir-invalid-width'), addressSpace: nonEmpty(input.addressSpace, 'semantic-ir-address-space-required') };
  }
  return deepFreeze(out);
}

export function createSemanticVariableRef(input) {
  input = object(input, 'semantic-ir-invalid-variable-ref');
  assertAllowedKeys(input, new Set(['key', 'kind', 'scope', 'physicalIdentity', 'metadata']), 'semantic-ir-unexpected-variable-field');
  const out = {
    key: nonEmpty(input.key, 'semantic-ir-variable-key-required'),
    kind: enumValue(input.kind, SEMANTIC_SETS.variables, 'semantic-ir-invalid-variable-kind'),
    scope: enumValue(input.scope ?? 'function', SEMANTIC_SETS.variableScopes, 'semantic-ir-invalid-variable-scope'),
  };
  if (input.physicalIdentity != null) out.physicalIdentity = serializable(input.physicalIdentity, 'semantic-ir-invalid-physical-identity');
  if (input.metadata != null) out.metadata = serializable(input.metadata, 'semantic-ir-invalid-variable-metadata');
  return deepFreeze(out);
}

function normalizeFaults(value) {
  if (value == null) return [];
  return array(value, 'semantic-ir-invalid-faults').map((item) => {
    item = object(item, 'semantic-ir-invalid-fault');
    assertAllowedKeys(item, new Set(['kind', 'condition', 'detail']), 'semantic-ir-unexpected-fault-field');
    const out = { kind: nonEmpty(item.kind, 'semantic-ir-fault-kind-required') };
    if (item.condition != null) out.condition = serializable(item.condition, 'semantic-ir-invalid-fault-condition');
    if (item.detail != null) out.detail = serializable(item.detail, 'semantic-ir-invalid-fault-detail');
    return out;
  }).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

export function createSemanticMemoryAccess(input) {
  input = object(input, 'semantic-ir-invalid-memory-access');
  assertAllowedKeys(input, new Set(['addressSpace', 'addressExpr', 'addressValueId', 'widthBits', 'endian', 'alignment', 'volatility', 'atomic', 'ordering', 'faults']), 'semantic-ir-unexpected-memory-field');
  const rawAddress = input.addressExpr ?? (input.addressValueId == null ? null : { valueId: input.addressValueId });
  const addressExpr = object(rawAddress, 'semantic-ir-address-expression-required');
  assertAllowedKeys(addressExpr, new Set(['valueId']), 'semantic-ir-unexpected-address-expression-field');
  const out = {
    addressSpace: nonEmpty(input.addressSpace, 'semantic-ir-memory-address-space-required'),
    addressExpr: { valueId: nonEmpty(addressExpr.valueId, 'semantic-ir-address-value-id-required') },
    widthBits: positiveInteger(input.widthBits, 'semantic-ir-invalid-memory-width'),
    endian: enumValue(input.endian, SEMANTIC_SETS.endian, 'semantic-ir-invalid-memory-endian'),
    alignment: optionalPositiveInteger(input.alignment, 'semantic-ir-invalid-memory-alignment'),
    volatility: input.volatility == null ? 'unknown' : normalizeBooleanKnowledge(input.volatility, 'semantic-ir-invalid-memory-volatility'),
    atomic: input.atomic == null ? 'unknown' : normalizeBooleanKnowledge(input.atomic, 'semantic-ir-invalid-memory-atomic'),
    ordering: input.ordering == null ? 'unknown' : enumValue(input.ordering, SEMANTIC_SETS.orderings, 'semantic-ir-invalid-memory-ordering'),
    faults: normalizeFaults(input.faults),
  };
  if (out.atomic === false && out.ordering !== 'unknown') fail('semantic-ir-memory-ordering-requires-atomic');
  return deepFreeze(out);
}

export function createSemanticMemoryScope(input) {
  input = object(input, 'semantic-ir-effect-memory-scope-required');
  assertAllowedKeys(input, new Set(['scope', 'accesses', 'addressSpaces', 'detail']), 'semantic-ir-unexpected-effect-memory-field');
  const scope = enumValue(input.scope, SEMANTIC_SETS.intrinsicMemoryScopes, 'semantic-ir-invalid-effect-memory-scope');
  const out = { scope };
  if (scope === 'accesses') {
    out.accesses = array(input.accesses, 'semantic-ir-effect-memory-accesses-required').map(createSemanticMemoryAccess);
    if (!out.accesses.length) fail('semantic-ir-effect-memory-accesses-required');
  } else if (input.accesses != null) fail('semantic-ir-effect-memory-accesses-not-allowed');
  if (scope === 'all') {
    out.addressSpaces = sortedUniqueStrings(input.addressSpaces, 'semantic-ir-effect-address-spaces-required');
    if (!out.addressSpaces.length) fail('semantic-ir-effect-address-spaces-required');
  } else if (input.addressSpaces != null) fail('semantic-ir-effect-address-spaces-not-allowed');
  if (input.detail != null) out.detail = serializable(input.detail, 'semantic-ir-invalid-effect-memory-detail');
  return deepFreeze(out);
}

export function createSemanticIntrinsicSummary(input) {
  input = object(input, 'semantic-ir-intrinsic-summary-required');
  assertAllowedKeys(input, new Set(['inputs', 'outputs', 'stateReads', 'stateWrites', 'memoryRead', 'memoryWrite', 'controlEffects', 'determinism', 'symbolicDetail']), 'semantic-ir-unexpected-intrinsic-summary-field');
  return deepFreeze({
    inputs: uniqueStrings(input.inputs ?? [], 'semantic-ir-invalid-intrinsic-inputs', false),
    outputs: uniqueStrings(input.outputs ?? [], 'semantic-ir-invalid-intrinsic-outputs', false),
    stateReads: array(input.stateReads ?? [], 'semantic-ir-invalid-intrinsic-state-reads').map(createSemanticVariableRef).sort((a, b) => a.key.localeCompare(b.key)),
    stateWrites: array(input.stateWrites ?? [], 'semantic-ir-invalid-intrinsic-state-writes').map(createSemanticVariableRef).sort((a, b) => a.key.localeCompare(b.key)),
    memoryRead: createSemanticMemoryScope(input.memoryRead),
    memoryWrite: createSemanticMemoryScope(input.memoryWrite),
    controlEffects: array(input.controlEffects ?? [], 'semantic-ir-invalid-intrinsic-control-effects').map((value) => serializable(value, 'semantic-ir-invalid-intrinsic-control-effect')),
    determinism: enumValue(input.determinism, SEMANTIC_SETS.intrinsicDeterminism, 'semantic-ir-invalid-intrinsic-determinism'),
    symbolicDetail: enumValue(input.symbolicDetail, SEMANTIC_SETS.intrinsicSymbolicDetail, 'semantic-ir-invalid-intrinsic-symbolic-detail'),
  });
}

export function createSemanticCallSummary(input) {
  input = object(input, 'semantic-ir-call-summary-required');
  assertAllowedKeys(input, new Set(['targetValueIds', 'targetEntityIds', 'arguments', 'returns', 'stateReads', 'stateWrites', 'memoryRead', 'memoryWrite', 'controlEffects', 'determinism', 'noreturn', 'mayThrow', 'summarySource', 'completeness', 'unknownEffects']), 'semantic-ir-unexpected-call-summary-field');
  const completeness = enumValue(input.completeness, SEMANTIC_SETS.callCompleteness, 'semantic-ir-invalid-call-completeness');
  let unknownEffects = null;
  if (input.unknownEffects != null) {
    const unknown = object(input.unknownEffects, 'semantic-ir-invalid-call-unknown-effects');
    assertAllowedKeys(unknown, new Set(['reason', 'categories']), 'semantic-ir-unexpected-call-unknown-effect-field');
    unknownEffects = deepFreeze({
      reason: nonEmpty(unknown.reason, 'semantic-ir-call-unknown-reason-required'),
      categories: sortedUniqueStrings(unknown.categories ?? [], 'semantic-ir-invalid-call-unknown-categories'),
    });
    if (!unknownEffects.categories.length) fail('semantic-ir-call-unknown-categories-required');
  }
  const out = {
    targetValueIds: sortedUniqueStrings(input.targetValueIds ?? [], 'semantic-ir-invalid-call-target-values'),
    targetEntityIds: sortedUniqueStrings(input.targetEntityIds ?? [], 'semantic-ir-invalid-call-target-entities'),
    arguments: uniqueStrings(input.arguments ?? [], 'semantic-ir-invalid-call-arguments', false),
    returns: uniqueStrings(input.returns ?? [], 'semantic-ir-invalid-call-returns', false),
    stateReads: array(input.stateReads ?? [], 'semantic-ir-invalid-call-state-reads').map(createSemanticVariableRef).sort((a, b) => a.key.localeCompare(b.key)),
    stateWrites: array(input.stateWrites ?? [], 'semantic-ir-invalid-call-state-writes').map(createSemanticVariableRef).sort((a, b) => a.key.localeCompare(b.key)),
    memoryRead: createSemanticMemoryScope(input.memoryRead),
    memoryWrite: createSemanticMemoryScope(input.memoryWrite),
    controlEffects: array(input.controlEffects ?? [], 'semantic-ir-invalid-call-control-effects').map((value) => serializable(value, 'semantic-ir-invalid-call-control-effect')),
    determinism: enumValue(input.determinism, SEMANTIC_SETS.intrinsicDeterminism, 'semantic-ir-invalid-call-determinism'),
    noreturn: normalizeBooleanKnowledge(input.noreturn, 'semantic-ir-invalid-call-noreturn'),
    mayThrow: normalizeBooleanKnowledge(input.mayThrow, 'semantic-ir-invalid-call-may-throw'),
    summarySource: nonEmpty(input.summarySource, 'semantic-ir-call-summary-source-required'),
    completeness,
    unknownEffects,
  };
  const unresolved = out.memoryRead.scope === 'unknown' || out.memoryWrite.scope === 'unknown'
    || out.determinism === 'unknown' || out.noreturn === 'unknown' || out.mayThrow === 'unknown';
  if (completeness === 'complete' && (unknownEffects != null || unresolved)) fail('semantic-ir-complete-call-has-unknown-effects');
  if (completeness !== 'complete' && unknownEffects == null) fail('semantic-ir-partial-call-requires-unknown-effects');
  return deepFreeze(out);
}
