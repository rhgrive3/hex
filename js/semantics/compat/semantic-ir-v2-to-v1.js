import { validateSemanticIrFunction } from '../ir/index.js';
import { createSemanticSsaContract } from '../ssa/contract.js';
import { createMemorySsaContract } from '../memoryssa/contract.js';
import {
  V1_OP, V1_VK, V1_MK, firstAddress, blockOrder, explicitTargetsForBlock,
  graphFacts, buildLegacyValues,
} from './semantic-ir-v2-to-v1-core.js';
import { projectNode } from './semantic-ir-v2-to-v1-nodes.js';
import {
  attachMemorySsa, attachFallbackMemory, addScalarSsaPhis, appendFunctionUnknowns,
  assignInstructionIds, memorySafetySummary,
} from './semantic-ir-v2-to-v1-memory.js';

function rowForNode(node, fallback, options) {
  if (typeof options.rowOfNode === 'function') {
    const value = options.rowOfNode(node);
    if (Number.isSafeInteger(value)) return value;
  }
  return fallback;
}

/**
 * Semantic IR v2 -> legacy Semantic IR v1 compatibility projection.
 *
 * This module consumes only canonical Semantic IR/SSA/MemorySSA contracts. It
 * does not decode instructions, inspect mnemonic text, or invoke a legacy
 * architecture lifter. The v1 vocabulary is only the compatibility target.
 */
export function projectSemanticIrV2ToLegacyV1(input, options = {}) {
  const ir = validateSemanticIrFunction(input, options.validationOptions || {});
  const ssaInput = options.ssa ?? options.semanticSsa ?? null;
  const ssa = ssaInput == null ? null : createSemanticSsaContract(ssaInput, options.ssaValidationOptions || {});
  const memorySsaInput = options.memorySsa ?? null;
  const memorySsa = memorySsaInput == null ? null : createMemorySsaContract(memorySsaInput, options.memorySsaValidationOptions || {});
  if (ssa && ssa.functionId !== ir.functionId) throw new TypeError('semantic-v2-v1-compat-ssa-function-mismatch');
  if (memorySsa && memorySsa.functionId !== ir.functionId) throw new TypeError('semantic-v2-v1-compat-memoryssa-function-mismatch');

  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const orderedBlocks = blockOrder(ir);
  const blockIndexById = new Map(orderedBlocks.map((block, index) => [block.id, index]));
  const legacyBlocks = orderedBlocks.map((block, index) => ({
    index,
    semanticBlockId: block.id,
    semanticNodeIds: block.nodeIds.slice(),
    startRow: index,
    endRow: index,
    succ: explicitTargetsForBlock(block, nodeById).map((target) => blockIndexById.get(target)).filter((value) => value != null),
    pred: [],
    idom: -1,
    insts: [],
    phis: [],
    memPhis: [],
    isEntry: block.id === ir.entryBlockId,
    isExit: false,
    isLoopHeader: false,
    origin: block.origin ?? ir.origin,
  }));
  const blockBySemanticId = new Map(legacyBlocks.map((block) => [block.semanticBlockId, block]));
  const graph = graphFacts(legacyBlocks, blockIndexById, blockIndexById.get(ir.entryBlockId) ?? 0, ir.functionId);
  for (const block of legacyBlocks) block.isExit = block.succ.length === 0;

  const { values, byId: valuesById } = buildLegacyValues(ir, ssa);
  const projected = {
    name: options.name ?? ir.functionId,
    functionId: ir.functionId,
    startAddress: firstAddress(ir.origin),
    truncated: ir.completeness !== 'complete',
    values,
    instructions: [],
    blocks: legacyBlocks,
    entry: blockIndexById.get(ir.entryBlockId) ?? 0,
    locations: new Map(),
    byRow: new Map(),
    args: new Map(),
    reachable: graph.reachable,
    loops: graph.loops,
    idom: graph.idom,
    dominators: graph.dominators,
    stackSlots: [],
    origin: ir.origin,
    semanticIrVersion: ir.contractVersion,
    compat: {
      projection: 'semantic-ir-v2-to-v1',
      version: '1.0.0',
      semanticFunctionId: ir.functionId,
      scalarSsa: !!ssa,
      memorySsa: !!memorySsa,
      semanticNodeToLegacyInstructionIds: {},
      semanticValueToLegacyValueId: Object.fromEntries(ir.values
        .map((value) => [value.id, valuesById.get(value.id)?.id])
        .filter(([, id]) => id != null)),
      ssaValueToLegacyValueId: Object.fromEntries((ssa?.definitions ?? [])
        .map((definition) => [definition.valueId, valuesById.get(definition.valueId)?.id])
        .filter(([, id]) => id != null)),
      origins: {
        function: ir.origin,
        nodes: Object.fromEntries(ir.nodes.map((node) => [node.id, node.origin])),
        values: Object.fromEntries(ir.values.map((value) => [value.id, value.origin])),
        ssaDefinitions: Object.fromEntries((ssa?.definitions ?? []).map((definition) => [definition.definitionId, definition.origin])),
        functionUnknowns: ir.unknowns.map(() => ir.origin),
      },
    },
  };

  for (const value of values) if (value.kind === V1_VK.ARG && value.reg) projected.args.set(value.reg, value);

  const instructionBySemanticId = new Map();
  let fallbackRow = 0;
  for (const block of legacyBlocks) {
    let firstRow = null;
    let lastRow = null;
    for (const nodeId of block.semanticNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const row = rowForNode(node, fallbackRow++, options);
      const instructions = projectNode(node, {
        blockIndex: block.index, row, valuesById, ir, nodeById, blockBySemanticId, options,
      });
      const primary = instructions[0];
      instructionBySemanticId.set(node.id, primary);
      projected.instructions.push(...instructions);
      block.insts.push(...instructions);
      firstRow = firstRow == null ? row : Math.min(firstRow, row);
      lastRow = lastRow == null ? row : Math.max(lastRow, row);
    }
    block.startRow = firstRow ?? block.index;
    block.endRow = lastRow ?? block.startRow;
  }

  addScalarSsaPhis(projected, ssa, valuesById, blockIndexById, instructionBySemanticId);
  appendFunctionUnknowns(projected, ir);

  if (memorySsa) attachMemorySsa(projected, memorySsa, valuesById, instructionBySemanticId, blockIndexById);
  else attachFallbackMemory(projected);

  // Call/intrinsic/unknown memory effects must remain visible even without an
  // exact region mapping. They get an explicit unknown memory kill marker.
  for (const inst of projected.instructions) {
    const mustClobberMemory = inst.memoryBarrier === true
      || (inst.op === V1_OP.CALL && inst.extra?.memoryWrite?.scope !== 'none')
      || (inst.op === V1_OP.UNKNOWN && inst.extra?.unknownCategories?.includes('memory'));
    if (!mustClobberMemory || inst.memKills?.length) continue;
    const loc = { key: `unknown-barrier:${inst.semanticNodeId ?? inst.id}`, kind: V1_MK.UNKNOWN, size: null };
    projected.locations.set(loc.key, loc);
    inst.memKills = [loc];
  }

  assignInstructionIds(projected);
  for (const inst of projected.instructions) {
    const semanticId = inst.sourceEntityId ?? inst.semanticNodeId;
    if (!semanticId) continue;
    let list = projected.compat.semanticNodeToLegacyInstructionIds[semanticId];
    if (!list) list = projected.compat.semanticNodeToLegacyInstructionIds[semanticId] = [];
    list.push(inst.id);
  }
  projected.memorySafety = memorySafetySummary(projected);
  projected.defUse = () => projected.values;
  return projected;
}

export const SEMANTIC_IR_V2_V1_COMPAT = Object.freeze({
  contractVersion: '1.0.0',
  legacyOps: V1_OP,
  legacyValueKinds: V1_VK,
  legacyMemoryKinds: V1_MK,
});
