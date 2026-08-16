import { deepFreeze } from '../../core/identity/index.js';

function fail(code) { throw new TypeError(code); }
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('memory-ssa-query-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function analysisObject(memorySsa) {
  if (!memorySsa || typeof memorySsa !== 'object') fail('memory-ssa-query-analysis-required');
  return memorySsa;
}
function definitionMap(memorySsa) {
  return new Map(analysisObject(memorySsa).definitions.map((definition) => [definition.id, definition]));
}
function useMap(memorySsa) {
  return new Map(analysisObject(memorySsa).uses.map((use) => [use.id, use]));
}
function useFrom(memorySsa, useOrId) {
  if (useOrId && typeof useOrId === 'object') return useOrId;
  const use = useMap(memorySsa).get(String(useOrId));
  if (!use) fail('memory-ssa-query-use-not-found');
  return use;
}

export function getMemoryDefinition(memorySsa, definitionId) {
  const definition = definitionMap(memorySsa).get(String(definitionId));
  return definition ?? null;
}

export function getMemoryUse(memorySsa, useId) {
  return useMap(memorySsa).get(String(useId)) ?? null;
}

export function reachingMemoryDefinition(memorySsa, useOrId) {
  const use = useFrom(memorySsa, useOrId);
  const definition = definitionMap(memorySsa).get(use.reachingDefinitionId);
  if (!definition) fail('memory-ssa-query-dangling-use-def');
  return definition;
}

export function reachingConcreteStore(memorySsa, useOrId) {
  const use = useFrom(memorySsa, useOrId);
  const definition = reachingMemoryDefinition(memorySsa, use);
  if (use.aliasRelation !== 'must' || definition.kind !== 'memory-def') return null;
  return definition;
}

export function memoryUsesOfDefinition(memorySsa, definitionOrId) {
  const definitionId = typeof definitionOrId === 'object' ? definitionOrId.id : String(definitionOrId);
  const byId = useMap(memorySsa);
  const indexed = memorySsa.defUseLinks?.find((link) => link.definitionId === definitionId)?.useIds;
  const useIds = indexed ?? memorySsa.uses
    .filter((use) => use.reachingDefinitionId === definitionId)
    .map((use) => use.id)
    .sort();
  return Object.freeze(useIds.map((id) => byId.get(id)).filter(Boolean));
}

export function memoryDefinitionsForRegion(memorySsa, regionId) {
  const id = String(regionId);
  return Object.freeze(memorySsa.definitions.filter((definition) => definition.regionId === id));
}

export function memoryAccessMetadata(memorySsa, memorySsaEntityId) {
  const id = String(memorySsaEntityId);
  return memorySsa.accessMetadata?.find((item) => item.memorySsaEntityId === id) ?? null;
}

export function memoryVersionAtBlock(memorySsa, blockId, regionId, position = 'exit') {
  if (!['entry', 'exit'].includes(position)) fail('memory-ssa-query-invalid-block-position');
  const state = memorySsa.blockStates?.find((item) => item.blockId === String(blockId));
  if (!state) return null;
  const item = state[position].find((entry) => entry.regionId === String(regionId));
  return item?.definitionId ?? null;
}

export function explainMemoryPath(memorySsa, useOrId, options = {}) {
  assertNotAborted(options);
  const maximum = options.maxDefinitions == null
    ? 4096
    : positiveInteger(options.maxDefinitions, 'memory-ssa-query-invalid-max-definitions');
  const definitions = definitionMap(memorySsa);
  const use = useFrom(memorySsa, useOrId);
  const visited = new Set();
  const work = [use.reachingDefinitionId];
  const nodes = [];
  const edges = [];
  while (work.length) {
    assertNotAborted(options);
    if (visited.size >= maximum) fail('memory-ssa-query-budget-exceeded-max-definitions');
    const id = work.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const definition = definitions.get(id);
    if (!definition) fail('memory-ssa-query-dangling-definition-link');
    nodes.push(definition);
    for (const previousId of definition.previousDefinitionIds) {
      edges.push({ from: definition.id, to: previousId, kind: 'previous' });
      if (!visited.has(previousId)) work.push(previousId);
    }
    for (const incoming of definition.incoming) {
      edges.push({
        from: definition.id,
        to: incoming.definitionId,
        kind: 'phi-incoming',
        predecessorBlockId: incoming.predecessorBlockId,
      });
      if (!visited.has(incoming.definitionId)) work.push(incoming.definitionId);
    }
    work.sort();
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
    || a.kind.localeCompare(b.kind)
    || String(a.predecessorBlockId ?? '').localeCompare(String(b.predecessorBlockId ?? '')));
  return deepFreeze({ use, nodes, edges });
}
