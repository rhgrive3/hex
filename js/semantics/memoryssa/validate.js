import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { createMemorySsaContract } from './contract.js';
import { MEMORY_SSA_BUILD_VERSION } from './build.js';

function fail(code) { throw new TypeError(code); }
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('memory-ssa-validate-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function hasTransformProvenance(entity) {
  return Array.isArray(entity?.origin?.transforms)
    && entity.origin.transforms.some((transform) => transform.passId === 'semantic-memoryssa');
}

export function validateMemorySsa(memorySsa, options = {}) {
  assertNotAborted(options);
  if (!memorySsa || typeof memorySsa !== 'object') fail('memory-ssa-validate-analysis-required');
  const contract = createMemorySsaContract({
    contractVersion: memorySsa.contractVersion,
    functionId: memorySsa.functionId,
    regions: memorySsa.regions,
    definitions: memorySsa.definitions,
    uses: memorySsa.uses,
  }, { signal: options.signal, budget: options.budget, cfg: options.cfg });

  if (memorySsa.buildVersion != null && memorySsa.buildVersion !== MEMORY_SSA_BUILD_VERSION) {
    fail('memory-ssa-validate-build-version-mismatch');
  }
  const built = memorySsa.buildVersion === MEMORY_SSA_BUILD_VERSION;
  if (built) {
    for (const definition of contract.definitions) {
      assertNotAborted(options);
      if (!hasTransformProvenance(definition)) fail('memory-ssa-validate-definition-provenance-missing');
    }
    for (const use of contract.uses) {
      assertNotAborted(options);
      if (!hasTransformProvenance(use)) fail('memory-ssa-validate-use-provenance-missing');
    }
  }

  const definitionIds = new Set(contract.definitions.map((definition) => definition.id));
  const useIds = new Set(contract.uses.map((use) => use.id));
  const regionIds = new Set(contract.regions.map((region) => region.id));
  if (memorySsa.useDefLinks != null) {
    const expected = contract.reachingDefinitionLinks
      .map((link) => ({ ...link }))
      .sort((a, b) => a.useId.localeCompare(b.useId));
    const actual = memorySsa.useDefLinks
      .map((link) => ({ ...link }))
      .sort((a, b) => a.useId.localeCompare(b.useId));
    if (stableStringify(actual) !== stableStringify(expected)) fail('memory-ssa-validate-use-def-index-mismatch');
  }
  if (memorySsa.defUseLinks != null) {
    const expected = new Map(contract.definitions.map((definition) => [definition.id, []]));
    for (const link of contract.reachingDefinitionLinks) expected.get(link.definitionId).push(link.useId);
    const expectedArray = [...expected.entries()]
      .map(([definitionId, ids]) => ({ definitionId, useIds: ids.sort() }))
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
    const actual = memorySsa.defUseLinks
      .map((link) => ({ definitionId: String(link.definitionId), useIds: [...link.useIds].map(String).sort() }))
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
    if (stableStringify(actual) !== stableStringify(expectedArray)) fail('memory-ssa-validate-def-use-index-mismatch');
  }

  if (memorySsa.accessMetadata != null) {
    const metadataIds = new Set();
    for (const item of memorySsa.accessMetadata) {
      assertNotAborted(options);
      if (!item || typeof item !== 'object') fail('memory-ssa-validate-invalid-access-metadata');
      const id = String(item.memorySsaEntityId ?? '');
      if (!id) fail('memory-ssa-validate-access-metadata-id-required');
      if (metadataIds.has(`${id}\u0000${item.regionId}`)) fail('memory-ssa-validate-duplicate-access-metadata');
      metadataIds.add(`${id}\u0000${item.regionId}`);
      if (!definitionIds.has(id) && !useIds.has(id)) fail('memory-ssa-validate-dangling-access-metadata');
      if (!regionIds.has(String(item.regionId))) fail('memory-ssa-validate-access-metadata-region-mismatch');
      if (item.entityKind === 'use' && !useIds.has(id)) fail('memory-ssa-validate-access-metadata-kind-mismatch');
      if (item.entityKind === 'definition' && !definitionIds.has(id)) fail('memory-ssa-validate-access-metadata-kind-mismatch');
    }
    if (built) {
      for (const use of contract.uses) {
        if (!memorySsa.accessMetadata.some((item) => item.memorySsaEntityId === use.id && item.entityKind === 'use')) {
          fail('memory-ssa-validate-use-access-metadata-missing');
        }
      }
      for (const definition of contract.definitions) {
        if (definition.kind === 'entry' || definition.kind === 'memory-phi') continue;
        if (!memorySsa.accessMetadata.some((item) => item.memorySsaEntityId === definition.id && item.entityKind === 'definition')) {
          fail('memory-ssa-validate-definition-access-metadata-missing');
        }
      }
    }
  }

  if (memorySsa.blockStates != null) {
    const blockIds = new Set(options.cfg?.blocks?.map((block) => block.id) ?? memorySsa.blockStates.map((state) => state.blockId));
    for (const state of memorySsa.blockStates) {
      assertNotAborted(options);
      if (!blockIds.has(state.blockId)) fail('memory-ssa-validate-invalid-block-state');
      for (const side of ['entry', 'exit']) {
        if (!Array.isArray(state[side])) fail('memory-ssa-validate-invalid-block-state');
        const seenRegions = new Set();
        for (const item of state[side]) {
          if (!regionIds.has(item.regionId)) fail('memory-ssa-validate-block-state-region-mismatch');
          if (!definitionIds.has(item.definitionId)) fail('memory-ssa-validate-block-state-definition-mismatch');
          if (seenRegions.has(item.regionId)) fail('memory-ssa-validate-duplicate-block-state-region');
          seenRegions.add(item.regionId);
        }
        if (seenRegions.size !== regionIds.size) fail('memory-ssa-validate-incomplete-block-state');
      }
    }
  }

  return deepFreeze({
    ...memorySsa,
    contractVersion: contract.contractVersion,
    functionId: contract.functionId,
    regions: contract.regions,
    definitions: contract.definitions,
    uses: contract.uses,
    reachingDefinitionLinks: contract.reachingDefinitionLinks,
  });
}
