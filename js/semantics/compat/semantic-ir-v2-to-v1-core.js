import { analyzeSemanticDominance, createSemanticCfg } from '../cfg/index.js';

/** Internal architecture-neutral helpers for the Semantic IR v2 -> v1 projection. */

export const V1_OP = Object.freeze({
  CONST: 'const', MOV: 'mov', BIN: 'bin', UN: 'un', MAC: 'mac', BFX: 'bfx', BFI: 'bfi',
  CMP: 'cmp', SEL: 'sel', LOAD: 'load', STORE: 'store', ADDR: 'addr', CALL: 'call',
  RET: 'ret', BR: 'br', CBR: 'cbr', PHI: 'phi', CLOBBER: 'clobber', UNKNOWN: 'unknown',
});
export const V1_VK = Object.freeze({ ARG: 'arg', CONST: 'const', DEF: 'def', PHI: 'phi', UNDEF: 'undef' });
export const V1_MK = Object.freeze({ STACK: 'stack', FIELD: 'field', GLOBAL: 'global', UNKNOWN: 'unknown' });

const CONTROL_KINDS = new Set(['branch', 'conditional-branch', 'switch', 'return', 'trap', 'unknown-control-effect']);

export function safeBigInt(value) {
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); } catch { return null; }
}
function machineWidth(type) {
  if (!type || typeof type !== 'object') return 64;
  if (type.kind === 'vector') return Math.max(1, Number(type.laneCount || 1)) * machineWidth(type.elementType);
  return Math.max(1, Number(type.widthBits || 64) || 64);
}
export function firstAddress(origin) {
  const value = origin?.virtualRanges?.[0]?.start;
  return safeBigInt(value);
}
export function sourceInstructionIds(origin) {
  return Array.isArray(origin?.instructionIds) ? origin.instructionIds.slice() : [];
}
export function unique(values) { return [...new Set(values.filter((value) => value != null))]; }
export function asArray(value) { return Array.isArray(value) ? value : []; }
export function bytesForBits(bits) { return Math.max(1, Math.ceil(Number(bits || 8) / 8)); }
function unknownCategories(node, fallback = ['other']) {
  const categories = node?.unknown?.categories;
  return unique((categories?.length ? categories : fallback).map(String)).sort();
}
function addressForNode(node, options) {
  if (typeof options.addressOfNode === 'function') {
    const value = options.addressOfNode(node);
    if (value != null) return safeBigInt(value) ?? value;
  }
  return firstAddress(node.origin);
}
function textForNode(node, options) {
  if (typeof options.textOfNode === 'function') {
    const value = options.textOfNode(node);
    if (value != null) return String(value);
  }
  return `semantic-v2 ${node.kind}`;
}

function normalizeAbiResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const callArguments = Array.isArray(raw.callArguments) ? raw.callArguments
    : Array.isArray(raw.arguments) ? raw.arguments : null;
  return {
    callArguments,
    stackArguments: Array.isArray(raw.stackArguments) ? raw.stackArguments : null,
    stackArgsUnknown: raw.stackArgsUnknown == null ? callArguments == null : !!raw.stackArgsUnknown,
    stackArgsMayContainPointers: raw.stackArgsMayContainPointers == null ? true : !!raw.stackArgsMayContainPointers,
    argumentEvidence: raw.argumentEvidence == null ? 'injected-abi-adapter' : String(raw.argumentEvidence),
    clobbers: unique(asArray(raw.clobbers).map(String)),
    returnReg: raw.returnReg == null ? null : String(raw.returnReg),
    returnBits: raw.returnBits == null ? null : Number(raw.returnBits),
    returnEvidence: raw.returnEvidence ?? null,
  };
}

export function classifyCallWithAbi(node, ir, legacyValues, options) {
  const adapter = options.abiAdapter ?? options.abi ?? null;
  if (!adapter) return {
    callArguments: null,
    stackArguments: null,
    stackArgsUnknown: true,
    stackArgsMayContainPointers: true,
    argumentEvidence: 'semantic-ir-v2-no-abi-adapter',
    clobbers: asArray(node.call?.stateWrites).map((state) => state.key).filter(Boolean),
    returnReg: null,
    returnBits: null,
    returnEvidence: null,
    adapterStatus: 'absent',
  };
  try {
    const raw = typeof adapter === 'function'
      ? adapter({ node, call: node.call, semanticIr: ir, legacyValues })
      : typeof adapter.classifyCall === 'function'
        ? adapter.classifyCall({ node, call: node.call, semanticIr: ir, legacyValues })
        : null;
    const normalized = normalizeAbiResult(raw);
    if (normalized) return { ...normalized, adapterStatus: 'used' };
  } catch {
    // Adapter failure must degrade to the same conservative no-ABI behavior.
  }
  return {
    callArguments: null,
    stackArguments: null,
    stackArgsUnknown: true,
    stackArgsMayContainPointers: true,
    argumentEvidence: 'semantic-ir-v2-abi-adapter-unavailable',
    clobbers: asArray(node.call?.stateWrites).map((state) => state.key).filter(Boolean),
    returnReg: null,
    returnBits: null,
    returnEvidence: null,
    adapterStatus: 'failed-or-unsupported',
  };
}

export function blockOrder(ir) {
  const entry = ir.blocks.find((block) => block.id === ir.entryBlockId);
  const rest = ir.blocks.filter((block) => block.id !== ir.entryBlockId).slice().sort((a, b) => a.id.localeCompare(b.id));
  return entry ? [entry, ...rest] : rest;
}

export function explicitTargetsForBlock(block, nodeById) {
  const out = [];
  for (const nodeId of block.nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node || !CONTROL_KINDS.has(node.kind)) continue;
    for (const target of node.targets || []) out.push(target);
  }
  return unique(out).sort();
}

/**
 * Project canonical Semantic CFG/dominance facts into the integer-indexed v1
 * shape. This intentionally delegates graph analysis to the canonical Phase 3
 * CFG implementation; compatibility code must not maintain a second
 * dominance algorithm.
 */
export function graphFacts(blocks, blockIndex, entryIndex, functionId = 'semantic-v2-v1-compat') {
  const semanticIdByIndex = new Map(blocks.map((block) => [block.index, block.semanticBlockId]));
  const entryBlockId = semanticIdByIndex.get(entryIndex);
  if (entryBlockId == null) throw new TypeError('semantic-v2-v1-compat-entry-block-required');
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId,
    blocks: blocks.map((block) => ({
      id: block.semanticBlockId,
      successors: block.succ
        .map((targetIndex) => semanticIdByIndex.get(targetIndex))
        .filter((target) => target != null)
        .map((to) => ({ to, kind: 'branch' })),
    })),
  });
  const dominance = analyzeSemanticDominance(cfg);
  const cfgById = new Map(cfg.blocks.map((block) => [block.id, block]));

  for (const block of blocks) {
    const cfgBlock = cfgById.get(block.semanticBlockId);
    block.pred = (cfgBlock?.predecessors ?? [])
      .map((id) => blockIndex.get(id))
      .filter((index) => index != null)
      .sort((a, b) => a - b);
  }

  const reachable = new Set(dominance.reachable
    .map((id) => blockIndex.get(id))
    .filter((index) => index != null));
  const dominators = blocks.map((block) => new Set(
    (dominance.dominators[block.semanticBlockId] ?? [])
      .map((id) => blockIndex.get(id))
      .filter((index) => index != null),
  ));
  const idom = blocks.map((block) => {
    const parent = dominance.immediateDominators[block.semanticBlockId];
    return parent == null ? -1 : (blockIndex.get(parent) ?? -1);
  });
  for (const block of blocks) block.idom = idom[block.index] ?? -1;
  return { reachable, dominators, idom, loops: [], blockIndex };
}

function variableVersions(ir, ssa) {
  const map = new Map();
  if (ssa) {
    const groups = new Map();
    for (const definition of ssa.definitions) {
      if (!definition.variableKey) continue;
      let list = groups.get(definition.variableKey);
      if (!list) { list = []; groups.set(definition.variableKey, list); }
      list.push(definition);
    }
    for (const [key, definitions] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const entries = definitions.filter((definition) => definition.kind === 'entry').sort((a, b) => a.valueId.localeCompare(b.valueId));
      const others = definitions.filter((definition) => definition.kind !== 'entry').sort((a, b) => a.definitionId.localeCompare(b.definitionId));
      for (const definition of entries) map.set(definition.valueId, { reg: key, version: 0 });
      others.forEach((definition, index) => map.set(definition.valueId, { reg: key, version: index + 1 }));
    }
  }
  const fallbackGroups = new Map();
  for (const value of ir.values) {
    if (map.has(value.id) || !value.variableKey) continue;
    let list = fallbackGroups.get(value.variableKey);
    if (!list) { list = []; fallbackGroups.set(value.variableKey, list); }
    list.push(value);
  }
  for (const [key, values] of [...fallbackGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    values.sort((a, b) => a.id.localeCompare(b.id));
    let version = 0;
    for (const value of values) map.set(value.id, { reg: key, version: value.kind === 'entry' ? 0 : ++version });
  }
  return map;
}

function legacyKind(semanticKind, ssaKind = null) {
  if (ssaKind === 'phi') return V1_VK.PHI;
  if (ssaKind === 'entry' || semanticKind === 'entry') return V1_VK.ARG;
  if (ssaKind === 'undef' || ssaKind === 'unknown' || semanticKind === 'undef' || semanticKind === 'unknown') return V1_VK.UNDEF;
  if (semanticKind === 'const') return V1_VK.CONST;
  return V1_VK.DEF;
}

function canonicalScalarDefinitionBySemanticValue(ssa) {
  const map = new Map();
  for (const definition of ssa?.definitions ?? []) {
    const sourceSemanticValueId = definition.proof?.sourceSemanticValueId ?? null;
    if (sourceSemanticValueId == null) continue;
    const isScalarSemanticDefinition = definition.variableKey == null
      && (definition.proof?.kind === 'semantic-value-definition' || definition.sourceEntityId === sourceSemanticValueId);
    if (isScalarSemanticDefinition && !map.has(sourceSemanticValueId)) map.set(sourceSemanticValueId, definition);
  }
  return map;
}

export function buildLegacyValues(ir, ssa) {
  const ssaByValue = new Map(ssa?.definitions?.map((definition) => [definition.valueId, definition]) || []);
  const scalarBySemanticValue = canonicalScalarDefinitionBySemanticValue(ssa);
  const semanticById = new Map(ir.values.map((value) => [value.id, value]));
  const versions = variableVersions(ir, ssa);
  const values = [];
  const byId = new Map();

  const pushValue = (value) => {
    value.id = values.length;
    value.vid = values.length + 1;
    values.push(value);
    return value;
  };

  // Preserve the v1 node operand vocabulary: every Semantic IR value has one
  // legacy value. When generic SSA created a canonical ValueId for that exact
  // scalar value, alias that canonical ID to the same legacy value.
  for (const semanticValue of ir.values) {
    const directDefinition = ssaByValue.get(semanticValue.id) ?? scalarBySemanticValue.get(semanticValue.id) ?? null;
    const version = versions.get(semanticValue.id) || {};
    const value = pushValue({
      kind: legacyKind(semanticValue.kind, directDefinition?.kind ?? null),
      reg: version.reg ?? semanticValue.variableKey ?? null,
      version: version.version ?? 0,
      bits: machineWidth(semanticValue.machineType),
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: version.reg ?? semanticValue.variableKey ?? semanticValue.sourceEntityId ?? null,
      semanticValueId: semanticValue.id,
      semanticSsaValueId: directDefinition?.valueId ?? null,
      sourceEntityId: semanticValue.sourceEntityId,
      machineType: semanticValue.machineType,
      origin: semanticValue.origin,
    });
    if (semanticValue.kind === 'unknown' || directDefinition?.kind === 'unknown') value.unknown = true;
    if (semanticValue.kind === 'undef' || directDefinition?.kind === 'undef') value.undefined = true;
    byId.set(semanticValue.id, value);
    if (directDefinition && directDefinition.variableKey == null) byId.set(directDefinition.valueId, value);
  }

  // Generic SSA also creates state-version ValueIds (entry/def/phi/unknown)
  // that do not exist as raw Semantic IR values. Project those explicitly so
  // phi incoming edges and use/def links use the canonical ValueId identity.
  for (const definition of ssa?.definitions ?? []) {
    if (byId.has(definition.valueId)) continue;
    const sourceSemanticValueId = definition.proof?.sourceSemanticValueId ?? null;
    const sourceSemanticValue = sourceSemanticValueId == null ? null : semanticById.get(sourceSemanticValueId) ?? null;
    const version = versions.get(definition.valueId) || {};
    const machineType = definition.proof?.machineType ?? sourceSemanticValue?.machineType ?? null;
    const value = pushValue({
      kind: legacyKind(sourceSemanticValue?.kind ?? null, definition.kind),
      reg: version.reg ?? definition.variableKey ?? sourceSemanticValue?.variableKey ?? null,
      version: version.version ?? 0,
      bits: machineWidth(machineType),
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: version.reg ?? definition.variableKey ?? sourceSemanticValue?.sourceEntityId ?? definition.sourceEntityId ?? null,
      semanticValueId: null,
      semanticSsaValueId: definition.valueId,
      sourceSemanticValueId,
      sourceEntityId: definition.sourceEntityId,
      machineType,
      origin: definition.origin,
    });
    if (definition.kind === 'unknown') value.unknown = true;
    if (definition.kind === 'undef') value.undefined = true;
    byId.set(definition.valueId, value);
  }

  return { values, byId, ssaByValue };
}

export function makeArg(value) { return value ? { value, bits: value.bits || 64 } : null; }
export function addUse(value, inst) {
  if (!value || !inst || value.uses.includes(inst)) return;
  value.uses.push(inst);
}
export function attachArgs(inst, values) {
  inst.args = values.filter(Boolean).map(makeArg);
  for (const value of values) addUse(value, inst);
}

export function defaultUnknownInstruction(node, block, row, options, fields = {}) {
  return {
    op: V1_OP.UNKNOWN,
    sub: null,
    block,
    row,
    address: addressForNode(node, options),
    text: textForNode(node, options),
    args: [],
    dst: null,
    extra: {
      reason: node.unknown?.reason ?? `semantic-ir-v2-${node.kind}-not-representable-in-v1`,
      unknownCategories: unknownCategories(node),
      semanticNodeId: node.id,
      ...fields,
    },
  };
}

export function baseInstruction(node, block, row, options) {
  const ids = sourceInstructionIds(node.origin);
  return {
    op: null,
    sub: null,
    block,
    row,
    address: addressForNode(node, options),
    text: textForNode(node, options),
    args: [],
    dst: null,
    extra: null,
    semanticNodeId: node.id,
    sourceEntityId: node.id,
    sourceEffectIds: node.sourceEffectIds.slice(),
    instructionId: ids[0] ?? null,
    sourceInstructionIds: ids,
    origin: node.origin,
  };
}

export function targetAddress(targetBlockId, blockBySemanticId, nodeById, options) {
  const block = blockBySemanticId.get(targetBlockId);
  if (!block) return null;
  for (const nodeId of block.semanticNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const address = addressForNode(node, options);
    if (address != null) return address;
  }
  return null;
}
