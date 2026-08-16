import { makeResult, nonEmptyString } from './core.mjs';

const EXPLICIT_UNKNOWN_STATES = new Set(['unknown', 'undef', 'partial', 'unsupported']);

export function verifyUnknownCase(testCase, observation) {
  const errors = [];
  const state = String(observation?.state ?? '');
  const allowed = new Set((testCase.expectedStates ?? [...EXPLICIT_UNKNOWN_STATES]).map(String));
  if (!allowed.has(state)) errors.push(`uncertainty was not explicit: expected ${[...allowed].join('|')}, got ${state || '<missing>'}`);
  if (!nonEmptyString(observation?.reason)) errors.push('explicit uncertainty reason missing');
  if (testCase.sourceEntityId != null && String(observation?.sourceEntityId ?? '') !== String(testCase.sourceEntityId)) {
    errors.push(`uncertainty source mismatch: ${testCase.sourceEntityId}`);
  }
  return makeResult(testCase.name, errors.length === 0, { errors: Object.freeze(errors), state });
}

export async function runUnknownOracle({ adapter, cases = createUnknownOracleCases() } = {}) {
  if (!adapter || typeof adapter.observeUnknown !== 'function') {
    return Object.freeze({ integrated:false, blocking:true, reason:'unknown-oracle-not-integrated', cases:Object.freeze([]), passed:0, failed:cases.length, hiddenUnknownCount:cases.length });
  }
  const results = [];
  for (const testCase of cases) {
    try {
      const observation = await adapter.observeUnknown(testCase.input, { caseName:testCase.name });
      results.push(verifyUnknownCase(testCase, observation));
    } catch (error) {
      results.push(makeResult(testCase.name, false, { errors:Object.freeze([`adapter threw: ${error?.message ?? error}`]), state:'<error>' }));
    }
  }
  const failed = results.filter((result) => !result.passed).length;
  return Object.freeze({ integrated:true, blocking:failed > 0, cases:Object.freeze(results), passed:results.length - failed, failed, hiddenUnknownCount:failed });
}

export function createUnknownOracleCases() {
  return Object.freeze([
    Object.freeze({
      name:'unsupported-semantic-operation-is-explicit',
      sourceEntityId:'unsupported-op',
      input:{ domain:'semantic-ir', operation:{ kind:'unsupported', sourceEntityId:'unsupported-op' } },
      expectedStates:['unknown','partial','unsupported'],
    }),
    Object.freeze({
      name:'undefined-scalar-read-is-explicit',
      sourceEntityId:'undefined-read',
      input:{ domain:'ssa', variableKey:'unbound', sourceEntityId:'undefined-read' },
      expectedStates:['undef','unknown'],
    }),
    Object.freeze({
      name:'unresolved-memory-write-is-explicit',
      sourceEntityId:'unknown-memory-write',
      input:{ domain:'memoryssa', operation:{ kind:'store', address:{ kind:'unknown' }, sourceEntityId:'unknown-memory-write' } },
      expectedStates:['unknown','partial'],
    }),
  ]);
}
