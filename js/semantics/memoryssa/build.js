import {
  deepFreeze,
  jsonSafe,
  stableDigest,
  stableStringify,
} from '../../core/identity/index.js';
import {
  appendTransform,
  createTransformRecord,
} from '../../core/identity/origin.js';
import {
  deterministicTraversal,
  reachableBlocks,
} from '../cfg/index.js';
import {
  MEMORY_SSA_ALIAS_RELATIONS,
  MEMORY_SSA_DEFAULT_BUDGET,
  createMemoryRegionRef,
  createMemorySsaContract,
} from './contract.js';

export const MEMORY_SSA_BUILD_VERSION = '1.0.0';
export const MEMORY_SSA_BUILD_DEFAULT_BUDGET = Object.freeze({
  ...MEMORY_SSA_DEFAULT_BUDGET,
  maxAliasQueries: 1048576,
  maxWorkItems: 4194304,
});

const ALIAS_RELATIONS = new Set(MEMORY_SSA_ALIAS_RELATIONS);

function fail(code) { throw new TypeError(code); }
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('memory-ssa-build-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function budgetLimit(options, key, fallback = MEMORY_SSA_BUILD_DEFAULT_BUDGET[key]) {
  if (options?.budget?.[key] == null) return fallback;
  return positiveInteger(options.budget[key], `memory-ssa-build-invalid-budget-${key}`);
}
function createCounter(options, key) {
  const maximum = budgetLimit(options, key);
  let used = 0;
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail(`memory-ssa-build-budget-exceeded-${key}`);
  };
}
function entityId(prefix, payload) {
  return `${prefix}_${stableDigest({ version: MEMORY_SSA_BUILD_VERSION, ...payload })}`;
}
function transformOrigin(origin, { ruleId, consumedEntityIds, producedEntityIds, proofKind }) {
  return appendTransform(origin, createTransformRecord({
    passId: 'semantic-memoryssa',
    passVersion: MEMORY_SSA_BUILD_VERSION,
    ruleId,
    consumedEntityIds,
    producedEntityIds,
    preconditions: [],
    proofKind,
  }));
}
function functionAndCfgMatch(irFunction, cfg) {
  if (!irFunction || typeof irFunction !== 'object') fail('memory-ssa-build-ir-required');
  if (!cfg || typeof cfg !== 'object') fail('memory-ssa-build-cfg-required');
  if (String(irFunction.functionId) !== String(cfg.functionId)) fail('memory-ssa-build-function-mismatch');
}
function nodeOrder(irFunction, cfg, options) {
  const nodeById = new Map(irFunction.nodes.map((node) => [node.id, node]));
  const blockById = new Map(irFunction.blocks.map((block) => [block.id, block]));
  const ordered = [];
  for (const blockId of deterministicTraversal(cfg, { signal: options.signal, includeUnreachable: true })) {
    const block = blockById.get(blockId);
    if (!block) fail('memory-ssa-build-cfg-ir-block-mismatch');
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) fail('memory-ssa-build-dangling-node');
      ordered.push(node);
    }
  }
  return ordered;
}
function defaultUnknownRegion(functionId) {
  return createMemoryRegionRef({
    id: entityId('memoryregion', { functionId, kind: 'default-unknown' }),
    kind: 'unknown',
    functionId,
    uncertaintyIdentity: { source: 'generic-memoryssa-default' },
    metadata: { precision: 'conservative-default' },
  });
}
function normalizeResolution(raw, fallback) {
  const values = raw == null ? [fallback] : Array.isArray(raw) ? raw : [raw];
  const regions = [];
  for (const value of values) {
    if (value == null) continue;
    const candidate = value && typeof value === 'object' && value.region ? value.region : value;
    regions.push(createMemoryRegionRef(candidate));
  }
  if (!regions.length) regions.push(fallback);
  const byId = new Map();
  for (const region of regions) {
    const prior = byId.get(region.id);
    if (prior && stableStringify(prior) !== stableStringify(region)) fail('memory-ssa-build-conflicting-region-id');
    byId.set(region.id, region);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function callResolver(resolver, memory, context, fallback) {
  if (typeof resolver !== 'function') return [fallback];
  const value = resolver(memory, context);
  if (value && typeof value.then === 'function') fail('memory-ssa-build-async-region-resolver-unsupported');
  return normalizeResolution(value, fallback);
}
function normalizeAliasResult(raw) {
  const relation = typeof raw === 'string' ? raw : raw?.relation ?? raw?.aliasRelation;
  const normalized = relation == null ? 'unknown' : String(relation);
  if (!ALIAS_RELATIONS.has(normalized)) fail('memory-ssa-build-invalid-alias-relation');
  const proof = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? jsonSafe({
      reasonCodes: raw.reasonCodes ?? [],
      evidenceIds: raw.evidenceIds ?? [],
      proof: raw.proof ?? null,
    })
    : null;
  return { relation: normalized, proof };
}
function combineAliasResults(results) {
  if (!results.length) return { relation: 'unknown', proof: null };
  const relations = results.map((result) => result.relation);
  let relation;
  if (relations.every((value) => value === 'no')) relation = 'no';
  else if (relations.every((value) => value === 'must')) relation = 'must';
  else if (relations.includes('unknown')) relation = 'unknown';
  else relation = 'may';
  return {
    relation,
    proof: jsonSafe({ alternatives: results.map((result) => ({ relation: result.relation, proof: result.proof })) }),
  };
}
function scopeNeedsBroadAccess(node, summary) {
  return node.kind === 'call' && summary.completeness !== 'complete';
}
function memoryUnknown(node) {
  if (node.kind === 'unknown-memory-effect') return true;
  if (node.kind !== 'incomplete') return false;
  return (node.unknown?.categories ?? []).some((category) => String(category).toLowerCase().includes('memory'))
    || (node.unknown?.missing ?? []).some((category) => String(category).toLowerCase().includes('memory'));
}
function descriptorKey(node, role, sourceKind, index, suffix = '') {
  return `${node.id}\u0000${role}\u0000${sourceKind}\u0000${index}\u0000${suffix}`;
}
function makeDescriptor(node, role, sourceKind, index, memory, extra = {}) {
  return {
    key: descriptorKey(node, role, sourceKind, index, extra.suffix ?? ''),
    node,
    role,
    sourceKind,
    index,
    memory,
    broad: Boolean(extra.broad),
    scope: extra.scope ?? null,
    summary: extra.summary ?? null,
    regions: [],
  };
}
function discoverDescriptors(irFunction, cfg, options, fallbackRegion) {
  const descriptors = [];
  const readsByNode = new Map();
  const writesByNode = new Map();
  const add = (descriptor) => {
    descriptors.push(descriptor);
    const target = descriptor.role === 'read' ? readsByNode : writesByNode;
    if (!target.has(descriptor.node.id)) target.set(descriptor.node.id, []);
    target.get(descriptor.node.id).push(descriptor);
  };
  const addSummaryScope = (node, summary, scope, role, sourceKind) => {
    const forceBroad = scopeNeedsBroadAccess(node, summary);
    if (forceBroad || scope.scope === 'all' || scope.scope === 'unknown') {
      add(makeDescriptor(node, role, sourceKind, 0, null, { broad: true, scope, summary, suffix: forceBroad ? 'incomplete-call' : scope.scope }));
      return;
    }
    if (scope.scope !== 'accesses') return;
    scope.accesses.forEach((memory, index) => add(makeDescriptor(node, role, sourceKind, index, memory, { scope, summary })));
  };

  for (const node of nodeOrder(irFunction, cfg, options)) {
    if (node.kind === 'load') add(makeDescriptor(node, 'read', 'load', 0, node.memory));
    if (node.kind === 'store') add(makeDescriptor(node, 'write', 'store', 0, node.memory));
    if (node.kind === 'call') {
      addSummaryScope(node, node.call, node.call.memoryRead, 'read', 'call');
      addSummaryScope(node, node.call, node.call.memoryWrite, 'write', 'call');
    }
    if (node.kind === 'intrinsic') {
      addSummaryScope(node, node.intrinsic, node.intrinsic.memoryRead, 'read', 'intrinsic');
      addSummaryScope(node, node.intrinsic, node.intrinsic.memoryWrite, 'write', 'intrinsic');
    }
    if (memoryUnknown(node)) {
      add(makeDescriptor(node, 'read', 'unknown-memory-effect', 0, null, { broad: true, suffix: 'unknown-read' }));
      add(makeDescriptor(node, 'write', 'unknown-memory-effect', 0, null, { broad: true, suffix: 'unknown-write' }));
    } else if (node.completeness !== 'complete'
      && node.kind === 'store'
      && (node.unknown?.categories ?? []).some((category) => String(category).toLowerCase().includes('memory'))) {
      add(makeDescriptor(node, 'write', 'unknown-memory-effect', 1, null, { broad: true, suffix: 'partial-store' }));
    }
  }

  for (const descriptor of descriptors) {
    assertNotAborted(options);
    if (descriptor.broad) {
      descriptor.regions = [fallbackRegion];
      continue;
    }
    descriptor.regions = callResolver(options.resolveRegion, descriptor.memory, {
      function: irFunction,
      cfg,
      node: descriptor.node,
      role: descriptor.role,
      sourceKind: descriptor.sourceKind,
      accessIndex: descriptor.index,
      signal: options.signal,
    }, fallbackRegion);
  }
  return { descriptors, readsByNode, writesByNode };
}
function addRegion(regionById, region) {
  const normalized = createMemoryRegionRef(region);
  const prior = regionById.get(normalized.id);
  if (prior && stableStringify(prior) !== stableStringify(normalized)) fail('memory-ssa-build-conflicting-region-id');
  regionById.set(normalized.id, normalized);
}
function unreachableRoots(cfg, options) {
  const reachable = new Set(reachableBlocks(cfg, cfg.entryBlockId, { signal: options.signal }));
  const unreachable = cfg.blocks.map((block) => block.id).filter((id) => !reachable.has(id)).sort();
  const unreachableSet = new Set(unreachable);
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const roots = new Set([cfg.entryBlockId]);
  const seen = new Set();
  for (const seed of unreachable) {
    if (seen.has(seed)) continue;
    roots.add(seed);
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const id = stack.pop();
      const block = byId.get(id);
      const neighbors = [
        ...block.predecessors,
        ...block.successors.map((edge) => edge.to),
      ].filter((value) => unreachableSet.has(value)).sort().reverse();
      for (const next of neighbors) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return roots;
}
function mapEqual(left, right, regionIds) {
  if (!left || !right) return false;
  return regionIds.every((regionId) => left.get(regionId) === right.get(regionId));
}
function cloneState(state) { return new Map(state); }
function blockStateArray(blockId, state) {
  return {
    blockId,
    regions: [...state.entries()]
      .map(([regionId, definitionId]) => ({ regionId, definitionId }))
      .sort((a, b) => a.regionId.localeCompare(b.regionId)),
  };
}
function effectSummary(descriptor, relation) {
  const memory = descriptor.memory == null ? null : jsonSafe(descriptor.memory);
  const sequencing = descriptor.memory == null ? null : jsonSafe({
    volatility: descriptor.memory.volatility,
    atomic: descriptor.memory.atomic,
    ordering: descriptor.memory.ordering,
    alignment: descriptor.memory.alignment,
  });
  const out = {
    sourceKind: descriptor.sourceKind,
    role: descriptor.role,
    accessIndex: descriptor.index,
    broad: descriptor.broad,
    relation,
    memory,
    sequencing,
  };
  if (descriptor.scope != null) out.memoryScope = jsonSafe(descriptor.scope);
  if (descriptor.summary != null) {
    if (descriptor.sourceKind === 'call') {
      out.summarySource = descriptor.summary.summarySource;
      out.completeness = descriptor.summary.completeness;
    } else {
      out.determinism = descriptor.summary.determinism;
    }
  }
  return jsonSafe(out);
}
function eventKind(descriptor, relation) {
  if (descriptor.sourceKind === 'call') return 'call-clobber';
  if (descriptor.sourceKind === 'intrinsic') return 'intrinsic-clobber';
  if (descriptor.sourceKind === 'unknown-memory-effect') return 'unknown-clobber';
  if (relation === 'must') return 'memory-def';
  if (relation === 'may') return 'may-alias-clobber';
  return 'unknown-clobber';
}
function definitionRelation(kind, relation) {
  if (kind === 'unknown-clobber') return 'unknown';
  return relation;
}

export function buildMemorySsa(irFunction, cfg, options = {}) {
  assertNotAborted(options);
  functionAndCfgMatch(irFunction, cfg);
  const tick = createCounter(options, 'maxWorkItems');
  const aliasTick = createCounter(options, 'maxAliasQueries');
  const fallbackRegion = defaultUnknownRegion(irFunction.functionId);
  const { descriptors, readsByNode, writesByNode } = discoverDescriptors(irFunction, cfg, options, fallbackRegion);

  const regionById = new Map();
  for (const region of options.regions ?? []) addRegion(regionById, region);
  for (const descriptor of descriptors) for (const region of descriptor.regions) addRegion(regionById, region);
  if (!regionById.size) addRegion(regionById, fallbackRegion);
  if (regionById.size > budgetLimit(options, 'maxRegions')) fail('memory-ssa-build-budget-exceeded-maxRegions');
  const regions = [...regionById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const regionIds = regions.map((region) => region.id);

  const aliasCache = new Map();
  const queryAlias = (left, right, purpose) => {
    const key = `${left.key}\u0000${right.key}\u0000${purpose}`;
    if (aliasCache.has(key)) return aliasCache.get(key);
    aliasTick();
    let raw = 'unknown';
    if (typeof options.queryAlias === 'function') {
      raw = options.queryAlias(left.region, right.region, {
        function: irFunction,
        cfg,
        left,
        right,
        purpose,
        signal: options.signal,
      });
      if (raw && typeof raw.then === 'function') fail('memory-ssa-build-async-alias-query-unsupported');
    }
    const result = normalizeAliasResult(raw);
    aliasCache.set(key, result);
    return result;
  };
  const descriptorToRegionAlias = (descriptor, targetRegion, purpose) => combineAliasResults(
    descriptor.regions.map((sourceRegion) => queryAlias(
      { key: `${descriptor.key}\u0000${sourceRegion.id}`, region: sourceRegion, descriptor },
      { key: `region\u0000${targetRegion.id}`, region: targetRegion, descriptor: null },
      purpose,
    )),
  );
  const descriptorAlias = (leftDescriptor, rightDescriptor, purpose) => {
    const results = [];
    for (const leftRegion of leftDescriptor.regions) {
      for (const rightRegion of rightDescriptor.regions) {
        results.push(queryAlias(
          { key: `${leftDescriptor.key}\u0000${leftRegion.id}`, region: leftRegion, descriptor: leftDescriptor },
          { key: `${rightDescriptor.key}\u0000${rightRegion.id}`, region: rightRegion, descriptor: rightDescriptor },
          purpose,
        ));
      }
    }
    return combineAliasResults(results);
  };

  const eventsByNode = new Map();
  const eventById = new Map();
  for (const node of nodeOrder(irFunction, cfg, options)) {
    const writes = writesByNode.get(node.id) ?? [];
    for (const descriptor of writes) {
      for (const region of regions) {
        tick();
        const alias = descriptorToRegionAlias(descriptor, region, 'write-region-impact');
        if (alias.relation === 'no') continue;
        const kind = eventKind(descriptor, alias.relation);
        const id = entityId('memdef', {
          functionId: irFunction.functionId,
          nodeId: node.id,
          descriptorKey: descriptor.key,
          regionId: region.id,
          kind,
          relation: definitionRelation(kind, alias.relation),
        });
        const event = {
          id,
          kind,
          regionId: region.id,
          blockId: node.blockId,
          descriptor,
          aliasRelation: definitionRelation(kind, alias.relation),
          aliasProof: alias.proof,
        };
        if (!eventsByNode.has(node.id)) eventsByNode.set(node.id, []);
        eventsByNode.get(node.id).push(event);
        eventById.set(id, event);
      }
    }
  }
  for (const events of eventsByNode.values()) {
    events.sort((a, b) => a.descriptor.index - b.descriptor.index
      || a.descriptor.key.localeCompare(b.descriptor.key)
      || a.regionId.localeCompare(b.regionId)
      || a.id.localeCompare(b.id));
  }

  const entryDefinitionIds = new Map(regionIds.map((regionId) => [
    regionId,
    entityId('memdef', { functionId: irFunction.functionId, regionId, kind: 'entry' }),
  ]));
  const phiId = (blockId, regionId) => entityId('memphi', {
    functionId: irFunction.functionId,
    blockId,
    regionId,
  });
  const cfgBlockById = new Map(cfg.blocks.map((block) => [block.id, block]));
  const irBlockById = new Map(irFunction.blocks.map((block) => [block.id, block]));
  const traversal = deterministicTraversal(cfg, { signal: options.signal, includeUnreachable: true });
  const syntheticRoots = unreachableRoots(cfg, options);
  const initialState = new Map(entryDefinitionIds);
  const inStateByBlock = new Map();
  const outStateByBlock = new Map(cfg.blocks.map((block) => [block.id, cloneState(initialState)]));

  const mergeBlockState = (blockId) => {
    const block = cfgBlockById.get(blockId);
    const state = new Map();
    for (const regionId of regionIds) {
      tick();
      const candidates = block.predecessors.map((pred) => outStateByBlock.get(pred)?.get(regionId) ?? entryDefinitionIds.get(regionId));
      if (syntheticRoots.has(blockId)) candidates.push(entryDefinitionIds.get(regionId));
      if (!candidates.length) candidates.push(entryDefinitionIds.get(regionId));
      const unique = [...new Set(candidates)];
      state.set(regionId, unique.length === 1 ? unique[0] : phiId(blockId, regionId));
    }
    return state;
  };
  const applyBlockEvents = (blockId, input) => {
    const state = cloneState(input);
    const irBlock = irBlockById.get(blockId);
    for (const nodeId of irBlock.nodeIds) {
      for (const event of eventsByNode.get(nodeId) ?? []) {
        tick();
        state.set(event.regionId, event.id);
      }
    }
    return state;
  };

  const maxRounds = budgetLimit(options, 'maxRounds', Math.max(32, cfg.blocks.length * 4 + 16));
  let converged = false;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const blockId of traversal) {
      tick();
      const input = mergeBlockState(blockId);
      const output = applyBlockEvents(blockId, input);
      inStateByBlock.set(blockId, input);
      if (!mapEqual(outStateByBlock.get(blockId), output, regionIds)) {
        outStateByBlock.set(blockId, output);
        changed = true;
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) fail('memory-ssa-build-did-not-converge');
  for (const blockId of traversal) inStateByBlock.set(blockId, mergeBlockState(blockId));

  const definitions = [];
  const definitionById = new Map();
  const addDefinition = (definition) => {
    if (definitionById.has(definition.id)) return;
    definitionById.set(definition.id, definition);
    definitions.push(definition);
  };
  for (const region of regions) {
    const id = entryDefinitionIds.get(region.id);
    addDefinition({
      id,
      kind: 'entry',
      regionId: region.id,
      blockId: cfg.entryBlockId,
      previousDefinitionIds: [],
      incoming: [],
      aliasRelation: null,
      sourceEntityId: irFunction.functionId,
      origin: transformOrigin(irFunction.origin, {
        ruleId: 'initial-memory-version',
        consumedEntityIds: [irFunction.functionId],
        producedEntityIds: [id],
        proofKind: 'initial-memory-version',
      }),
      proof: { kind: 'initial-memory-version' },
    });
  }
  for (const blockId of traversal) {
    const block = cfgBlockById.get(blockId);
    for (const regionId of regionIds) {
      const expectedPhiId = phiId(blockId, regionId);
      if (inStateByBlock.get(blockId).get(regionId) !== expectedPhiId) continue;
      const incoming = block.predecessors.map((pred) => ({
        predecessorBlockId: pred,
        definitionId: outStateByBlock.get(pred).get(regionId),
      }));
      const previousDefinitionIds = syntheticRoots.has(blockId) ? [entryDefinitionIds.get(regionId)] : [];
      const baseOrigin = irBlockById.get(blockId)?.origin ?? irFunction.origin;
      addDefinition({
        id: expectedPhiId,
        kind: 'memory-phi',
        regionId,
        blockId,
        previousDefinitionIds,
        incoming,
        aliasRelation: null,
        sourceEntityId: blockId,
        origin: transformOrigin(baseOrigin, {
          ruleId: 'memory-merge',
          consumedEntityIds: [...previousDefinitionIds, ...incoming.map((item) => item.definitionId)],
          producedEntityIds: [expectedPhiId],
          proofKind: 'cfg-memory-merge',
        }),
        proof: { kind: 'cfg-memory-merge', syntheticEntry: syntheticRoots.has(blockId) },
      });
    }
  }
  for (const blockId of traversal) {
    const state = cloneState(inStateByBlock.get(blockId));
    const block = irBlockById.get(blockId);
    for (const nodeId of block.nodeIds) {
      for (const event of eventsByNode.get(nodeId) ?? []) {
        const prior = state.get(event.regionId);
        const id = event.id;
        addDefinition({
          id,
          kind: event.kind,
          regionId: event.regionId,
          blockId,
          previousDefinitionIds: prior == null ? [] : [prior],
          incoming: [],
          aliasRelation: event.aliasRelation,
          sourceEntityId: event.descriptor.node.id,
          origin: transformOrigin(event.descriptor.node.origin, {
            ruleId: event.kind,
            consumedEntityIds: [event.descriptor.node.id, ...(prior == null ? [] : [prior])],
            producedEntityIds: [id],
            proofKind: event.kind === 'memory-def' ? 'must-alias-memory-write' : 'conservative-memory-clobber',
          }),
          effectSummary: effectSummary(event.descriptor, event.aliasRelation),
          proof: {
            kind: event.kind === 'memory-def' ? 'must-alias-memory-write' : 'conservative-memory-clobber',
            aliasRelation: event.aliasRelation,
            providerProof: event.aliasProof,
          },
        });
        state.set(event.regionId, id);
      }
    }
  }

  if (definitions.length > budgetLimit(options, 'maxDefinitions')) fail('memory-ssa-build-budget-exceeded-maxDefinitions');

  const sourceDescriptorByDefinitionId = new Map([...eventById.entries()].map(([id, event]) => [id, event.descriptor]));
  const reachingForRead = (readDescriptor, startDefinitionId) => {
    let definitionId = startDefinitionId;
    const visited = new Set();
    while (definitionId != null) {
      tick();
      if (visited.has(definitionId)) return { definitionId, relation: 'unknown' };
      visited.add(definitionId);
      const definition = definitionById.get(definitionId);
      if (!definition) fail('memory-ssa-build-missing-definition');
      const sourceDescriptor = sourceDescriptorByDefinitionId.get(definitionId);
      if (!sourceDescriptor) return { definitionId, relation: 'unknown' };
      const alias = descriptorAlias(readDescriptor, sourceDescriptor, 'read-reaches-write');
      if (alias.relation !== 'no') return { definitionId, relation: alias.relation, proof: alias.proof };
      if (definition.previousDefinitionIds.length !== 1) return { definitionId, relation: 'unknown', proof: alias.proof };
      definitionId = definition.previousDefinitionIds[0];
    }
    fail('memory-ssa-build-read-without-initial-definition');
  };

  const uses = [];
  const accessMetadata = [];
  for (const blockId of traversal) {
    const state = cloneState(inStateByBlock.get(blockId));
    const block = irBlockById.get(blockId);
    for (const nodeId of block.nodeIds) {
      const nodeReads = readsByNode.get(nodeId) ?? [];
      for (const descriptor of nodeReads) {
        const targets = descriptor.broad ? regions : descriptor.regions;
        const uniqueTargets = [...new Map(targets.map((region) => [region.id, region])).values()].sort((a, b) => a.id.localeCompare(b.id));
        for (const region of uniqueTargets) {
          tick();
          const reaching = reachingForRead(descriptor, state.get(region.id));
          const id = entityId('memuse', {
            functionId: irFunction.functionId,
            nodeId,
            descriptorKey: descriptor.key,
            regionId: region.id,
          });
          uses.push({
            id,
            regionId: region.id,
            reachingDefinitionId: reaching.definitionId,
            aliasRelation: reaching.relation === 'no' ? 'unknown' : reaching.relation,
            blockId,
            sourceEntityId: descriptor.node.id,
            origin: transformOrigin(descriptor.node.origin, {
              ruleId: 'memory-use',
              consumedEntityIds: [descriptor.node.id, reaching.definitionId],
              producedEntityIds: [id],
              proofKind: 'memory-use-def-link',
            }),
          });
          accessMetadata.push({
            memorySsaEntityId: id,
            entityKind: 'use',
            nodeId,
            regionId: region.id,
            sourceKind: descriptor.sourceKind,
            role: descriptor.role,
            accessIndex: descriptor.index,
            broad: descriptor.broad,
            memory: descriptor.memory == null ? null : jsonSafe(descriptor.memory),
            sequencing: descriptor.memory == null ? null : jsonSafe({
              volatility: descriptor.memory.volatility,
              atomic: descriptor.memory.atomic,
              ordering: descriptor.memory.ordering,
              alignment: descriptor.memory.alignment,
            }),
            aliasProof: reaching.proof ?? null,
          });
        }
      }
      for (const event of eventsByNode.get(nodeId) ?? []) state.set(event.regionId, event.id);
    }
  }
  if (uses.length > budgetLimit(options, 'maxUses')) fail('memory-ssa-build-budget-exceeded-maxUses');

  for (const event of eventById.values()) {
    accessMetadata.push({
      memorySsaEntityId: event.id,
      entityKind: 'definition',
      nodeId: event.descriptor.node.id,
      regionId: event.regionId,
      sourceKind: event.descriptor.sourceKind,
      role: event.descriptor.role,
      accessIndex: event.descriptor.index,
      broad: event.descriptor.broad,
      memory: event.descriptor.memory == null ? null : jsonSafe(event.descriptor.memory),
      sequencing: event.descriptor.memory == null ? null : jsonSafe({
        volatility: event.descriptor.memory.volatility,
        atomic: event.descriptor.memory.atomic,
        ordering: event.descriptor.memory.ordering,
        alignment: event.descriptor.memory.alignment,
      }),
      aliasProof: event.aliasProof,
    });
  }

  const contract = createMemorySsaContract({
    functionId: irFunction.functionId,
    regions,
    definitions,
    uses,
  }, { signal: options.signal, budget: options.budget, cfg });
  const useDefLinks = contract.reachingDefinitionLinks.map((link) => ({ ...link }));
  const useIdsByDefinition = new Map(contract.definitions.map((definition) => [definition.id, []]));
  for (const link of useDefLinks) useIdsByDefinition.get(link.definitionId).push(link.useId);
  const defUseLinks = [...useIdsByDefinition.entries()]
    .map(([definitionId, useIds]) => ({ definitionId, useIds: useIds.sort() }))
    .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  const blockStates = traversal.map((blockId) => ({
    blockId,
    entry: blockStateArray(blockId, inStateByBlock.get(blockId)).regions,
    exit: blockStateArray(blockId, outStateByBlock.get(blockId)).regions,
  }));

  accessMetadata.sort((a, b) => a.memorySsaEntityId.localeCompare(b.memorySsaEntityId)
    || a.regionId.localeCompare(b.regionId));
  return deepFreeze({
    ...contract,
    buildVersion: MEMORY_SSA_BUILD_VERSION,
    useDefLinks,
    defUseLinks,
    accessMetadata,
    blockStates,
  });
}
