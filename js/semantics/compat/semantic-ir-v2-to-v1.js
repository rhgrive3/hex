import { validateSemanticIrFunction } from '../ir/index.js';
import { createSemanticSsaContract } from '../ssa/contract.js';
import { createMemorySsaContract } from '../memoryssa/contract.js';
import {
  V1_OP, V1_VK, V1_MK, firstAddress, sourceInstructionIds, blockOrder, explicitTargetsForBlock,
  graphFacts, buildLegacyValues, buildStateProjectionIndex,
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

function semanticSsaContractInput(input) {
  return {
    contractVersion: input.contractVersion,
    functionId: input.functionId,
    definitions: input.definitions,
    uses: input.uses,
  };
}

function memorySsaContractInput(input) {
  return {
    contractVersion: input.contractVersion,
    functionId: input.functionId,
    regions: input.regions,
    definitions: input.definitions,
    uses: input.uses,
  };
}

function sameInstruction(node, instructionIds) {
  return sourceInstructionIds(node.origin).some((id) => instructionIds.has(id));
}

function addComparisonCarriers(ir, values, valuesById, producerByValueId) {
  const flagWriteInstructionIds = new Set();
  for (const node of ir.nodes) {
    if (node.kind !== 'state-write' || node.variable?.physicalIdentity?.kind !== 'flag') continue;
    for (const id of sourceInstructionIds(node.origin)) flagWriteInstructionIds.add(id);
  }

  const byNodeId = new Map();
  for (const node of ir.nodes) {
    if (node.kind === 'compare' && node.outputs[0]) {
      const value = valuesById.get(node.outputs[0]);
      if (value) byNodeId.set(node.id, value);
      continue;
    }
    const flagProducingArithmetic = sameInstruction(node, flagWriteInstructionIds)
      && ((node.kind === 'intrinsic' && node.operator === 'add-with-carry') || node.kind === 'binary');
    if (!flagProducingArithmetic) continue;
    const value = {
      id: values.length,
      vid: values.length + 1,
      kind: V1_VK.DEF,
      reg: null,
      stateKey: null,
      version: 0,
      bits: 1,
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: `comparison:${node.id}`,
      semanticValueId: null,
      semanticSsaValueId: null,
      sourceEntityId: node.id,
      machineType: { kind: 'predicate', widthBits: 1 },
      origin: node.origin,
      compatDerived: 'comparison-carrier',
    };
    values.push(value);
    byNodeId.set(node.id, value);
  }

  // Direct Semantic compare values already have a producer mapping. Keeping the
  // map argument here documents that carriers are tied to existing value graph
  // nodes rather than instruction text or decoder state.
  void producerByValueId;
  return byNodeId;
}

/**
 * Semantic IR v2 -> legacy Semantic IR v1 compatibility projection.
 *
 * This module consumes only canonical Semantic IR/SSA/MemorySSA/CFG contracts.
 * It does not decode instructions, inspect mnemonic text, or invoke a legacy
 * architecture lifter. The v1 vocabulary is only the compatibility target.
 */
export function projectSemanticIrV2ToLegacyV1(input, options = {}) {
  const ir = validateSemanticIrFunction(input, options.validationOptions || {});
  const ssaInput = options.ssa ?? options.semanticSsa ?? null;
  const ssa = ssaInput == null ? null : createSemanticSsaContract(
    semanticSsaContractInput(ssaInput), options.ssaValidationOptions || {},
  );
  const memorySsaInput = options.memorySsa ?? null;
  const memorySsa = memorySsaInput == null ? null : createMemorySsaContract(
    memorySsaContractInput(memorySsaInput), options.memorySsaValidationOptions || {},
  );
  const canonicalCfg = options.cfg ?? options.semanticCfg ?? null;
  if (ssa && ssa.functionId !== ir.functionId) throw new TypeError('semantic-v2-v1-compat-ssa-function-mismatch');
  if (memorySsa && memorySsa.functionId !== ir.functionId) throw new TypeError('semantic-v2-v1-compat-memoryssa-function-mismatch');

  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const semanticValueById = new Map(ir.values.map((value) => [value.id, value]));
  const producerByValueId = new Map();
  for (const node of ir.nodes) for (const valueId of node.outputs || []) producerByValueId.set(valueId, node);
  const orderedBlocks = blockOrder(ir);
  const blockIndexById = new Map(orderedBlocks.map((block, index) => [block.id, index]));
  const legacyBlocks = orderedBlocks.map((block, index) => ({
    index,
    semanticBlockId: block.id,
    semanticNodeIds: block.nodeIds.slice(),
    startRow: index,
    endRow: index,
    succ: explicitTargetsForBlock(block, nodeById).map((target) => blockIndexById.get(target)).filter((value) => value != null),
    successorEdges: [],
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
  const graph = graphFacts(
    legacyBlocks,
    blockIndexById,
    blockIndexById.get(ir.entryBlockId) ?? 0,
    ir.functionId,
    canonicalCfg,
  );
  for (const block of legacyBlocks) block.isExit = block.succ.length === 0;

  const { values, byId: valuesById } = buildLegacyValues(ir, ssa);
  const stateProjection = buildStateProjectionIndex(ssa);
  const comparisonCarrierByNodeId = addComparisonCarriers(ir, values, valuesById, producerByValueId);
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
    backEdges: graph.backEdges,
    idom: graph.idom,
    dominators: graph.dominators,
    stackSlots: [],
    origin: ir.origin,
    semanticIrVersion: ir.contractVersion,
    compat: {
      projection: 'semantic-ir-v2-to-v1',
      version: '1.1.0',
      semanticFunctionId: ir.functionId,
      scalarSsa: !!ssa,
      memorySsa: !!memorySsa,
      canonicalCfg: canonicalCfg != null,
      semanticNodeToLegacyInstructionIds: {},
      semanticValueToLegacyValueId: Object.fromEntries(ir.values
        .map((value) => [value.id, valuesById.get(value.id)?.id])
        .filter(([, id]) => id != null)),
      ssaValueToLegacyValueId: Object.fromEntries((ssa?.definitions ?? [])
        .map((definition) => [definition.valueId, valuesById.get(definition.valueId)?.id])
        .filter(([, id]) => id != null)),
      derivedComparisonCarriers: Object.fromEntries([...comparisonCarrierByNodeId.entries()].map(([nodeId, value]) => [nodeId, value.id])),
      controlEdges: graph.edges,
      origins: {
        function: ir.origin,
        blocks: Object.fromEntries(ir.blocks.map((block) => [block.id, block.origin ?? ir.origin])),
        nodes: Object.fromEntries(ir.nodes.map((node) => [node.id, node.origin])),
        values: Object.fromEntries(ir.values.map((value) => [value.id, value.origin])),
        ssaDefinitions: Object.fromEntries((ssa?.definitions ?? []).map((definition) => [definition.definitionId, definition.origin])),
        ssaUses: Object.fromEntries((ssa?.uses ?? []).map((use) => [use.useId, use.origin])),
        functionUnknowns: ir.unknowns.map(() => ir.origin),
      },
    },
  };

  for (const value of values) if (value.kind === V1_VK.ARG && value.reg && !projected.args.has(value.reg)) projected.args.set(value.reg, value);

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
        blockIndex: block.index,
        row,
        valuesById,
        ir,
        ssa,
        nodeById,
        semanticValueById,
        producerByValueId,
        stateProjection,
        comparisonCarrierByNodeId,
        blockBySemanticId,
        options,
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
  contractVersion: '1.1.0',
  legacyOps: V1_OP,
  legacyValueKinds: V1_VK,
  legacyMemoryKinds: V1_MK,
});
