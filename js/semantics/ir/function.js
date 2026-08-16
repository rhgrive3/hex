import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';
import {
  SEMANTIC_IR_CONTRACT_VERSION,
  SEMANTIC_IR_SCHEMA_VERSION,
  SEMANTIC_SETS,
  array,
  assertAllowedKeys,
  assertNotAborted,
  assertWithinBudget,
  enumValue,
  fail,
  nonEmpty,
  object,
  requiredOrigin,
  serializable,
  sortedUniqueStrings,
  uniqueStrings,
} from './common.js';
import { createSemanticNode, createSemanticValue } from './nodes.js';

function normalizeBlock(input) {
  input = object(input, 'semantic-ir-invalid-block');
  assertAllowedKeys(input, new Set(['id', 'nodeIds', 'origin']), 'semantic-ir-unexpected-block-field');
  const out = {
    id: nonEmpty(input.id, 'semantic-ir-block-id-required'),
    nodeIds: uniqueStrings(input.nodeIds ?? [], 'semantic-ir-invalid-block-node-ids', false),
  };
  if (Object.hasOwn(input, 'origin')) out.origin = createOriginSet(input.origin);
  return deepFreeze(out);
}

function normalizeFunctionUnknown(input) {
  input = object(input, 'semantic-ir-invalid-function-unknown');
  assertAllowedKeys(input, new Set(['reason', 'categories', 'detail']), 'semantic-ir-unexpected-function-unknown-field');
  const out = {
    reason: nonEmpty(input.reason, 'semantic-ir-function-unknown-reason-required'),
    categories: sortedUniqueStrings(input.categories ?? [], 'semantic-ir-invalid-function-unknown-categories'),
  };
  if (input.detail != null) out.detail = serializable(input.detail, 'semantic-ir-invalid-function-unknown-detail');
  return out;
}

function assertVersion(input) {
  if (input.schemaVersion != null && Number(input.schemaVersion) !== SEMANTIC_IR_SCHEMA_VERSION) fail('semantic-ir-schema-version-mismatch');
  if (input.contractVersion != null && String(input.contractVersion) !== SEMANTIC_IR_CONTRACT_VERSION) fail('semantic-ir-contract-version-mismatch');
}

function countReferences(nodes, values, blocks) {
  let count = 0;
  for (const node of nodes) {
    count += node.inputs.length + node.outputs.length + node.targets.length + node.sourceEffectIds.length;
    if (node.memory) count++;
    if (node.call) count += node.call.targetValueIds.length + node.call.arguments.length + node.call.returns.length;
    if (node.intrinsic) count += node.intrinsic.inputs.length + node.intrinsic.outputs.length;
  }
  for (const block of blocks) count += block.nodeIds.length;
  for (const value of values) if (value.definitionNodeId) count++;
  return count;
}

function validateNormalizedFunction(out, options) {
  assertNotAborted(options);
  const blockById = new Map();
  for (const block of out.blocks) {
    if (blockById.has(block.id)) fail('semantic-ir-duplicate-block-id');
    blockById.set(block.id, block);
  }
  if (!blockById.has(out.entryBlockId)) fail('semantic-ir-invalid-entry-block');

  const valueById = new Map();
  for (const value of out.values) {
    assertNotAborted(options);
    if (valueById.has(value.id)) fail('semantic-ir-duplicate-value-id');
    valueById.set(value.id, value);
  }

  const nodeById = new Map();
  for (const node of out.nodes) {
    assertNotAborted(options);
    if (nodeById.has(node.id)) fail('semantic-ir-duplicate-entity-id');
    nodeById.set(node.id, node);
    if (!blockById.has(node.blockId)) fail('semantic-ir-node-invalid-block');
  }

  const placedNodes = new Set();
  for (const block of out.blocks) {
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) fail('semantic-ir-block-dangling-node');
      if (placedNodes.has(nodeId)) fail('semantic-ir-node-in-multiple-blocks');
      if (node.blockId !== block.id) fail('semantic-ir-node-block-mismatch');
      placedNodes.add(nodeId);
    }
  }
  if (placedNodes.size !== out.nodes.length) fail('semantic-ir-unplaced-node');

  for (const node of out.nodes) {
    for (const id of node.inputs) if (!valueById.has(id)) fail('semantic-ir-dangling-value-id');
    for (const id of node.outputs) {
      const value = valueById.get(id);
      if (!value) fail('semantic-ir-dangling-value-id');
      if (value.kind !== 'definition' || value.definitionNodeId !== node.id) fail('semantic-ir-output-definition-mismatch');
    }
    if (node.memory && !valueById.has(node.memory.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
    if (node.call) {
      for (const id of [...node.call.targetValueIds, ...node.call.arguments, ...node.call.returns]) {
        if (!valueById.has(id)) fail('semantic-ir-dangling-call-value-id');
      }
      for (const scope of [node.call.memoryRead, node.call.memoryWrite]) {
        for (const access of scope.accesses ?? []) {
          if (!valueById.has(access.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
        }
      }
    }
    if (node.intrinsic) {
      for (const id of [...node.intrinsic.inputs, ...node.intrinsic.outputs]) {
        if (!valueById.has(id)) fail('semantic-ir-dangling-intrinsic-value-id');
      }
      for (const scope of [node.intrinsic.memoryRead, node.intrinsic.memoryWrite]) {
        for (const access of scope.accesses ?? []) {
          if (!valueById.has(access.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
        }
      }
    }
    for (const target of node.targets) if (!blockById.has(target)) fail('semantic-ir-invalid-control-target');
  }

  for (const value of out.values) {
    if (value.definitionNodeId == null) continue;
    const node = nodeById.get(value.definitionNodeId);
    if (!node || !node.outputs.includes(value.id)) fail('semantic-ir-value-definition-mismatch');
  }

  const hasUnknownNode = out.nodes.some((node) => SEMANTIC_SETS.unknownOperations.has(node.kind) || node.completeness !== 'complete');
  if (out.completeness === 'complete' && (hasUnknownNode || out.unknowns.length)) fail('semantic-ir-completeness-conflict');
  if (out.completeness !== 'complete' && out.unknowns.length === 0) fail('semantic-ir-function-unknowns-required');
}

export function createSemanticIrFunction(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-ir-invalid-function');
  assertAllowedKeys(input, new Set([
    'schemaVersion', 'contractVersion', 'functionId', 'entryBlockId', 'blocks', 'values', 'nodes',
    'completeness', 'unknowns', 'origin',
  ]), 'semantic-ir-unexpected-function-field');
  assertVersion(input);
  const rawBlocks = array(input.blocks, 'semantic-ir-blocks-required');
  const rawValues = array(input.values, 'semantic-ir-values-required');
  const rawNodes = array(input.nodes, 'semantic-ir-nodes-required');
  assertWithinBudget(rawBlocks.length, options, 'maxBlocks');
  assertWithinBudget(rawValues.length, options, 'maxValues');
  assertWithinBudget(rawNodes.length, options, 'maxNodes');

  const out = {
    schemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
    contractVersion: SEMANTIC_IR_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-ir-function-id-required'),
    entryBlockId: nonEmpty(input.entryBlockId, 'semantic-ir-entry-block-required'),
    blocks: rawBlocks.map(normalizeBlock).sort((a, b) => a.id.localeCompare(b.id)),
    values: rawValues.map(createSemanticValue).sort((a, b) => a.id.localeCompare(b.id)),
    nodes: rawNodes.map(createSemanticNode).sort((a, b) => a.id.localeCompare(b.id)),
    completeness: enumValue(input.completeness ?? 'complete', SEMANTIC_SETS.completeness, 'semantic-ir-invalid-function-completeness'),
    unknowns: array(input.unknowns ?? [], 'semantic-ir-invalid-function-unknowns')
      .map(normalizeFunctionUnknown)
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    origin: requiredOrigin(input, 'semantic-ir-function-origin-required'),
  };
  assertWithinBudget(countReferences(out.nodes, out.values, out.blocks), options, 'maxReferences');
  validateNormalizedFunction(out, options);
  return deepFreeze(out);
}

export function validateSemanticIrFunction(input, options = {}) {
  return createSemanticIrFunction(input, options);
}

export function canonicalSerializeSemanticIr(input, options = {}) {
  return stableStringify(createSemanticIrFunction(input, options));
}
