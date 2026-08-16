import { createValueId, deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { appendTransform, createOriginSet, createTransformRecord, mergeOriginSets } from '../../core/identity/origin.js';
import { analyzeSemanticDominance, createSemanticCfg, deterministicTraversal } from '../cfg/index.js';
import { createSemanticIrFunction } from '../ir/function.js';
import { createSemanticSsaContract, SEMANTIC_SSA_DEFAULT_BUDGET } from './contract.js';

export const SEMANTIC_SSA_BUILD_VERSION = '1.0.0';
export const SEMANTIC_SSA_BUILD_DEFAULT_BUDGET = Object.freeze({
  ...SEMANTIC_SSA_DEFAULT_BUDGET,
  maxWorkItems: 4194304,
});

const PASS_ID = 'semantic-ssa';
const SYNTHETIC_UNKNOWN_STATE_KEY = '@unknown-state';

function fail(code) { throw new TypeError(code); }
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ssa-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function limit(options, key) {
  if (options?.budget?.[key] == null) return SEMANTIC_SSA_BUILD_DEFAULT_BUDGET[key];
  return positiveInteger(options.budget[key], `semantic-ssa-invalid-budget-${key}`);
}
function makeWorkCounter(options) {
  let used = 0;
  const maximum = limit(options, 'maxWorkItems');
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail('semantic-ssa-budget-exceeded-maxWorkItems');
  };
}
function checkCount(length, options, key) {
  if (length > limit(options, key)) fail(`semantic-ssa-budget-exceeded-${key}`);
}
function originHasContent(origin) {
  return origin.byteRanges.length || origin.virtualRanges.length || origin.instructionIds.length
    || origin.operationIds.length || origin.sourceLocations.length || origin.parentEntityIds.length || origin.transforms.length;
}
function safeOrigin(...origins) {
  const merged = mergeOriginSets(...origins.filter(Boolean));
  return originHasContent(merged) ? merged : createOriginSet({ parentEntityIds: ['semantic-ssa-synthetic-origin'] });
}
function refIdentity(variable) {
  if (!variable) return null;
  return {
    key: String(variable.key),
    kind: String(variable.kind),
    scope: String(variable.scope),
    ...(variable.physicalIdentity == null ? {} : { physicalIdentity: variable.physicalIdentity }),
  };
}
function typeKey(machineType) {
  return machineType == null ? 'unknown' : stableStringify(machineType);
}
function transformOrigin(origin, { ruleId, proofKind, consumedEntityIds = [], producedEntityIds = [], preconditions = [] }) {
  return appendTransform(origin, createTransformRecord({
    passId: PASS_ID,
    passVersion: SEMANTIC_SSA_BUILD_VERSION,
    ruleId,
    proofKind,
    consumedEntityIds,
    producedEntityIds,
    preconditions,
  }));
}
function valueIdentity(functionId, kind, variableKey, blockId, sourceEntityId) {
  return createValueId({
    functionId,
    canonicalDefinitionIdentity: {
      passId: PASS_ID,
      passVersion: SEMANTIC_SSA_BUILD_VERSION,
      kind,
      variableKey,
      blockId,
      sourceEntityId,
    },
  });
}
function definitionId(functionId, valueId) {
  return `ssa_def_${stableDigest({ functionId, valueId })}`;
}
function useId(functionId, sourceEntityId, variableKey, sourceSemanticValueId, ordinal) {
  return `ssa_use_${stableDigest({
    functionId,
    sourceEntityId,
    variableKey,
    sourceSemanticValueId: sourceSemanticValueId ?? null,
    ordinal,
  })}`;
}
function semanticValueSsaId(functionId, semanticValueId) {
  return createValueId({
    functionId,
    canonicalDefinitionIdentity: {
      passId: PASS_ID,
      passVersion: SEMANTIC_SSA_BUILD_VERSION,
      kind: 'semantic-value',
      semanticValueId,
    },
  });
}
function semanticUseId(functionId, sourceEntityId, semanticValueId) {
  return `ssa_use_${stableDigest({
    functionId,
    kind: 'semantic-value-use',
    sourceEntityId,
    semanticValueId,
  })}`;
}
function unreachableSemanticUndefId(functionId, blockId, semanticValueId) {
  return createValueId({
    functionId,
    canonicalDefinitionIdentity: {
      passId: PASS_ID,
      passVersion: SEMANTIC_SSA_BUILD_VERSION,
      kind: 'unreachable-semantic-undef',
      blockId,
      semanticValueId,
    },
  });
}
function normalizedRefSignature(ref) {
  return stableStringify(refIdentity(ref));
}
function semanticValueById(ir) {
  return new Map(ir.values.map((value) => [value.id, value]));
}
function nodeById(ir) {
  return new Map(ir.nodes.map((node) => [node.id, node]));
}
function blockById(ir) {
  return new Map(ir.blocks.map((block) => [block.id, block]));
}
function cfgBlockById(cfg) {
  return new Map(cfg.blocks.map((block) => [block.id, block]));
}
function variableProof(variant, extra = {}) {
  return {
    passId: PASS_ID,
    passVersion: SEMANTIC_SSA_BUILD_VERSION,
    variableIdentity: variant.refIdentity,
    machineType: variant.machineType,
    ...extra,
  };
}
function isStateUnknown(node) {
  if (node.kind === 'unknown-state-write') return true;
  if (node.unknown?.categories?.includes('state')) return true;
  if (node.kind === 'call' && node.call?.unknownEffects?.categories?.includes('state')) return true;
  return false;
}
function scalarReferences(node, tick) {
  const roles = new Map();
  const add = (valueId, role) => {
    tick();
    if (valueId == null) return;
    const id = String(valueId);
    const set = roles.get(id) ?? new Set();
    set.add(role);
    roles.set(id, set);
  };
  for (const valueId of node.inputs) add(valueId, 'input');
  if (node.memory) add(node.memory.addressExpr.valueId, 'memory-address');
  if (node.call) {
    for (const valueId of node.call.targetValueIds) add(valueId, 'call-target');
    for (const valueId of node.call.arguments) add(valueId, 'call-argument');
    for (const access of node.call.memoryRead.accesses ?? []) add(access.addressExpr.valueId, 'call-memory-read-address');
    for (const access of node.call.memoryWrite.accesses ?? []) add(access.addressExpr.valueId, 'call-memory-write-address');
  }
  if (node.intrinsic) {
    for (const valueId of node.intrinsic.inputs) add(valueId, 'intrinsic-input');
    for (const access of node.intrinsic.memoryRead.accesses ?? []) add(access.addressExpr.valueId, 'intrinsic-memory-read-address');
    for (const access of node.intrinsic.memoryWrite.accesses ?? []) add(access.addressExpr.valueId, 'intrinsic-memory-write-address');
  }
  return [...roles.entries()].map(([valueId, roleSet]) => ({ valueId, roles: [...roleSet].sort() }))
    .sort((a, b) => a.valueId.localeCompare(b.valueId));
}
function collectModel(ir, options, tick) {
  const values = semanticValueById(ir);
  const nodes = nodeById(ir);
  const refsByKey = new Map();
  const typesByKey = new Map();
  const seedCandidates = [];
  const rawEventsByBlock = new Map(ir.blocks.map((block) => [block.id, []]));
  const broadUnknownByBlock = new Map(ir.blocks.map((block) => [block.id, []]));

  const rememberRef = (ref) => {
    if (!ref) return;
    const key = String(ref.key);
    const signature = normalizedRefSignature(ref);
    const prior = refsByKey.get(key);
    if (prior && prior.signature !== signature) fail('semantic-ssa-variable-identity-conflict');
    if (!prior) refsByKey.set(key, { ref, signature });
  };
  const rememberType = (key, machineType) => {
    if (machineType == null) return;
    const byType = typesByKey.get(key) ?? new Map();
    byType.set(typeKey(machineType), machineType);
    typesByKey.set(key, byType);
  };
  const addRawEvent = (blockId, event) => {
    rawEventsByBlock.get(blockId).push(event);
  };

  for (const value of ir.values) {
    tick();
    if (value.variableKey == null) continue;
    const key = String(value.variableKey);
    rememberType(key, value.machineType);
    if (value.kind === 'entry' || value.kind === 'unknown' || value.kind === 'undef') {
      seedCandidates.push({ key, machineType: value.machineType, value });
    }
  }

  for (const block of ir.blocks) {
    for (let nodeOrdinal = 0; nodeOrdinal < block.nodeIds.length; nodeOrdinal++) {
      tick();
      const node = nodes.get(block.nodeIds[nodeOrdinal]);
      if (!node) fail('semantic-ssa-dangling-block-node');
      const base = { blockId: block.id, node, nodeOrdinal };
      if (node.variable) rememberRef(node.variable);
      if (node.kind === 'state-read') {
        if (!node.outputs.length) {
          addRawEvent(block.id, { ...base, phase: 0, kind: 'read', key: node.variable.key, machineType: null, sourceSemanticValueId: null, ref: node.variable });
        } else {
          for (let i = 0; i < node.outputs.length; i++) {
            const value = values.get(node.outputs[i]);
            if (!value) fail('semantic-ssa-dangling-state-read-output');
            rememberType(node.variable.key, value.machineType);
            addRawEvent(block.id, { ...base, phase: 0, kind: 'read', key: node.variable.key, machineType: value.machineType, sourceSemanticValueId: value.id, ref: node.variable, localOrdinal: i });
          }
        }
      } else if (node.kind === 'state-write') {
        if (node.inputs.length !== 1) fail('semantic-ssa-state-write-single-input-required');
        for (let i = 0; i < node.inputs.length; i++) {
          const value = values.get(node.inputs[i]);
          if (!value) fail('semantic-ssa-dangling-state-write-input');
          rememberType(node.variable.key, value.machineType);
          addRawEvent(block.id, { ...base, phase: 2, kind: 'write', key: node.variable.key, machineType: value.machineType, sourceSemanticValueId: value.id, ref: node.variable, localOrdinal: i, definitionKind: node.completeness === 'complete' ? 'definition' : 'unknown' });
        }
      }

      if (node.kind === 'call' || node.kind === 'intrinsic') {
        const summary = node.kind === 'call' ? node.call : node.intrinsic;
        for (const ref of summary?.stateReads ?? []) {
          rememberRef(ref);
          addRawEvent(block.id, { ...base, phase: 0, kind: 'read', key: ref.key, machineType: null, sourceSemanticValueId: null, ref, summaryKind: node.kind });
        }
        for (const ref of summary?.stateWrites ?? []) {
          rememberRef(ref);
          addRawEvent(block.id, { ...base, phase: 2, kind: 'write', key: ref.key, machineType: null, sourceSemanticValueId: null, ref, summaryKind: node.kind, definitionKind: 'unknown' });
        }
      }
      if (isStateUnknown(node)) broadUnknownByBlock.get(block.id).push(base);
    }
  }

  const knownKeys = new Set([...refsByKey.keys(), ...typesByKey.keys(), ...seedCandidates.map((seed) => seed.key)]);
  const broadUnknownCount = [...broadUnknownByBlock.values()].reduce((sum, items) => sum + items.length, 0);
  if (broadUnknownCount && knownKeys.size === 0) knownKeys.add(SYNTHETIC_UNKNOWN_STATE_KEY);
  for (const key of knownKeys) {
    if (!refsByKey.has(key)) {
      refsByKey.set(key, {
        ref: { key, kind: key === SYNTHETIC_UNKNOWN_STATE_KEY ? 'unknown-state' : 'logical-state', scope: 'function' },
        signature: stableStringify({ key, kind: key === SYNTHETIC_UNKNOWN_STATE_KEY ? 'unknown-state' : 'logical-state', scope: 'function' }),
      });
    }
  }

  const variants = [];
  const variantsByKey = new Map();
  for (const key of [...knownKeys].sort()) {
    tick();
    const knownTypes = [...(typesByKey.get(key)?.values() ?? [])]
      .sort((a, b) => typeKey(a).localeCompare(typeKey(b)));
    const types = knownTypes.length ? knownTypes : [null];
    const collision = types.length > 1;
    const ref = refsByKey.get(key).ref;
    for (const machineType of types) {
      const semanticKey = collision ? `${key}::${stableDigest({ machineType }).slice(0, 16)}` : key;
      const variant = deepFreeze({
        key: semanticKey,
        sourceKey: key,
        machineType,
        typeKey: typeKey(machineType),
        refIdentity: refIdentity(ref),
      });
      variants.push(variant);
      const list = variantsByKey.get(key) ?? [];
      list.push(variant);
      variantsByKey.set(key, list);
    }
  }

  const variantFor = (key, machineType) => {
    const candidates = variantsByKey.get(String(key)) ?? [];
    if (!candidates.length) fail('semantic-ssa-variable-variant-missing');
    if (machineType == null) return candidates;
    const wanted = typeKey(machineType);
    const exact = candidates.find((candidate) => candidate.typeKey === wanted);
    if (!exact) fail('semantic-ssa-variable-type-variant-missing');
    return [exact];
  };

  const eventsByBlock = new Map(ir.blocks.map((block) => [block.id, []]));
  for (const block of ir.blocks) {
    const expanded = [];
    for (const raw of rawEventsByBlock.get(block.id)) {
      tick();
      for (const variant of variantFor(raw.key, raw.machineType)) {
        tick();
        expanded.push({ ...raw, variant });
      }
    }
    for (const broad of broadUnknownByBlock.get(block.id)) {
      tick();
      for (const variant of variants) {
        tick();
        expanded.push({ ...broad, phase: 2, kind: 'write', key: variant.sourceKey, machineType: variant.machineType, sourceSemanticValueId: null, ref: refsByKey.get(variant.sourceKey).ref, variant, definitionKind: 'unknown', broadUnknown: true });
      }
    }
    const dedup = new Map();
    for (const event of expanded) {
      tick();
      const eventKey = stableStringify({
        nodeId: event.node.id,
        phase: event.phase,
        kind: event.kind,
        variableKey: event.variant.key,
        sourceSemanticValueId: event.kind === 'read' ? event.sourceSemanticValueId : null,
      });
      const prior = dedup.get(eventKey);
      if (!prior) dedup.set(eventKey, event);
      else if (event.broadUnknown && event.kind === 'write') dedup.set(eventKey, { ...prior, broadUnknown: true, definitionKind: 'unknown' });
    }
    eventsByBlock.set(block.id, [...dedup.values()].sort((a, b) =>
      a.nodeOrdinal - b.nodeOrdinal
      || a.phase - b.phase
      || a.variant.key.localeCompare(b.variant.key)
      || String(a.sourceSemanticValueId ?? '').localeCompare(String(b.sourceSemanticValueId ?? ''))));
  }

  const seedsByVariant = new Map(variants.map((variant) => [variant.key, []]));
  for (const seed of seedCandidates) {
    for (const variant of variantFor(seed.key, seed.machineType)) seedsByVariant.get(variant.key).push(seed.value);
  }
  for (const list of seedsByVariant.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    if (list.length > 1) fail('semantic-ssa-multiple-entry-values');
  }

  const sortedVariants = variants.sort((a, b) => a.key.localeCompare(b.key));
  return { values, nodes, variants: sortedVariants, variantBySemanticKey: new Map(sortedVariants.map((variant) => [variant.key, variant])), variantsByKey, eventsByBlock, seedsByVariant };
}

function computePhiBlocks(model, dominance, reachable, options, tick) {
  const phiBlocks = new Map(model.variants.map((variant) => [variant.key, new Set()]));
  const definitionBlocks = new Map(model.variants.map((variant) => [variant.key, new Set()]));
  for (const variant of model.variants) definitionBlocks.get(variant.key).add('__entry_seed__');
  for (const [blockId, events] of model.eventsByBlock) {
    tick();
    if (!reachable.has(blockId)) continue;
    for (const event of events) {
      tick();
      if (event.kind === 'write') definitionBlocks.get(event.variant.key).add(blockId);
    }
  }
  for (const variant of model.variants) {
    tick();
    const defs = [...definitionBlocks.get(variant.key)].filter((id) => id !== '__entry_seed__').sort();
    if (defs.length || reachable.has(dominance.reversePostOrder[0])) defs.unshift(dominance.reversePostOrder[0]);
    const pending = new Set([...new Set(defs)]);
    const queued = new Set(pending);
    while (pending.size) {
      tick();
      const blockId = [...pending].sort()[0];
      pending.delete(blockId);
      for (const frontierId of dominance.dominanceFrontier[blockId] ?? []) {
        tick();
        if (!reachable.has(frontierId) || frontierId === dominance.reversePostOrder[0]) continue;
        const phis = phiBlocks.get(variant.key);
        if (phis.has(frontierId)) continue;
        phis.add(frontierId);
        if (!definitionBlocks.get(variant.key).has(frontierId) && !queued.has(frontierId)) {
          queued.add(frontierId);
          pending.add(frontierId);
        }
      }
    }
  }
  let count = 0;
  for (const blocks of phiBlocks.values()) count += blocks.size;
  checkCount(count + model.variants.length, options, 'maxDefinitions');
  return phiBlocks;
}

function seedDefinition(ir, cfg, variant, semanticValue) {
  const kind = semanticValue?.kind ?? 'undef';
  const sourceEntityId = semanticValue?.id ?? cfg.entryBlockId;
  const valueId = valueIdentity(ir.functionId, kind, variant.key, cfg.entryBlockId, sourceEntityId);
  const baseOrigin = semanticValue?.origin ?? safeOrigin(ir.origin, createOriginSet({ parentEntityIds: [cfg.entryBlockId] }));
  const origin = transformOrigin(baseOrigin, {
    ruleId: semanticValue ? 'entry-seed' : 'implicit-undef',
    proofKind: semanticValue ? 'semantic-entry-state' : 'explicit-undefined',
    consumedEntityIds: semanticValue ? [semanticValue.id] : [cfg.entryBlockId],
    producedEntityIds: [valueId],
    preconditions: [{ variableKey: variant.key, machineType: variant.machineType }],
  });
  return {
    definitionId: definitionId(ir.functionId, valueId),
    valueId,
    kind,
    blockId: cfg.entryBlockId,
    variableKey: variant.key,
    sourceEntityId,
    origin,
    proof: variableProof(variant, {
      kind: semanticValue ? 'entry-seed' : 'implicit-undef',
      sourceSemanticValueId: semanticValue?.id ?? null,
      sourceSemanticEntityId: semanticValue?.sourceEntityId ?? null,
      transform: { ruleId: semanticValue ? 'entry-seed' : 'implicit-undef', proofKind: semanticValue ? 'semantic-entry-state' : 'explicit-undefined' },
    }),
  };
}

function unreachableUndefDefinition(ir, block, variant) {
  const sourceEntityId = block.id;
  const valueId = valueIdentity(ir.functionId, 'undef', variant.key, block.id, sourceEntityId);
  const baseOrigin = safeOrigin(block.origin, createOriginSet({ parentEntityIds: [block.id] }));
  const origin = transformOrigin(baseOrigin, {
    ruleId: 'unreachable-undef',
    proofKind: 'unreachable-explicit-undefined',
    consumedEntityIds: [block.id],
    producedEntityIds: [valueId],
    preconditions: [{ variableKey: variant.key, machineType: variant.machineType }],
  });
  return {
    definitionId: definitionId(ir.functionId, valueId), valueId, kind: 'undef', blockId: block.id,
    variableKey: variant.key, sourceEntityId, origin,
    proof: variableProof(variant, { kind: 'unreachable-undef', sourceSemanticValueId: null, transform: { ruleId: 'unreachable-undef', proofKind: 'unreachable-explicit-undefined' } }),
  };
}

function semanticValueDefinition(ir, cfg, value, nodes) {
  const definitionNode = value.definitionNodeId == null ? null : nodes.get(value.definitionNodeId);
  const blockId = definitionNode?.blockId ?? cfg.entryBlockId;
  const valueId = semanticValueSsaId(ir.functionId, value.id);
  const baseOrigin = safeOrigin(value.origin, definitionNode?.origin);
  const origin = transformOrigin(baseOrigin, {
    ruleId: 'semantic-value-definition',
    proofKind: 'semantic-value-identity',
    consumedEntityIds: [value.id, ...(definitionNode ? [definitionNode.id] : [])],
    producedEntityIds: [valueId],
    preconditions: [{ machineType: value.machineType, sourceVariableKey: value.variableKey ?? null }],
  });
  return {
    definitionId: definitionId(ir.functionId, valueId),
    valueId,
    kind: value.kind,
    blockId,
    variableKey: null,
    sourceEntityId: value.id,
    origin,
    proof: {
      passId: PASS_ID,
      passVersion: SEMANTIC_SSA_BUILD_VERSION,
      kind: 'semantic-value-definition',
      variableIdentity: null,
      machineType: value.machineType,
      sourceSemanticValueId: value.id,
      sourceSemanticEntityId: value.sourceEntityId ?? null,
      sourceDefinitionNodeId: value.definitionNodeId ?? null,
      sourceVariableKey: value.variableKey ?? null,
      transform: { ruleId: 'semantic-value-definition', proofKind: 'semantic-value-identity' },
    },
  };
}

function unreachableSemanticUndefDefinition(ir, block, semanticValue) {
  const valueId = unreachableSemanticUndefId(ir.functionId, block.id, semanticValue.id);
  const origin = transformOrigin(safeOrigin(block.origin, semanticValue.origin, createOriginSet({ parentEntityIds: [block.id] })), {
    ruleId: 'unreachable-semantic-undef',
    proofKind: 'unreachable-explicit-undefined',
    consumedEntityIds: [block.id, semanticValue.id],
    producedEntityIds: [valueId],
    preconditions: [{ machineType: semanticValue.machineType }],
  });
  return {
    definitionId: definitionId(ir.functionId, valueId),
    valueId,
    kind: 'undef',
    blockId: block.id,
    variableKey: null,
    sourceEntityId: semanticValue.id,
    origin,
    proof: {
      passId: PASS_ID,
      passVersion: SEMANTIC_SSA_BUILD_VERSION,
      kind: 'unreachable-semantic-undef',
      variableIdentity: null,
      machineType: semanticValue.machineType,
      sourceSemanticValueId: semanticValue.id,
      sourceSemanticEntityId: semanticValue.sourceEntityId ?? null,
      sourceDefinitionNodeId: semanticValue.definitionNodeId ?? null,
      sourceVariableKey: semanticValue.variableKey ?? null,
      transform: { ruleId: 'unreachable-semantic-undef', proofKind: 'unreachable-explicit-undefined' },
    },
  };
}

function semanticValueUse(ir, node, semanticValue, reachingValueId, roles) {
  const id = semanticUseId(ir.functionId, node.id, semanticValue.id);
  const origin = transformOrigin(safeOrigin(node.origin, semanticValue.origin), {
    ruleId: 'semantic-value-use',
    proofKind: 'semantic-value-use-def',
    consumedEntityIds: [node.id, semanticValue.id],
    producedEntityIds: [id],
    preconditions: [{ reachingValueId, roles }],
  });
  return {
    useId: id,
    valueId: reachingValueId,
    blockId: node.blockId,
    sourceEntityId: node.id,
    origin,
    proof: {
      passId: PASS_ID,
      passVersion: SEMANTIC_SSA_BUILD_VERSION,
      kind: 'semantic-value-use',
      variableIdentity: null,
      machineType: semanticValue.machineType,
      sourceSemanticValueId: semanticValue.id,
      sourceSemanticEntityId: node.id,
      sourceVariableKey: semanticValue.variableKey ?? null,
      roles,
      transform: { ruleId: 'semantic-value-use', proofKind: 'semantic-value-use-def' },
    },
  };
}

function writeDefinition(ir, event, values) {
  const sourceEntityId = event.node.id;
  const valueId = valueIdentity(ir.functionId, event.definitionKind, event.variant.key, event.blockId, sourceEntityId);
  const sourceValue = event.sourceSemanticValueId == null ? null : values.get(event.sourceSemanticValueId);
  const baseOrigin = safeOrigin(event.node.origin, sourceValue?.origin);
  const origin = transformOrigin(baseOrigin, {
    ruleId: event.definitionKind === 'unknown' ? 'unknown-state-definition' : 'rename-definition',
    proofKind: event.definitionKind === 'unknown' ? 'conservative-state-clobber' : 'dominance-renaming',
    consumedEntityIds: [event.node.id, ...(event.sourceSemanticValueId ? [event.sourceSemanticValueId] : [])],
    producedEntityIds: [valueId],
    preconditions: [{ variableKey: event.variant.key, machineType: event.variant.machineType }],
  });
  return {
    definitionId: definitionId(ir.functionId, valueId), valueId, kind: event.definitionKind,
    blockId: event.blockId, variableKey: event.variant.key, sourceEntityId, origin,
    proof: variableProof(event.variant, {
      kind: event.definitionKind === 'unknown' ? 'unknown-state-definition' : 'renamed-definition',
      sourceSemanticValueId: event.sourceSemanticValueId,
      sourceSemanticEntityId: event.node.id,
      summaryKind: event.summaryKind ?? null,
      broadUnknown: Boolean(event.broadUnknown),
      transform: { ruleId: event.definitionKind === 'unknown' ? 'unknown-state-definition' : 'rename-definition', proofKind: event.definitionKind === 'unknown' ? 'conservative-state-clobber' : 'dominance-renaming' },
    }),
  };
}

function phiSkeleton(ir, block, variant) {
  const valueId = valueIdentity(ir.functionId, 'phi', variant.key, block.id, block.id);
  return {
    definitionId: definitionId(ir.functionId, valueId), valueId, kind: 'phi', blockId: block.id,
    variableKey: variant.key, sourceEntityId: block.id, incoming: [], origin: null,
    proof: variableProof(variant, { kind: 'dominance-frontier', mergeBlockId: block.id, transform: { ruleId: 'phi-insertion', proofKind: 'dominance-frontier' } }),
  };
}

function resolvePhiOrigins(phiDefinitions, definitionByValue, irBlocks, tick) {
  const base = new Map();
  const current = new Map();
  for (const phi of phiDefinitions) {
    const origin = safeOrigin(irBlocks.get(phi.blockId)?.origin, createOriginSet({ parentEntityIds: [phi.blockId] }));
    base.set(phi.valueId, origin);
    current.set(phi.valueId, origin);
  }
  const maximumRounds = phiDefinitions.length + 2;
  for (let round = 0; round < maximumRounds; round++) {
    let changed = false;
    for (const phi of phiDefinitions.slice().sort((a, b) => a.valueId.localeCompare(b.valueId))) {
      tick();
      const incomingOrigins = [];
      for (const incoming of phi.incoming) {
        tick();
        const incomingDefinition = definitionByValue.get(incoming.valueId);
        if (!incomingDefinition) fail('semantic-ssa-dangling-phi-value-id');
        incomingOrigins.push(incomingDefinition.kind === 'phi' ? current.get(incoming.valueId) : incomingDefinition.origin);
      }
      const next = safeOrigin(base.get(phi.valueId), ...incomingOrigins);
      if (stableStringify(next) !== stableStringify(current.get(phi.valueId))) {
        current.set(phi.valueId, next);
        changed = true;
      }
    }
    if (!changed) return current;
  }
  fail('semantic-ssa-phi-origin-did-not-converge');
}

function finalizePhi(phi, resolvedOrigin) {
  const incoming = phi.incoming.slice().sort((a, b) => a.predecessorBlockId.localeCompare(b.predecessorBlockId) || a.valueId.localeCompare(b.valueId));
  const origin = transformOrigin(resolvedOrigin, {
    ruleId: 'phi-insertion',
    proofKind: 'dominance-frontier',
    consumedEntityIds: [phi.blockId, ...incoming.map((item) => item.valueId)],
    producedEntityIds: [phi.valueId],
    preconditions: [{ predecessorBlockIds: incoming.map((item) => item.predecessorBlockId), variableKey: phi.variableKey }],
  });
  return {
    ...phi,
    incoming,
    origin,
    proof: {
      ...phi.proof,
      contributingValueIds: incoming.map((item) => item.valueId),
      predecessorBlockIds: incoming.map((item) => item.predecessorBlockId),
    },
  };
}

export function buildSemanticSsa(irInput, cfgInput, options = {}) {
  assertNotAborted(options);
  const tick = makeWorkCounter(options);
  const ir = createSemanticIrFunction(irInput, { signal: options.signal, ...(options.irOptions ?? {}) });
  const cfg = createSemanticCfg(cfgInput, { signal: options.signal, ...(options.cfgOptions ?? {}) });
  if (ir.functionId !== cfg.functionId) fail('semantic-ssa-function-mismatch');
  if (ir.entryBlockId !== cfg.entryBlockId) fail('semantic-ssa-entry-block-mismatch');
  const irIds = ir.blocks.map((block) => block.id).sort();
  const cfgIds = cfg.blocks.map((block) => block.id).sort();
  if (stableStringify(irIds) !== stableStringify(cfgIds)) fail('semantic-ssa-block-set-mismatch');
  const entryBlock = cfg.blocks.find((block) => block.id === cfg.entryBlockId);
  if (entryBlock.predecessors.length) fail('semantic-ssa-entry-has-predecessors');

  const dominance = analyzeSemanticDominance(cfg, { signal: options.signal, budget: { maxWorkItems: limit(options, 'maxWorkItems') } });
  const reachable = new Set(dominance.reachable);
  const model = collectModel(ir, options, tick);
  const phiBlocks = computePhiBlocks(model, dominance, reachable, options, tick);
  const irBlocks = blockById(ir);
  const cfgBlocks = cfgBlockById(cfg);
  const definitions = [];
  const uses = [];
  const definitionByValue = new Map();
  const phiByBlock = new Map(cfg.blocks.map((block) => [block.id, new Map()]));
  const stacks = new Map(model.variants.map((variant) => [variant.key, []]));

  const addDefinition = (definition) => {
    tick();
    if (definitionByValue.has(definition.valueId)) fail('semantic-ssa-duplicate-value-id');
    definitions.push(definition);
    checkCount(definitions.length, options, 'maxDefinitions');
    definitionByValue.set(definition.valueId, definition);
  };
  const addUse = (use) => {
    tick();
    uses.push(use);
    checkCount(uses.length, options, 'maxUses');
    if (uses.length > limit(options, 'maxLinks')) fail('semantic-ssa-budget-exceeded-maxLinks');
  };

  const scalarValueIdBySemantic = new Map();
  for (const semanticValue of ir.values) {
    tick();
    const definition = semanticValueDefinition(ir, cfg, semanticValue, model.nodes);
    addDefinition(definition);
    scalarValueIdBySemantic.set(semanticValue.id, definition.valueId);
  }

  const nodePositions = new Map();
  for (const block of ir.blocks) {
    for (let index = 0; index < block.nodeIds.length; index++) { tick(); nodePositions.set(block.nodeIds[index], { blockId: block.id, index }); }
  }
  const unreachableScalarUndefs = new Map();
  for (const block of ir.blocks) {
    const blockReachable = reachable.has(block.id);
    for (const nodeId of block.nodeIds) {
      tick();
      const node = model.nodes.get(nodeId);
      for (const reference of scalarReferences(node, tick)) {
        tick();
        const semanticValue = model.values.get(reference.valueId);
        if (!semanticValue) fail('semantic-ssa-dangling-semantic-value-use');
        const directValueId = scalarValueIdBySemantic.get(semanticValue.id);
        const directDefinition = definitionByValue.get(directValueId);
        let reachingValueId = directValueId;
        const sourcePosition = semanticValue.definitionNodeId == null ? null : nodePositions.get(semanticValue.definitionNodeId);
        const usePosition = nodePositions.get(node.id);
        const sameBlockBeforeUse = directDefinition.blockId === block.id
          && (sourcePosition == null || sourcePosition.index < usePosition.index);
        if (blockReachable) {
          if (!(dominance.dominators[block.id] ?? []).includes(directDefinition.blockId)) fail('semantic-ssa-semantic-value-not-dominating-use');
          if (directDefinition.blockId === block.id && sourcePosition != null && sourcePosition.index >= usePosition.index) {
            fail('semantic-ssa-semantic-value-defined-after-use');
          }
        } else if (!sameBlockBeforeUse) {
          const key = `${block.id}::${semanticValue.id}`;
          let local = unreachableScalarUndefs.get(key);
          if (!local) {
            local = unreachableSemanticUndefDefinition(ir, irBlocks.get(block.id), semanticValue);
            addDefinition(local);
            unreachableScalarUndefs.set(key, local);
          }
          reachingValueId = local.valueId;
        }
        addUse(semanticValueUse(ir, node, semanticValue, reachingValueId, reference.roles));
      }
    }
  }

  for (const variant of model.variants) {
    const seed = seedDefinition(ir, cfg, variant, model.seedsByVariant.get(variant.key)[0] ?? null);
    addDefinition(seed);
    stacks.get(variant.key).push(seed.valueId);
  }

  for (const variant of model.variants) {
    for (const blockId of [...phiBlocks.get(variant.key)].sort()) {
      const phi = phiSkeleton(ir, irBlocks.get(blockId), variant);
      addDefinition(phi);
      phiByBlock.get(blockId).set(variant.key, phi);
    }
  }

  const children = new Map(cfg.blocks.map((block) => [block.id, []]));
  for (const [blockId, idom] of Object.entries(dominance.immediateDominators)) {
    if (idom != null) children.get(idom).push(blockId);
  }
  for (const list of children.values()) list.sort();

  let useOrdinal = 0;
  let phiLinkCount = 0;
  const addPhiIncoming = (phi, predecessorBlockId, valueId) => {
    if (++phiLinkCount + uses.length > limit(options, 'maxLinks')) fail('semantic-ssa-budget-exceeded-maxLinks');
    phi.incoming.push({ predecessorBlockId, valueId });
  };

  const renameReachable = (rootId) => {
    const frames = [{ blockId: rootId, entered: false, childIndex: 0, pushed: [] }];
    while (frames.length) {
      tick();
      const frame = frames[frames.length - 1];
      if (!frame.entered) {
        frame.entered = true;
        const blockId = frame.blockId;
        const blockPhis = phiByBlock.get(blockId);
        for (const variantKey of [...blockPhis.keys()].sort()) {
          const phi = blockPhis.get(variantKey);
          stacks.get(variantKey).push(phi.valueId);
          frame.pushed.push(variantKey);
        }
        for (const event of model.eventsByBlock.get(blockId)) {
          tick();
          const stack = stacks.get(event.variant.key);
          if (event.kind === 'read') {
            const current = stack[stack.length - 1];
            if (!current) fail('semantic-ssa-missing-reaching-definition');
            const id = useId(ir.functionId, event.node.id, event.variant.key, event.sourceSemanticValueId, useOrdinal++);
            const sourceValue = event.sourceSemanticValueId == null ? null : model.values.get(event.sourceSemanticValueId);
            const origin = transformOrigin(safeOrigin(event.node.origin, sourceValue?.origin), {
              ruleId: 'rename-use', proofKind: 'dominance-renaming',
              consumedEntityIds: [event.node.id, ...(event.sourceSemanticValueId ? [event.sourceSemanticValueId] : [])],
              producedEntityIds: [id],
              preconditions: [{ variableKey: event.variant.key, reachingValueId: current }],
            });
            addUse({
              useId: id, valueId: current, blockId, sourceEntityId: event.node.id, origin,
              proof: variableProof(event.variant, {
                kind: 'renamed-use', sourceSemanticValueId: event.sourceSemanticValueId,
                sourceSemanticEntityId: event.node.id, summaryKind: event.summaryKind ?? null,
                transform: { ruleId: 'rename-use', proofKind: 'dominance-renaming' },
              }),
            });
          } else {
            const definition = writeDefinition(ir, event, model.values);
            addDefinition(definition);
            stack.push(definition.valueId);
            frame.pushed.push(event.variant.key);
          }
        }
        for (const successorId of [...new Set(cfgBlocks.get(blockId).successors.map((edge) => edge.to))].sort()) {
          const successorPhis = phiByBlock.get(successorId);
          for (const variantKey of [...successorPhis.keys()].sort()) {
            const stack = stacks.get(variantKey);
            const current = stack[stack.length - 1];
            if (!current) fail('semantic-ssa-missing-phi-input-definition');
            addPhiIncoming(successorPhis.get(variantKey), blockId, current);
          }
        }
      }
      const blockChildren = children.get(frame.blockId);
      if (frame.childIndex < blockChildren.length) {
        frames.push({ blockId: blockChildren[frame.childIndex++], entered: false, childIndex: 0, pushed: [] });
        continue;
      }
      for (let i = frame.pushed.length - 1; i >= 0; i--) stacks.get(frame.pushed[i]).pop();
      frames.pop();
    }
  };
  renameReachable(cfg.entryBlockId);

  const unreachable = deterministicTraversal(cfg, { signal: options.signal, budget: { maxWorkItems: limit(options, 'maxWorkItems') } }).filter((blockId) => !reachable.has(blockId));
  for (const blockId of unreachable) {
    tick();
    const local = new Map();
    const neededVariantKeys = new Set(model.eventsByBlock.get(blockId).map((event) => event.variant.key));
    for (const successorId of [...new Set(cfgBlocks.get(blockId).successors.map((edge) => edge.to))]) {
      for (const variantKey of phiByBlock.get(successorId).keys()) neededVariantKeys.add(variantKey);
    }
    for (const variantKey of [...neededVariantKeys].sort()) {
      const variant = model.variantBySemanticKey.get(variantKey);
      const undef = unreachableUndefDefinition(ir, irBlocks.get(blockId), variant);
      addDefinition(undef);
      local.set(variant.key, undef.valueId);
    }
    for (const event of model.eventsByBlock.get(blockId)) {
      tick();
      if (event.kind === 'read') {
        const current = local.get(event.variant.key);
        const id = useId(ir.functionId, event.node.id, event.variant.key, event.sourceSemanticValueId, useOrdinal++);
        const sourceValue = event.sourceSemanticValueId == null ? null : model.values.get(event.sourceSemanticValueId);
        const origin = transformOrigin(safeOrigin(event.node.origin, sourceValue?.origin), {
          ruleId: 'rename-use', proofKind: 'unreachable-local-renaming',
          consumedEntityIds: [event.node.id, ...(event.sourceSemanticValueId ? [event.sourceSemanticValueId] : [])],
          producedEntityIds: [id], preconditions: [{ variableKey: event.variant.key, reachingValueId: current }],
        });
        addUse({
          useId: id, valueId: current, blockId, sourceEntityId: event.node.id, origin,
          proof: variableProof(event.variant, {
            kind: 'renamed-use', sourceSemanticValueId: event.sourceSemanticValueId,
            sourceSemanticEntityId: event.node.id, transform: { ruleId: 'rename-use', proofKind: 'unreachable-local-renaming' },
          }),
        });
      } else {
        const definition = writeDefinition(ir, event, model.values);
        addDefinition(definition);
        local.set(event.variant.key, definition.valueId);
      }
    }
    for (const successorId of [...new Set(cfgBlocks.get(blockId).successors.map((edge) => edge.to))].sort()) {
      const successorPhis = phiByBlock.get(successorId);
      for (const variantKey of [...successorPhis.keys()].sort()) {
        addPhiIncoming(successorPhis.get(variantKey), blockId, local.get(variantKey));
      }
    }
  }

  const phiDefinitions = definitions.filter((definition) => definition.kind === 'phi');
  const phiOrigins = resolvePhiOrigins(phiDefinitions, definitionByValue, irBlocks, tick);
  const finalizedDefinitions = definitions.map((definition) => definition.kind === 'phi'
    ? finalizePhi(definition, phiOrigins.get(definition.valueId))
    : definition);
  const finalizedByValue = new Map(finalizedDefinitions.map((definition) => [definition.valueId, definition]));
  for (const definition of finalizedDefinitions) {
    if (definition.kind !== 'phi') continue;
    const expected = cfgBlocks.get(definition.blockId).predecessors;
    const actual = definition.incoming.map((item) => item.predecessorBlockId).sort();
    if (stableStringify(expected) !== stableStringify(actual)) fail('semantic-ssa-phi-predecessor-set-incomplete');
    for (const incoming of definition.incoming) if (!finalizedByValue.has(incoming.valueId)) fail('semantic-ssa-dangling-phi-value-id');
  }

  return createSemanticSsaContract({ functionId: ir.functionId, definitions: finalizedDefinitions, uses }, {
    cfg,
    signal: options.signal,
    budget: {
      maxDefinitions: limit(options, 'maxDefinitions'),
      maxUses: limit(options, 'maxUses'),
      maxLinks: limit(options, 'maxLinks'),
    },
  });
}

export const buildScalarSsa = buildSemanticSsa;
