import { deepFreeze } from '../../core/identity/index.js';
import {
  SEMANTIC_SETS,
  assertAllowedKeys,
  enumValue,
  fail,
  nonEmpty,
  object,
  requiredOrigin,
  serializable,
  sortedUniqueStrings,
  uniqueStrings,
} from './common.js';
import {
  createSemanticCallSummary,
  createSemanticIntrinsicSummary,
  createSemanticMachineType,
  createSemanticMemoryAccess,
  createSemanticVariableRef,
} from './types.js';

const MEMORY_NODE_KINDS = new Set(['load', 'store']);
const VARIABLE_NODE_KINDS = new Set(['state-read', 'state-write']);
const CONTROL_NODE_KINDS = new Set(['branch', 'conditional-branch', 'switch']);

export function createSemanticValue(input) {
  input = object(input, 'semantic-ir-invalid-value');
  assertAllowedKeys(input, new Set([
    'id', 'kind', 'machineType', 'definitionNodeId', 'sourceEntityId', 'variableKey', 'origin', 'metadata',
  ]), 'semantic-ir-unexpected-value-field');
  const kind = enumValue(input.kind, SEMANTIC_SETS.values, 'semantic-ir-invalid-value-kind');
  const out = {
    id: nonEmpty(input.id, 'semantic-ir-value-id-required'),
    kind,
    machineType: createSemanticMachineType(input.machineType),
    definitionNodeId: input.definitionNodeId == null ? null : nonEmpty(input.definitionNodeId, 'semantic-ir-invalid-definition-node-id'),
    sourceEntityId: input.sourceEntityId == null ? null : nonEmpty(input.sourceEntityId, 'semantic-ir-invalid-source-entity-id'),
    variableKey: input.variableKey == null ? null : nonEmpty(input.variableKey, 'semantic-ir-invalid-variable-key'),
    origin: requiredOrigin(input, 'semantic-ir-value-origin-required'),
  };
  if (kind === 'definition' && out.definitionNodeId == null) fail('semantic-ir-definition-node-required');
  if (kind !== 'definition' && out.definitionNodeId != null) fail('semantic-ir-nondefinition-has-definition-node');
  if (input.metadata != null) out.metadata = serializable(input.metadata, 'semantic-ir-invalid-value-metadata');
  return deepFreeze(out);
}

function normalizeUnknown(input, kind) {
  if (input == null) {
    if (SEMANTIC_SETS.unknownOperations.has(kind)) fail('semantic-ir-unknown-detail-required');
    return null;
  }
  input = object(input, 'semantic-ir-invalid-unknown-detail');
  assertAllowedKeys(input, new Set(['reason', 'categories', 'missing', 'knownParts']), 'semantic-ir-unexpected-unknown-field');
  const out = {
    reason: nonEmpty(input.reason, 'semantic-ir-unknown-reason-required'),
    categories: sortedUniqueStrings(input.categories ?? [], 'semantic-ir-invalid-unknown-categories'),
  };
  if (kind === 'incomplete') {
    out.missing = sortedUniqueStrings(input.missing ?? [], 'semantic-ir-incomplete-missing-required');
    if (!out.missing.length) fail('semantic-ir-incomplete-missing-required');
  } else if (input.missing != null) {
    out.missing = sortedUniqueStrings(input.missing, 'semantic-ir-invalid-unknown-missing');
  }
  if (input.knownParts != null) out.knownParts = serializable(input.knownParts, 'semantic-ir-invalid-known-parts');
  return deepFreeze(out);
}

export function createSemanticNode(input) {
  input = object(input, 'semantic-ir-invalid-node');
  assertAllowedKeys(input, new Set([
    'id', 'kind', 'blockId', 'inputs', 'outputs', 'operator', 'variable', 'memory', 'call', 'intrinsic',
    'targets', 'attributes', 'unknown', 'completeness', 'sourceEffectIds', 'origin', 'metadata',
  ]), 'semantic-ir-unexpected-node-field');
  const kind = enumValue(input.kind, SEMANTIC_SETS.operations, 'semantic-ir-invalid-node-kind');
  const out = {
    id: nonEmpty(input.id, 'semantic-ir-node-id-required'),
    kind,
    blockId: nonEmpty(input.blockId, 'semantic-ir-node-block-required'),
    inputs: uniqueStrings(input.inputs ?? [], 'semantic-ir-invalid-node-inputs', false),
    outputs: uniqueStrings(input.outputs ?? [], 'semantic-ir-invalid-node-outputs', false),
    operator: input.operator == null ? null : nonEmpty(input.operator, 'semantic-ir-invalid-operator'),
    variable: input.variable == null ? null : createSemanticVariableRef(input.variable),
    memory: input.memory == null ? null : createSemanticMemoryAccess(input.memory),
    call: input.call == null ? null : createSemanticCallSummary(input.call),
    intrinsic: input.intrinsic == null ? null : createSemanticIntrinsicSummary(input.intrinsic),
    targets: uniqueStrings(input.targets ?? [], 'semantic-ir-invalid-node-targets', false),
    attributes: input.attributes == null ? {} : serializable(input.attributes, 'semantic-ir-invalid-node-attributes'),
    unknown: normalizeUnknown(input.unknown, kind),
    completeness: enumValue(input.completeness ?? (SEMANTIC_SETS.unknownOperations.has(kind) ? 'unknown' : 'complete'), SEMANTIC_SETS.completeness, 'semantic-ir-invalid-node-completeness'),
    sourceEffectIds: sortedUniqueStrings(input.sourceEffectIds ?? [], 'semantic-ir-invalid-source-effect-ids'),
    origin: requiredOrigin(input, 'semantic-ir-node-origin-required'),
  };

  if (MEMORY_NODE_KINDS.has(kind) && out.memory == null) fail('semantic-ir-memory-node-requires-access');
  if (!MEMORY_NODE_KINDS.has(kind) && out.memory != null && kind !== 'intrinsic') fail('semantic-ir-memory-access-not-allowed');
  if (VARIABLE_NODE_KINDS.has(kind) && out.variable == null) fail('semantic-ir-state-node-requires-variable');
  if (!VARIABLE_NODE_KINDS.has(kind) && out.variable != null && kind !== 'intrinsic') fail('semantic-ir-variable-not-allowed');
  if (kind === 'call' && out.call == null) fail('semantic-ir-call-summary-required');
  if (kind !== 'call' && out.call != null) fail('semantic-ir-call-summary-not-allowed');
  if (kind === 'intrinsic' && out.intrinsic == null) fail('semantic-ir-intrinsic-summary-required');
  if (kind !== 'intrinsic' && out.intrinsic != null) fail('semantic-ir-intrinsic-summary-not-allowed');
  if (kind === 'call' && out.call.completeness !== 'complete' && out.completeness === 'complete') {
    fail('semantic-ir-call-unknown-hidden-by-node');
  }
  if (kind === 'intrinsic'
    && (out.intrinsic.memoryRead.scope === 'unknown' || out.intrinsic.memoryWrite.scope === 'unknown' || out.intrinsic.determinism === 'unknown')
    && out.completeness === 'complete') {
    fail('semantic-ir-intrinsic-unknown-hidden-by-node');
  }
  if (CONTROL_NODE_KINDS.has(kind) && !out.targets.length) fail('semantic-ir-control-target-required');
  if (SEMANTIC_SETS.unknownOperations.has(kind) && out.unknown == null) fail('semantic-ir-unknown-detail-required');
  if (SEMANTIC_SETS.unknownOperations.has(kind) && out.completeness === 'complete') fail('semantic-ir-unknown-cannot-be-complete');
  if (!SEMANTIC_SETS.unknownOperations.has(kind) && out.completeness !== 'complete' && out.unknown == null) {
    fail('semantic-ir-partial-node-requires-unknown-detail');
  }
  if (input.metadata != null) out.metadata = serializable(input.metadata, 'semantic-ir-invalid-node-metadata');
  return deepFreeze(out);
}
