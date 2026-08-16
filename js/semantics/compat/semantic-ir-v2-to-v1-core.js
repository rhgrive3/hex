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
function rowForNode(node, fallback, options) {
  if (typeof options.rowOfNode === 'function') {
    const value = options.rowOfNode(node);
    if (Number.isSafeInteger(value)) return value;
  }
  return fallback;
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
function constantPayload(node) {
  const attrs = node?.attributes || {};
  const metadata = node?.metadata || {};
  const raw = attrs.value ?? attrs.constant ?? attrs.address ?? metadata.value ?? metadata.constant ?? metadata.address;
  if (raw == null) return { value: null, float: null, constKind: null };
  const integer = safeBigInt(raw);
  if (integer != null) return { value: integer, float: null, constKind: attrs.constKind ?? metadata.constKind ?? null };
  const number = Number(raw);
  if (Number.isFinite(number)) return { value: null, float: number, constKind: attrs.constKind ?? metadata.constKind ?? 'float' };
  return { value: null, float: null, constKind: null };
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

export function graphFacts(blocks, blockIndex, entryIndex) {
  const pred = blocks.map(() => []);
  for (const block of blocks) {
    for (const target of block.succ) if (pred[target]) pred[target].push(block.index);
  }
  for (const list of pred) list.sort((a, b) => a - b);
  for (const block of blocks) block.pred = pred[block.index];

  const reachable = new Set();
  const work = entryIndex >= 0 ? [entryIndex] : [];
  while (work.length) {
    const index = work.pop();
    if (reachable.has(index) || !blocks[index]) continue;
    reachable.add(index);
    const next = blocks[index].succ.slice().sort((a, b) => b - a);
    for (const target of next) if (!reachable.has(target)) work.push(target);
  }

  const allReachable = new Set(reachable);
  const dominators = blocks.map((block) => {
    if (!reachable.has(block.index)) return new Set([block.index]);
    return block.index === entryIndex ? new Set([entryIndex]) : new Set(allReachable);
  });
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ <= blocks.length * 2 + 4) {
    changed = false;
    for (const block of blocks) {
      const index = block.index;
      if (index === entryIndex || !reachable.has(index)) continue;
      const preds = block.pred.filter((value) => reachable.has(value));
      let next = preds.length ? new Set(dominators[preds[0]]) : new Set();
      for (const p of preds.slice(1)) {
        for (const value of [...next]) if (!dominators[p].has(value)) next.delete(value);
      }
      next.add(index);
      const old = dominators[index];
      if (next.size !== old.size || [...next].some((value) => !old.has(value))) {
        dominators[index] = next;
        changed = true;
      }
    }
  }

  const idom = blocks.map(() => -1);
  for (const block of blocks) {
    const index = block.index;
    if (index === entryIndex || !reachable.has(index)) continue;
    const candidates = [...dominators[index]].filter((value) => value !== index);
    let immediate = -1;
    for (const candidate of candidates) {
      const dominatedByOther = candidates.some((other) => other !== candidate && dominators[other]?.has(candidate));
      if (!dominatedByOther) { immediate = candidate; break; }
    }
    idom[index] = immediate;
  }
  for (const block of blocks) block.idom = idom[block.index];

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

export function buildLegacyValues(ir, ssa) {
  const ssaByValue = new Map(ssa?.definitions?.map((definition) => [definition.valueId, definition]) || []);
  const versions = variableVersions(ir, ssa);
  const values = [];
  const byId = new Map();
  for (const semanticValue of ir.values) {
    const definition = ssaByValue.get(semanticValue.id);
    let kind = V1_VK.DEF;
    if (definition?.kind === 'phi') kind = V1_VK.PHI;
    else if (definition?.kind === 'entry' || semanticValue.kind === 'entry') kind = V1_VK.ARG;
    else if (definition?.kind === 'undef' || definition?.kind === 'unknown' || semanticValue.kind === 'undef' || semanticValue.kind === 'unknown') kind = V1_VK.UNDEF;
    const version = versions.get(semanticValue.id) || {};
    const value = {
      id: values.length,
      vid: values.length + 1,
      kind,
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
      sourceEntityId: semanticValue.sourceEntityId,
      machineType: semanticValue.machineType,
      origin: semanticValue.origin,
    };
    if (semanticValue.kind === 'unknown' || definition?.kind === 'unknown') value.unknown = true;
    if (semanticValue.kind === 'undef' || definition?.kind === 'undef') value.undefined = true;
    values.push(value);
    byId.set(semanticValue.id, value);
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
