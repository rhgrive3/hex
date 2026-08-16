import {
  V1_OP, V1_VK, V1_MK, safeBigInt, bytesForBits, firstAddress,
  sourceInstructionIds, unique, asArray, makeArg, addUse, legacyPublicStateIdentity,
} from './semantic-ir-v2-to-v1-core.js';

const MEMORY_CLOBBER_KINDS = new Set(['may-alias-clobber', 'unknown-clobber', 'call-clobber', 'intrinsic-clobber']);

function legacyLocation(region, valuesById) {
  const size = region.widthBits == null ? null : bytesForBits(region.widthBits);
  if (region.kind === 'stack-fixed') {
    const disp = safeBigInt(region.offset) ?? 0n;
    return { key: `stack:${disp.toString()}`, kind: V1_MK.STACK, disp, size, regionId: region.id, origin: region.origin ?? null };
  }
  if (region.kind === 'global-absolute') {
    const address = safeBigInt(region.address);
    if (address != null) return { key: `global:${address.toString(16)}`, kind: V1_MK.GLOBAL, address, size, regionId: region.id, origin: region.origin ?? null };
  }
  if (region.kind === 'rooted-offset') {
    const disp = safeBigInt(region.offset) ?? 0n;
    const base = valuesById.get(region.rootEntityId) ?? null;
    return { key: `field:${region.rootEntityId}+${disp.toString()}`, kind: V1_MK.FIELD, base, baseEntityId: region.rootEntityId, disp, size, regionId: region.id, origin: region.origin ?? null };
  }
  return { key: `unknown:${region.id}`, kind: V1_MK.UNKNOWN, size, regionId: region.id, uncertaintyIdentity: region.uncertaintyIdentity ?? region.rootIdentity ?? region.addressSpace ?? region.id, origin: region.origin ?? null };
}

function fallbackLocation(inst) {
  if (!inst?.addr) return { key: 'unknown', kind: V1_MK.UNKNOWN, size: inst?.extra?.size ?? null };
  const base = inst.addr.base;
  if (base?.const != null && inst.addr.index == null) {
    const address = base.const + (inst.addr.disp ?? 0n);
    return { key: `global:${address.toString(16)}`, kind: V1_MK.GLOBAL, address, size: inst.addr.size ?? null };
  }
  return { key: `unknown:${inst.semanticNodeId ?? inst.id ?? 'memory'}`, kind: V1_MK.UNKNOWN, size: inst.addr.size ?? null };
}

export function attachMemorySsa(projected, memorySsa, valuesById, instructionBySemanticId, blockIndexById) {
  const locationByRegion = new Map();
  for (const region of memorySsa.regions) {
    const loc = legacyLocation(region, valuesById);
    locationByRegion.set(region.id, loc);
    projected.locations.set(loc.key, loc);
  }

  const memoryNodeById = new Map();
  for (const definition of memorySsa.definitions) {
    const loc = locationByRegion.get(definition.regionId);
    const inst = definition.sourceEntityId == null ? null : instructionBySemanticId.get(definition.sourceEntityId) ?? null;
    let kind = 'clobber';
    if (definition.kind === 'entry') kind = 'entry';
    else if (definition.kind === 'memory-def') kind = 'store';
    else if (definition.kind === 'memory-phi') kind = 'phi';
    const memoryNode = {
      kind,
      key: loc?.key ?? `unknown:${definition.regionId}`,
      definitionId: definition.id,
      regionId: definition.regionId,
      block: definition.blockId == null ? null : blockIndexById.get(definition.blockId) ?? null,
      inst,
      prev: null,
      incoming: [],
      reason: MEMORY_CLOBBER_KINDS.has(definition.kind) ? definition.kind : null,
      unknownAlias: definition.kind === 'unknown-clobber' || definition.aliasRelation === 'unknown' || definition.kind === 'may-alias-clobber',
      aliasRelation: definition.aliasRelation,
      effectSummary: definition.effectSummary ?? null,
      proof: definition.proof ?? null,
      origin: definition.origin,
    };
    memoryNodeById.set(definition.id, memoryNode);
  }

  const definitionById = new Map(memorySsa.definitions.map((definition) => [definition.id, definition]));
  for (const definition of memorySsa.definitions) {
    const memoryNode = memoryNodeById.get(definition.id);
    if (definition.previousDefinitionIds.length) {
      const previous = definition.previousDefinitionIds.map((id) => memoryNodeById.get(id)).filter(Boolean);
      memoryNode.previous = previous;
      memoryNode.prev = previous.length === 1 ? previous[0] : null;
    }
    if (definition.kind === 'memory-phi') {
      memoryNode.incoming = definition.incoming.map((item) => ({
        from: blockIndexById.get(item.predecessorBlockId) ?? null,
        semanticPredecessorBlockId: item.predecessorBlockId,
        node: memoryNodeById.get(item.definitionId) ?? null,
      }));
      const block = projected.blocks[memoryNode.block];
      if (block) block.memPhis.push(memoryNode);
    }
    const source = definition.sourceEntityId == null ? null : instructionBySemanticId.get(definition.sourceEntityId);
    if (!source) continue;
    if (definition.kind === 'memory-def' && source.op === V1_OP.STORE) {
      const loc = locationByRegion.get(definition.regionId);
      if (loc) source.loc = loc;
      if (!source.memDefs) source.memDefs = [];
      source.memDefs.push(memoryNode);
      if (!source.memDef) source.memDef = memoryNode;
    } else if (MEMORY_CLOBBER_KINDS.has(definition.kind)) {
      if (!source.memKills) source.memKills = [];
      const loc = locationByRegion.get(definition.regionId);
      if (loc && !source.memKills.includes(loc)) source.memKills.push(loc);
      source.memoryBarrier = true;
    }
  }

  for (const use of memorySsa.uses) {
    const source = instructionBySemanticId.get(use.sourceEntityId);
    if (!source) continue;
    const loc = locationByRegion.get(use.regionId);
    if (loc && (source.op === V1_OP.LOAD || source.op === V1_OP.STORE)) source.loc = loc;
    const reaching = memoryNodeById.get(use.reachingDefinitionId) ?? null;
    source.memUse = reaching;
    source.memoryAliasRelation = use.aliasRelation;
    source.reachingStore = null;
    if (source.op === V1_OP.LOAD && use.aliasRelation === 'must' && reaching?.kind === 'store' && reaching.inst?.op === V1_OP.STORE) {
      source.reachingStore = reaching.inst;
    } else if (source.op === V1_OP.LOAD && reaching?.kind === 'clobber') {
      source.unknownAliasBarrier = reaching.inst ?? null;
    }
  }

  for (const inst of projected.instructions) {
    if ((inst.op === V1_OP.LOAD || inst.op === V1_OP.STORE) && !inst.loc) {
      inst.loc = fallbackLocation(inst);
      projected.locations.set(inst.loc.key, inst.loc);
    }
  }

  projected.compat.memoryDefinitionById = Object.fromEntries([...memoryNodeById.entries()].map(([id, node]) => [id, {
    kind: node.kind,
    regionId: node.regionId,
    sourceSemanticNodeId: node.inst?.sourceEntityId ?? null,
    previousDefinitionIds: definitionById.get(id)?.previousDefinitionIds?.slice() ?? [],
  }]));
}

export function attachFallbackMemory(projected) {
  for (const inst of projected.instructions) {
    if (inst.op !== V1_OP.LOAD && inst.op !== V1_OP.STORE) continue;
    inst.loc = fallbackLocation(inst);
    projected.locations.set(inst.loc.key, inst.loc);
    inst.reachingStore = null;
  }
}

export function addScalarSsaPhis(projected, ssa, valuesById, blockIndexById, instructionBySemanticId) {
  if (!ssa) return;
  const phiDefinitions = ssa.definitions.filter((definition) => definition.kind === 'phi');
  for (const definition of phiDefinitions) {
    const value = valuesById.get(definition.valueId);
    if (!value) continue;
    const block = blockIndexById.get(definition.blockId);
    if (block == null) continue;
    const publicIdentity = legacyPublicStateIdentity(definition.proof?.variableIdentity) ?? value.reg ?? definition.variableKey;
    const inst = {
      id: -1,
      op: V1_OP.PHI,
      sub: null,
      block,
      row: projected.blocks[block]?.startRow ?? block,
      address: firstAddress(definition.origin),
      text: `phi ${publicIdentity ?? definition.valueId}`,
      args: [],
      dst: value,
      incoming: [],
      reg: publicIdentity,
      semanticSsaValueId: definition.valueId,
      semanticNodeId: definition.sourceEntityId,
      sourceEntityId: definition.sourceEntityId,
      sourceInstructionIds: sourceInstructionIds(definition.origin),
      instructionId: sourceInstructionIds(definition.origin)[0] ?? null,
      origin: definition.origin,
      extra: {
        semanticSsaDefinitionId: definition.definitionId,
        semanticVariableKey: definition.variableKey,
        publicStateIdentity: publicIdentity,
        proof: definition.proof ?? null,
      },
    };
    for (const incoming of definition.incoming) {
      const incomingValue = valuesById.get(incoming.valueId);
      if (!incomingValue) continue;
      inst.incoming.push({
        from: blockIndexById.get(incoming.predecessorBlockId) ?? null,
        semanticPredecessorBlockId: incoming.predecessorBlockId,
        semanticSsaValueId: incoming.valueId,
        value: incomingValue,
      });
      inst.args.push(makeArg(incomingValue));
      addUse(incomingValue, inst);
    }
    value.kind = V1_VK.PHI;
    value.reg = publicIdentity;
    value.def = inst;
    projected.blocks[block].phis.push(inst);
    projected.instructions.unshift(inst);
  }

  for (const definition of ssa.definitions) {
    if (definition.kind === 'phi') continue;
    const value = valuesById.get(definition.valueId);
    if (!value) continue;
    const source = definition.sourceEntityId == null ? null : instructionBySemanticId.get(definition.sourceEntityId);
    if (source && value.def == null) value.def = source;
  }
  for (const use of ssa.uses) {
    const value = valuesById.get(use.valueId);
    const source = instructionBySemanticId.get(use.sourceEntityId);
    if (value && source) addUse(value, source);
  }
}

export function appendFunctionUnknowns(projected, ir) {
  if (!ir.unknowns.length) return;
  const block = projected.blocks[projected.entry];
  if (!block) return;
  const instructionIds = sourceInstructionIds(ir.origin);
  const row = block.endRow;
  ir.unknowns.forEach((unknown, index) => {
    const categories = unique(asArray(unknown.categories).map(String)).sort();
    const semanticNodeId = `${ir.functionId}:function-unknown:${index}`;
    const inst = {
      id: -1,
      op: V1_OP.UNKNOWN,
      sub: null,
      block: block.index,
      row,
      address: firstAddress(ir.origin),
      text: `semantic-v2 function unknown: ${unknown.reason}`,
      args: [],
      dst: null,
      semanticNodeId,
      sourceEntityId: ir.functionId,
      sourceEffectIds: [],
      instructionId: instructionIds[0] ?? null,
      sourceInstructionIds: instructionIds.slice(),
      origin: ir.origin,
      extra: {
        semanticNodeId,
        reason: unknown.reason,
        unknownCategories: categories.length ? categories : ['other'],
        functionUnknown: true,
        detail: unknown.detail ?? null,
      },
    };
    if (categories.includes('memory')) inst.memoryBarrier = true;
    projected.instructions.push(inst);
    block.insts.push(inst);
  });
}

export function assignInstructionIds(projected) {
  projected.instructions.forEach((inst, index) => { inst.id = index; });
  projected.byRow.clear();
  for (const block of projected.blocks) block.insts = block.insts.filter((inst) => inst.op !== V1_OP.PHI);
  for (const inst of projected.instructions) {
    if (inst.op !== V1_OP.PHI) {
      const block = projected.blocks[inst.block];
      if (block && !block.insts.includes(inst)) block.insts.push(inst);
    }
    let list = projected.byRow.get(inst.row);
    if (!list) { list = []; projected.byRow.set(inst.row, list); }
    list.push(inst);
  }
}

export function memorySafetySummary(projected) {
  const unknownStores = projected.instructions.filter((inst) => inst.op === V1_OP.STORE && (!inst.loc || inst.loc.kind === V1_MK.UNKNOWN)).length;
  const blockedLoads = projected.instructions.filter((inst) => inst.op === V1_OP.LOAD && !inst.reachingStore && inst.memUse?.kind === 'clobber').length;
  return { unknownStores, blockedLoads };
}
