import { canonicalAddress, deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const MEMORY_SSA_CONTRACT_VERSION = '2.0.0';
export const MEMORY_SSA_ALIAS_RELATIONS = Object.freeze(['must', 'may', 'no', 'unknown']);
export const MEMORY_REGION_KINDS = Object.freeze([
  'stack-fixed',
  'global-absolute',
  'rooted-offset',
  'tls',
  'io',
  'physical-space',
  'unknown',
]);
export const MEMORY_SSA_DEFINITION_KINDS = Object.freeze([
  'entry',
  'memory-def',
  'memory-phi',
  'may-alias-clobber',
  'unknown-clobber',
  'call-clobber',
  'intrinsic-clobber',
]);
export const MEMORY_SSA_DEFAULT_BUDGET = Object.freeze({
  maxRegions: 65536,
  maxDefinitions: 262144,
  maxUses: 1048576,
});

const ALIAS_SET = new Set(MEMORY_SSA_ALIAS_RELATIONS);
const REGION_SET = new Set(MEMORY_REGION_KINDS);
const DEF_SET = new Set(MEMORY_SSA_DEFINITION_KINDS);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
function requiredOrigin(input, code) {
  if (!Object.hasOwn(input, 'origin')) fail(code);
  return createOriginSet(input.origin);
}
function signedIntegerString(value, code) {
  try { return (typeof value === 'bigint' ? value : BigInt(value)).toString(); }
  catch { fail(code); }
}
function aliasRelation(value, code) {
  const relation = nonEmpty(value, code);
  if (!ALIAS_SET.has(relation)) fail(code);
  return relation;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('memory-ssa-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function limit(options, key) {
  if (options?.budget?.[key] == null) return MEMORY_SSA_DEFAULT_BUDGET[key];
  return positiveInteger(options.budget[key], `memory-ssa-invalid-budget-${key}`);
}

export function createMemoryRegionRef(input) {
  input = object(input, 'memory-ssa-invalid-region');
  assertAllowedKeys(input, new Set(['id','kind','functionId','binaryId','offset','address','rootEntityId','addressSpace','rootIdentity','uncertaintyIdentity','widthBits','origin','metadata']), 'memory-ssa-unexpected-region-field');
  const kind = nonEmpty(input.kind, 'memory-ssa-region-kind-required');
  if (!REGION_SET.has(kind)) fail('memory-ssa-invalid-region-kind');
  const out = {
    id: nonEmpty(input.id, 'memory-ssa-region-id-required'),
    kind,
    functionId: input.functionId == null ? null : nonEmpty(input.functionId, 'memory-ssa-invalid-region-function-id'),
    binaryId: input.binaryId == null ? null : nonEmpty(input.binaryId, 'memory-ssa-invalid-region-binary-id'),
  };
  if (out.functionId == null && out.binaryId == null) fail('memory-ssa-region-scope-required');

  if (kind === 'stack-fixed') {
    if (out.functionId == null) fail('memory-ssa-stack-region-function-required');
    out.offset = signedIntegerString(input.offset, 'memory-ssa-invalid-region-offset');
  } else if (kind === 'global-absolute') {
    if (out.binaryId == null) fail('memory-ssa-global-region-binary-required');
    out.address = canonicalAddress(input.address);
  } else if (kind === 'rooted-offset') {
    out.rootEntityId = nonEmpty(input.rootEntityId, 'memory-ssa-region-root-required');
    out.offset = signedIntegerString(input.offset ?? 0, 'memory-ssa-invalid-region-offset');
  } else if (kind === 'tls' || kind === 'io' || kind === 'physical-space') {
    out.addressSpace = nonEmpty(input.addressSpace, 'memory-ssa-region-address-space-required');
    if (input.rootIdentity != null) out.rootIdentity = jsonSafe(input.rootIdentity);
  } else if (kind === 'unknown') {
    if (input.uncertaintyIdentity == null
      || (typeof input.uncertaintyIdentity === 'string' && !input.uncertaintyIdentity.trim())) {
      fail('memory-ssa-unknown-region-identity-required');
    }
    out.uncertaintyIdentity = jsonSafe(input.uncertaintyIdentity);
  }
  if (input.widthBits != null) out.widthBits = positiveInteger(input.widthBits, 'memory-ssa-invalid-region-width');
  if (Object.hasOwn(input, 'origin')) out.origin = createOriginSet(input.origin);
  if (input.metadata != null) out.metadata = jsonSafe(input.metadata);
  return deepFreeze(out);
}

function normalizeIncoming(value) {
  return array(value ?? [], 'memory-ssa-invalid-phi-incoming')
    .map((item) => {
      item = object(item, 'memory-ssa-invalid-phi-incoming');
      assertAllowedKeys(item, new Set(['predecessorBlockId', 'definitionId']), 'memory-ssa-unexpected-phi-incoming-field');
      return {
        predecessorBlockId: nonEmpty(item.predecessorBlockId, 'memory-ssa-phi-predecessor-required'),
        definitionId: nonEmpty(item.definitionId, 'memory-ssa-phi-definition-required'),
      };
    })
    .sort((a, b) => a.predecessorBlockId.localeCompare(b.predecessorBlockId) || a.definitionId.localeCompare(b.definitionId));
}

function normalizeDefinition(input) {
  input = object(input, 'memory-ssa-invalid-definition');
  assertAllowedKeys(input, new Set(['id','kind','regionId','blockId','previousDefinitionIds','incoming','aliasRelation','sourceEntityId','origin','effectSummary','proof']), 'memory-ssa-unexpected-definition-field');
  const kind = nonEmpty(input.kind, 'memory-ssa-definition-kind-required');
  if (!DEF_SET.has(kind)) fail('memory-ssa-invalid-definition-kind');
  const previousDefinitionIds = [...new Set(
    array(input.previousDefinitionIds ?? [], 'memory-ssa-invalid-previous-definitions')
      .map((id) => nonEmpty(id, 'memory-ssa-invalid-previous-definition')),
  )].sort();
  const incoming = normalizeIncoming(input.incoming);
  if (kind === 'memory-phi' && incoming.length === 0) fail('memory-ssa-phi-incoming-required');
  if (kind !== 'memory-phi' && incoming.length !== 0) fail('memory-ssa-incoming-only-valid-for-phi');

  let relation = input.aliasRelation == null ? null : aliasRelation(input.aliasRelation, 'memory-ssa-invalid-alias-relation');
  if (kind === 'unknown-clobber') {
    relation ??= 'unknown';
    if (relation !== 'unknown') fail('memory-ssa-unknown-clobber-must-be-unknown-alias');
  }
  if (kind === 'may-alias-clobber') {
    relation ??= 'may';
    if (!['may', 'unknown'].includes(relation)) fail('memory-ssa-may-clobber-invalid-alias-relation');
  }
  if ((kind === 'call-clobber' || kind === 'intrinsic-clobber') && relation === 'no') {
    fail('memory-ssa-clobber-cannot-be-no-alias');
  }

  const out = {
    id: nonEmpty(input.id, 'memory-ssa-definition-id-required'),
    kind,
    regionId: nonEmpty(input.regionId, 'memory-ssa-definition-region-required'),
    blockId: input.blockId == null ? null : nonEmpty(input.blockId, 'memory-ssa-invalid-definition-block'),
    previousDefinitionIds,
    incoming,
    aliasRelation: relation,
    sourceEntityId: input.sourceEntityId == null ? null : nonEmpty(input.sourceEntityId, 'memory-ssa-invalid-source-entity-id'),
    origin: requiredOrigin(input, 'memory-ssa-definition-origin-required'),
  };
  if (input.effectSummary != null) out.effectSummary = jsonSafe(input.effectSummary);
  if (input.proof != null) out.proof = jsonSafe(input.proof);
  return deepFreeze(out);
}

function normalizeUse(input) {
  input = object(input, 'memory-ssa-invalid-use');
  assertAllowedKeys(input, new Set(['id','regionId','reachingDefinitionId','aliasRelation','blockId','sourceEntityId','origin']), 'memory-ssa-unexpected-use-field');
  const relation = input.aliasRelation == null ? 'must' : aliasRelation(input.aliasRelation, 'memory-ssa-invalid-alias-relation');
  if (relation === 'no') fail('memory-ssa-reaching-definition-cannot-be-no-alias');
  return deepFreeze({
    id: nonEmpty(input.id, 'memory-ssa-use-id-required'),
    regionId: nonEmpty(input.regionId, 'memory-ssa-use-region-required'),
    reachingDefinitionId: nonEmpty(input.reachingDefinitionId, 'memory-ssa-reaching-definition-required'),
    aliasRelation: relation,
    blockId: input.blockId == null ? null : nonEmpty(input.blockId, 'memory-ssa-invalid-use-block'),
    sourceEntityId: nonEmpty(input.sourceEntityId, 'memory-ssa-use-source-entity-required'),
    origin: requiredOrigin(input, 'memory-ssa-use-origin-required'),
  });
}

function cfgMap(cfg) {
  return cfg ? new Map((cfg.blocks ?? []).map((block) => [block.id, block])) : null;
}

export function createMemorySsaContract(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'memory-ssa-invalid-contract');
  assertAllowedKeys(input, new Set(['contractVersion','functionId','regions','definitions','uses']), 'memory-ssa-unexpected-contract-field');
  if (input.contractVersion != null && String(input.contractVersion) !== MEMORY_SSA_CONTRACT_VERSION) {
    fail('memory-ssa-contract-version-mismatch');
  }

  const regions = array(input.regions, 'memory-ssa-regions-required')
    .map(createMemoryRegionRef)
    .sort((a, b) => a.id.localeCompare(b.id));
  const definitions = array(input.definitions, 'memory-ssa-definitions-required')
    .map(normalizeDefinition)
    .sort((a, b) => a.id.localeCompare(b.id));
  const uses = array(input.uses, 'memory-ssa-uses-required')
    .map(normalizeUse)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (regions.length > limit(options, 'maxRegions')) fail('memory-ssa-budget-exceeded-maxRegions');
  if (definitions.length > limit(options, 'maxDefinitions')) fail('memory-ssa-budget-exceeded-maxDefinitions');
  if (uses.length > limit(options, 'maxUses')) fail('memory-ssa-budget-exceeded-maxUses');

  const regionById = new Map();
  for (const region of regions) {
    if (regionById.has(region.id)) fail('memory-ssa-duplicate-region-id');
    regionById.set(region.id, region);
  }
  const definitionById = new Map();
  for (const definition of definitions) {
    assertNotAborted(options);
    if (definitionById.has(definition.id)) fail('memory-ssa-duplicate-definition-id');
    if (!regionById.has(definition.regionId)) fail('memory-ssa-invalid-definition-region');
    definitionById.set(definition.id, definition);
  }

  const blocks = cfgMap(options.cfg);
  for (const definition of definitions) {
    if (blocks && definition.blockId != null && !blocks.has(definition.blockId)) fail('memory-ssa-invalid-definition-block');
    for (const previousId of definition.previousDefinitionIds) {
      const previous = definitionById.get(previousId);
      if (!previous) fail('memory-ssa-dangling-previous-definition');
      if (previous.regionId !== definition.regionId) fail('memory-ssa-cross-region-definition-link');
    }
    for (const incoming of definition.incoming) {
      const prior = definitionById.get(incoming.definitionId);
      if (!prior) fail('memory-ssa-dangling-phi-definition');
      if (prior.regionId !== definition.regionId) fail('memory-ssa-cross-region-definition-link');
    }
    if (definition.kind !== 'memory-phi' || !blocks) continue;
    if (definition.blockId == null) fail('memory-ssa-phi-block-required');
    const block = blocks.get(definition.blockId);
    if (!block) fail('memory-ssa-invalid-definition-block');
    const incomingPreds = definition.incoming.map((item) => item.predecessorBlockId);
    if (new Set(incomingPreds).size !== incomingPreds.length) fail('memory-ssa-duplicate-phi-predecessor');
    for (const pred of incomingPreds) {
      if (!block.predecessors.includes(pred)) fail('memory-ssa-phi-predecessor-not-in-cfg');
    }
    if (stableStringify(incomingPreds.slice().sort()) !== stableStringify(block.predecessors.slice().sort())) {
      fail('memory-ssa-phi-predecessor-set-incomplete');
    }
  }

  const useIds = new Set();
  const reachingDefinitionLinks = [];
  for (const use of uses) {
    assertNotAborted(options);
    if (useIds.has(use.id)) fail('memory-ssa-duplicate-use-id');
    useIds.add(use.id);
    if (!regionById.has(use.regionId)) fail('memory-ssa-invalid-use-region');
    const definition = definitionById.get(use.reachingDefinitionId);
    if (!definition) fail('memory-ssa-dangling-reaching-definition');
    if (definition.regionId !== use.regionId) fail('memory-ssa-cross-region-reaching-definition');
    if (blocks && use.blockId != null && !blocks.has(use.blockId)) fail('memory-ssa-invalid-use-block');
    reachingDefinitionLinks.push(deepFreeze({
      useId: use.id,
      definitionId: definition.id,
      regionId: use.regionId,
      aliasRelation: use.aliasRelation,
    }));
  }
  reachingDefinitionLinks.sort((a, b) => a.useId.localeCompare(b.useId));

  return deepFreeze({
    contractVersion: MEMORY_SSA_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'memory-ssa-function-id-required'),
    regions,
    definitions,
    uses,
    reachingDefinitionLinks,
  });
}
