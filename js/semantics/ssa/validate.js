import { stableStringify } from '../../core/identity/index.js';
import { analyzeSemanticDominance, createSemanticCfg } from '../cfg/index.js';
import { createSemanticIrFunction } from '../ir/function.js';
import { createSemanticSsaContract } from './contract.js';

const DEFAULT_MAX_WORK_ITEMS = 4194304;

function fail(code) { throw new TypeError(code); }
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function maxWorkItems(options) {
  return options?.budget?.maxWorkItems == null ? DEFAULT_MAX_WORK_ITEMS : positiveInteger(options.budget.maxWorkItems, 'semantic-ssa-invalid-budget-maxWorkItems');
}
function workCounter(options) {
  let used = 0;
  const maximum = maxWorkItems(options);
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail('semantic-ssa-budget-exceeded-maxWorkItems');
  };
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ssa-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function originHasContent(origin) {
  return origin && (origin.byteRanges?.length || origin.virtualRanges?.length || origin.instructionIds?.length
    || origin.operationIds?.length || origin.sourceLocations?.length || origin.parentEntityIds?.length || origin.transforms?.length);
}
function hasProducedTransform(entity, producedId) {
  return entity.origin?.transforms?.some((transform) => transform.passId === 'semantic-ssa'
    && transform.producedEntityIds.includes(producedId));
}
function originContains(container, required) {
  for (const key of ['byteRanges', 'virtualRanges', 'instructionIds', 'operationIds', 'sourceLocations', 'parentEntityIds']) {
    const have = new Set((container?.[key] ?? []).map((item) => stableStringify(item)));
    for (const item of required?.[key] ?? []) if (!have.has(stableStringify(item))) return false;
  }
  return true;
}
function blockSetEqual(ir, cfg) {
  return stableStringify(ir.blocks.map((block) => block.id).sort()) === stableStringify(cfg.blocks.map((block) => block.id).sort());
}
function computeExpectedPhiBlocks(variableKey, definitions, dominance, tick) {
  const reachable = new Set(dominance.reachable);
  const defBlocks = new Set(definitions
    .filter((definition) => definition.variableKey === variableKey && definition.kind !== 'phi' && definition.blockId != null && reachable.has(definition.blockId))
    .map((definition) => definition.blockId));
  const expected = new Set();
  const pending = [...defBlocks].sort();
  const queued = new Set(pending);
  while (pending.length) {
    tick();
    const blockId = pending.shift();
    for (const frontierId of dominance.dominanceFrontier[blockId] ?? []) {
      tick();
      if (!reachable.has(frontierId) || frontierId === dominance.reversePostOrder[0] || expected.has(frontierId)) continue;
      expected.add(frontierId);
      if (!defBlocks.has(frontierId) && !queued.has(frontierId)) {
        queued.add(frontierId);
        pending.push(frontierId);
        pending.sort();
      }
    }
  }
  return expected;
}

export function validateSemanticSsa(ssaInput, irInput, cfgInput, options = {}) {
  assertNotAborted(options);
  const tick = workCounter(options);
  const ir = createSemanticIrFunction(irInput, { signal: options.signal, ...(options.irOptions ?? {}) });
  const cfg = createSemanticCfg(cfgInput, { signal: options.signal, ...(options.cfgOptions ?? {}) });
  if (ir.functionId !== cfg.functionId) fail('semantic-ssa-function-mismatch');
  if (ir.entryBlockId !== cfg.entryBlockId) fail('semantic-ssa-entry-block-mismatch');
  if (!blockSetEqual(ir, cfg)) fail('semantic-ssa-block-set-mismatch');
  const entry = cfg.blocks.find((block) => block.id === cfg.entryBlockId);
  if (entry.predecessors.length) fail('semantic-ssa-entry-has-predecessors');
  const ssa = createSemanticSsaContract({
    contractVersion: ssaInput.contractVersion,
    functionId: ssaInput.functionId,
    definitions: ssaInput.definitions,
    uses: ssaInput.uses,
  }, { cfg, signal: options.signal, budget: options.budget });
  if (ssa.functionId !== ir.functionId) fail('semantic-ssa-function-mismatch');

  const dominance = analyzeSemanticDominance(cfg, { signal: options.signal, budget: { maxWorkItems: maxWorkItems(options) }, ...(options.dominanceOptions ?? {}) });
  const cfgById = new Map(cfg.blocks.map((block) => [block.id, block]));
  const irByBlock = new Map(ir.blocks.map((block) => [block.id, block]));
  const nodePosition = new Map();
  for (const block of ir.blocks) for (let index = 0; index < block.nodeIds.length; index++) { tick(); nodePosition.set(block.nodeIds[index], { blockId: block.id, index }); }
  const definitionByValue = new Map(ssa.definitions.map((definition) => [definition.valueId, definition]));

  for (const definition of ssa.definitions) {
    tick();
    if (!originHasContent(definition.origin)) fail('semantic-ssa-empty-definition-origin');
    if (!definition.proof || definition.proof.passId !== 'semantic-ssa' || !Object.hasOwn(definition.proof, 'machineType')) fail('semantic-ssa-definition-proof-required');
    if (!hasProducedTransform(definition, definition.valueId)) fail('semantic-ssa-definition-transform-required');
    if (definition.kind === 'phi') {
      if (!definition.origin.parentEntityIds.includes(definition.blockId)) fail('semantic-ssa-phi-merge-origin-required');
      for (const incoming of definition.incoming) {
        tick();
        const incomingDef = definitionByValue.get(incoming.valueId);
        if (!incomingDef) fail('semantic-ssa-dangling-phi-value-id');
        if (stableStringify(incomingDef.proof?.machineType ?? null) !== stableStringify(definition.proof.machineType ?? null)) fail('semantic-ssa-phi-type-mismatch');
        if (!originContains(definition.origin, incomingDef.origin)) fail('semantic-ssa-phi-origin-incomplete');
        const predecessor = incoming.predecessorBlockId;
        if (incomingDef.blockId == null || !(dominance.dominators[predecessor] ?? []).includes(incomingDef.blockId)) {
          fail('semantic-ssa-phi-incoming-not-dominating-predecessor');
        }
      }
    }
  }

  for (const use of ssa.uses) {
    tick();
    if (!originHasContent(use.origin)) fail('semantic-ssa-empty-use-origin');
    if (!use.proof || use.proof.passId !== 'semantic-ssa' || !Object.hasOwn(use.proof, 'machineType')) fail('semantic-ssa-use-proof-required');
    if (!hasProducedTransform(use, use.useId)) fail('semantic-ssa-use-transform-required');
    const definition = definitionByValue.get(use.valueId);
    if (!definition) fail('semantic-ssa-dangling-value-id');
    if (stableStringify(definition.proof?.machineType ?? null) !== stableStringify(use.proof.machineType ?? null)) fail('semantic-ssa-use-type-mismatch');
    if (definition.blockId == null || use.blockId == null || !(dominance.dominators[use.blockId] ?? []).includes(definition.blockId)) {
      fail('semantic-ssa-definition-does-not-dominate-use');
    }
    if (definition.blockId === use.blockId && definition.kind !== 'phi' && !['entry', 'undef'].includes(definition.kind)) {
      const defPos = nodePosition.get(definition.proof?.sourceDefinitionNodeId ?? definition.sourceEntityId);
      const usePos = nodePosition.get(use.sourceEntityId);
      if (defPos && usePos && defPos.blockId === usePos.blockId && defPos.index >= usePos.index) fail('semantic-ssa-definition-after-use');
    }
  }

  const variableKeys = [...new Set(ssa.definitions.map((definition) => definition.variableKey).filter(Boolean))].sort();
  for (const variableKey of variableKeys) {
    tick();
    const expected = [...computeExpectedPhiBlocks(variableKey, ssa.definitions, dominance, tick)].sort();
    const actual = ssa.definitions.filter((definition) => definition.kind === 'phi' && definition.variableKey === variableKey).map((definition) => definition.blockId).sort();
    if (stableStringify(expected) !== stableStringify(actual)) fail('semantic-ssa-phi-placement-mismatch');
    const typeKeys = new Set(ssa.definitions.filter((definition) => definition.variableKey === variableKey).map((definition) => stableStringify(definition.proof?.machineType ?? null)));
    if (typeKeys.size > 1) fail('semantic-ssa-variable-type-collision');
  }

  for (const definition of ssa.definitions.filter((item) => item.kind === 'phi')) {
    tick();
    const predecessors = cfgById.get(definition.blockId).predecessors;
    const incoming = definition.incoming.map((item) => item.predecessorBlockId).sort();
    if (stableStringify(predecessors) !== stableStringify(incoming)) fail('semantic-ssa-phi-predecessor-set-incomplete');
    if (!irByBlock.has(definition.blockId)) fail('semantic-ssa-phi-block-not-in-ir');
  }
  return ssa;
}

export const assertSemanticSsaValid = validateSemanticSsa;
