import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const SEMANTIC_SSA_CONTRACT_VERSION = '2.0.0';
export const SEMANTIC_SSA_DEFINITION_KINDS = Object.freeze([
  'definition',
  'phi',
  'entry',
  'unknown',
  'undef',
]);
export const SEMANTIC_SSA_DEFAULT_BUDGET = Object.freeze({
  maxDefinitions: 262144,
  maxUses: 1048576,
  maxLinks: 2097152,
});

const DEF_KINDS = new Set(SEMANTIC_SSA_DEFINITION_KINDS);

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
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ssa-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function limit(options, key) {
  if (options?.budget?.[key] == null) return SEMANTIC_SSA_DEFAULT_BUDGET[key];
  return positiveInteger(options.budget[key], `semantic-ssa-invalid-budget-${key}`);
}

function normalizeIncoming(value) {
  return array(value ?? [], 'semantic-ssa-invalid-phi-incoming')
    .map((item) => {
      item = object(item, 'semantic-ssa-invalid-phi-incoming');
      assertAllowedKeys(item, new Set(['predecessorBlockId', 'valueId']), 'semantic-ssa-unexpected-phi-incoming-field');
      return {
        predecessorBlockId: nonEmpty(item.predecessorBlockId, 'semantic-ssa-phi-predecessor-required'),
        valueId: nonEmpty(item.valueId, 'semantic-ssa-phi-value-required'),
      };
    })
    .sort((a, b) => a.predecessorBlockId.localeCompare(b.predecessorBlockId) || a.valueId.localeCompare(b.valueId));
}

function normalizeDefinition(input) {
  input = object(input, 'semantic-ssa-invalid-definition');
  assertAllowedKeys(input, new Set(['definitionId','valueId','kind','blockId','variableKey','sourceEntityId','incoming','origin','proof']), 'semantic-ssa-unexpected-definition-field');
  const kind = nonEmpty(input.kind, 'semantic-ssa-definition-kind-required');
  if (!DEF_KINDS.has(kind)) fail('semantic-ssa-invalid-definition-kind');
  const incoming = normalizeIncoming(input.incoming);
  if (kind === 'phi' && incoming.length === 0) fail('semantic-ssa-phi-incoming-required');
  if (kind !== 'phi' && incoming.length !== 0) fail('semantic-ssa-incoming-only-valid-for-phi');
  const out = {
    definitionId: nonEmpty(input.definitionId, 'semantic-ssa-definition-id-required'),
    valueId: nonEmpty(input.valueId, 'semantic-ssa-value-id-required'),
    kind,
    blockId: input.blockId == null ? null : nonEmpty(input.blockId, 'semantic-ssa-invalid-block-id'),
    variableKey: input.variableKey == null ? null : nonEmpty(input.variableKey, 'semantic-ssa-invalid-variable-key'),
    sourceEntityId: input.sourceEntityId == null ? null : nonEmpty(input.sourceEntityId, 'semantic-ssa-invalid-source-entity-id'),
    incoming,
    origin: requiredOrigin(input, 'semantic-ssa-definition-origin-required'),
  };
  if (input.proof != null) out.proof = jsonSafe(input.proof);
  return deepFreeze(out);
}

function normalizeUse(input) {
  input = object(input, 'semantic-ssa-invalid-use');
  assertAllowedKeys(input, new Set(['useId','valueId','blockId','sourceEntityId','origin','proof']), 'semantic-ssa-unexpected-use-field');
  const out = {
    useId: nonEmpty(input.useId, 'semantic-ssa-use-id-required'),
    valueId: nonEmpty(input.valueId, 'semantic-ssa-use-value-id-required'),
    blockId: input.blockId == null ? null : nonEmpty(input.blockId, 'semantic-ssa-invalid-use-block-id'),
    sourceEntityId: nonEmpty(input.sourceEntityId, 'semantic-ssa-use-source-entity-required'),
    origin: requiredOrigin(input, 'semantic-ssa-use-origin-required'),
  };
  if (input.proof != null) out.proof = jsonSafe(input.proof);
  return deepFreeze(out);
}

function cfgMaps(cfg) {
  if (!cfg) return null;
  return { blocks: new Map((cfg.blocks ?? []).map((block) => [block.id, block])) };
}

export function createSemanticSsaContract(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-ssa-invalid-contract');
  assertAllowedKeys(input, new Set(['contractVersion','functionId','definitions','uses']), 'semantic-ssa-unexpected-contract-field');
  if (input.contractVersion != null && String(input.contractVersion) !== SEMANTIC_SSA_CONTRACT_VERSION) {
    fail('semantic-ssa-contract-version-mismatch');
  }

  const definitions = array(input.definitions, 'semantic-ssa-definitions-required')
    .map(normalizeDefinition)
    .sort((a, b) => a.valueId.localeCompare(b.valueId) || a.definitionId.localeCompare(b.definitionId));
  const uses = array(input.uses, 'semantic-ssa-uses-required')
    .map(normalizeUse)
    .sort((a, b) => a.useId.localeCompare(b.useId));
  if (definitions.length > limit(options, 'maxDefinitions')) fail('semantic-ssa-budget-exceeded-maxDefinitions');
  if (uses.length > limit(options, 'maxUses')) fail('semantic-ssa-budget-exceeded-maxUses');

  const definitionByValue = new Map();
  const definitionIds = new Set();
  for (const definition of definitions) {
    assertNotAborted(options);
    if (definitionByValue.has(definition.valueId)) fail('semantic-ssa-duplicate-value-id');
    if (definitionIds.has(definition.definitionId)) fail('semantic-ssa-duplicate-definition-id');
    definitionByValue.set(definition.valueId, definition);
    definitionIds.add(definition.definitionId);
  }

  const cfgInfo = cfgMaps(options.cfg);
  const useIds = new Set();
  for (const use of uses) {
    assertNotAborted(options);
    if (useIds.has(use.useId)) fail('semantic-ssa-duplicate-use-id');
    useIds.add(use.useId);
    if (!definitionByValue.has(use.valueId)) fail('semantic-ssa-dangling-value-id');
    if (cfgInfo && use.blockId != null && !cfgInfo.blocks.has(use.blockId)) fail('semantic-ssa-invalid-use-block');
  }

  for (const definition of definitions) {
    if (cfgInfo && definition.blockId != null && !cfgInfo.blocks.has(definition.blockId)) {
      fail('semantic-ssa-invalid-definition-block');
    }
    for (const incoming of definition.incoming) {
      if (!definitionByValue.has(incoming.valueId)) fail('semantic-ssa-dangling-phi-value-id');
    }
    if (definition.kind !== 'phi' || !cfgInfo) continue;
    if (definition.blockId == null) fail('semantic-ssa-phi-block-required');
    const block = cfgInfo.blocks.get(definition.blockId);
    if (!block) fail('semantic-ssa-invalid-definition-block');
    const incomingPreds = definition.incoming.map((item) => item.predecessorBlockId);
    if (new Set(incomingPreds).size !== incomingPreds.length) fail('semantic-ssa-duplicate-phi-predecessor');
    for (const pred of incomingPreds) {
      if (!block.predecessors.includes(pred)) fail('semantic-ssa-phi-predecessor-not-in-cfg');
    }
    if (stableStringify(incomingPreds.slice().sort()) !== stableStringify(block.predecessors.slice().sort())) {
      fail('semantic-ssa-phi-predecessor-set-incomplete');
    }
  }

  const useDefLinks = uses
    .map((use) => deepFreeze({
      useId: use.useId,
      valueId: use.valueId,
      definitionId: definitionByValue.get(use.valueId).definitionId,
    }))
    .sort((a, b) => a.useId.localeCompare(b.useId));
  if (useDefLinks.length > limit(options, 'maxLinks')) fail('semantic-ssa-budget-exceeded-maxLinks');

  const usesByDefinition = new Map(definitions.map((definition) => [definition.definitionId, []]));
  for (const link of useDefLinks) usesByDefinition.get(link.definitionId).push(link.useId);
  const defUseLinks = definitions.map((definition) => deepFreeze({
    definitionId: definition.definitionId,
    valueId: definition.valueId,
    useIds: usesByDefinition.get(definition.definitionId).sort(),
  }));

  return deepFreeze({
    contractVersion: SEMANTIC_SSA_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-ssa-function-id-required'),
    definitions,
    uses,
    useDefLinks,
    defUseLinks,
  });
}
