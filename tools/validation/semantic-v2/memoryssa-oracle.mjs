import { asArray, makeResult } from './core.mjs';

function byId(items) {
  return new Map(asArray(items).map((item) => [String(item.id), item]));
}

function useByEntity(output) {
  return new Map(asArray(output?.uses).map((use) => [String(use.sourceEntityId), use]));
}

function definitionChainContains(definitionId, definitions, predicate, seen = new Set()) {
  const id = String(definitionId ?? '');
  if (!id || seen.has(id)) return false;
  seen.add(id);
  const definition = definitions.get(id);
  if (!definition) return false;
  if (predicate(definition)) return true;
  const previous = [
    ...asArray(definition.previousDefinitionIds),
    ...asArray(definition.incoming).map((item) => item.definitionId),
  ];
  return previous.some((prior) => definitionChainContains(prior, definitions, predicate, seen));
}

function verifyLoadExpectation(expectation, output, errors) {
  const definitions = byId(output?.definitions);
  const uses = useByEntity(output);
  const use = uses.get(String(expectation.loadSourceEntityId));
  if (!use) {
    errors.push(`missing memory use ${expectation.loadSourceEntityId}`);
    return;
  }
  const reaching = definitions.get(String(use.reachingDefinitionId));
  if (!reaching) {
    errors.push(`memory use ${expectation.loadSourceEntityId} has dangling reaching definition`);
    return;
  }
  if (expectation.regionId != null && String(use.regionId) !== String(expectation.regionId)) {
    errors.push(`memory use ${expectation.loadSourceEntityId} resolved wrong region`);
  }
  if (expectation.mustReachSourceEntityId != null && String(reaching.sourceEntityId ?? '') !== String(expectation.mustReachSourceEntityId)) {
    errors.push(`memory use ${expectation.loadSourceEntityId} did not reach ${expectation.mustReachSourceEntityId}`);
  }
  for (const stale of asArray(expectation.mustNotReachSourceEntityIds)) {
    if (String(reaching.sourceEntityId ?? '') === String(stale)) errors.push(`stale reaching-def proof survived barrier: ${stale}`);
  }
  if (asArray(expectation.requiredBarrierKinds).length) {
    const accepted = new Set(expectation.requiredBarrierKinds.map(String));
    const barrierObserved = accepted.has(String(reaching.kind))
      || definitionChainContains(reaching.id, definitions, (definition) => accepted.has(String(definition.kind)));
    if (!barrierObserved) errors.push(`memory use ${expectation.loadSourceEntityId} is not protected by required barrier ${[...accepted].join('|')}`);
  }
  if (expectation.barrierSourceEntityId != null) {
    const source = String(expectation.barrierSourceEntityId);
    const barrierObserved = String(reaching.sourceEntityId ?? '') === source
      || definitionChainContains(reaching.id, definitions, (definition) => String(definition.sourceEntityId ?? '') === source);
    if (!barrierObserved) errors.push(`memory use ${expectation.loadSourceEntityId} lost barrier source ${source}`);
  }
}

export function verifyMemorySsaCase(testCase, output) {
  const errors = [];
  for (const expectation of asArray(testCase.expected?.loads)) verifyLoadExpectation(expectation, output ?? {}, errors);
  return makeResult(testCase.name, errors.length === 0, { errors: Object.freeze(errors) });
}

export async function runMemorySsaOracle({ adapter, cases = createMemorySsaOracleCases() } = {}) {
  if (!adapter || typeof adapter.buildMemorySsa !== 'function') {
    return Object.freeze({ integrated: false, blocking: true, reason: 'memoryssa-adapter-not-integrated', cases: Object.freeze([]), passed: 0, failed: cases.length });
  }
  const results = [];
  for (const testCase of cases) {
    try {
      const output = await adapter.buildMemorySsa(testCase.program, testCase.cfg, { caseName: testCase.name });
      results.push(verifyMemorySsaCase(testCase, output));
    } catch (error) {
      results.push(makeResult(testCase.name, false, { errors: Object.freeze([`adapter threw: ${error?.message ?? error}`]) }));
    }
  }
  const failed = results.filter((result) => !result.passed).length;
  return Object.freeze({ integrated: true, blocking: failed > 0, cases: Object.freeze(results), passed: results.length - failed, failed });
}

export function createMemorySsaOracleCases() {
  const cfg = { entryBlockId: 'b0', blocks: [{ id: 'b0', predecessors: [], successors: [] }] };
  return Object.freeze([
    Object.freeze({
      name: 'known-store-reaches-load', cfg,
      program: { operations: [
        { kind: 'store', sourceEntityId: 'known-store', regionId: 'R' },
        { kind: 'load', sourceEntityId: 'load-after-known', regionId: 'R' },
      ] },
      expected: { loads: [{ loadSourceEntityId: 'load-after-known', regionId: 'R', mustReachSourceEntityId: 'known-store' }] },
    }),
    Object.freeze({
      name: 'unknown-store-kills-stale-proof', cfg,
      program: { operations: [
        { kind: 'store', sourceEntityId: 'known-store', regionId: 'R' },
        { kind: 'unknown-store', sourceEntityId: 'unknown-store', mayAliasRegionIds: ['R'] },
        { kind: 'load', sourceEntityId: 'load-after-unknown-store', regionId: 'R' },
      ] },
      expected: { loads: [{
        loadSourceEntityId: 'load-after-unknown-store', regionId: 'R',
        mustNotReachSourceEntityIds: ['known-store'], barrierSourceEntityId: 'unknown-store',
      }] },
    }),
    Object.freeze({
      name: 'unknown-call-kills-stale-proof', cfg,
      program: { operations: [
        { kind: 'store', sourceEntityId: 'known-store', regionId: 'R' },
        { kind: 'unknown-call', sourceEntityId: 'unknown-call', mayWriteRegionIds: ['R'] },
        { kind: 'load', sourceEntityId: 'load-after-unknown-call', regionId: 'R' },
      ] },
      expected: { loads: [{
        loadSourceEntityId: 'load-after-unknown-call', regionId: 'R',
        mustNotReachSourceEntityIds: ['known-store'], barrierSourceEntityId: 'unknown-call',
      }] },
    }),
    Object.freeze({
      name: 'may-alias-store-kills-stale-proof', cfg,
      program: { operations: [
        { kind: 'store', sourceEntityId: 'known-store', regionId: 'R' },
        { kind: 'may-alias-store', sourceEntityId: 'may-store', mayAliasRegionIds: ['R'] },
        { kind: 'load', sourceEntityId: 'load-after-may-store', regionId: 'R' },
      ] },
      expected: { loads: [{
        loadSourceEntityId: 'load-after-may-store', regionId: 'R',
        mustNotReachSourceEntityIds: ['known-store'], barrierSourceEntityId: 'may-store',
      }] },
    }),
  ]);
}
