import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';

let analyzed = 0;
let modelCalls = 0;
const context = {
  binaryId: 'synthetic:293000-functions',
  functionCount: 293000,
  searchFunctions: async (_query, { limit }) => Array.from({ length: limit }, (_, i) => ({ addr: BigInt(0x100000 + i * 4), name: `candidate_${i}` })),
  searchStrings: async () => [],
  analyze: async () => { analyzed++; return null; },
  addressExists: () => true,
};
const provider = {
  async nextTurn(request) {
    modelCalls++;
    if (modelCalls === 1) return { type: 'tool', tool: 'search_functions', arguments: { query: 'reward', limit: 40 } };
    return { type: 'final', answer: 'Shortlist created; semantic verification remains.', evidenceIds: request.context.recentObservations.at(-1).evidenceIds, suggestedActions: [] };
  },
};
const started = performance.now();
const result = await new AIRuntime({ context, provider, planner: false }).turn({ mode: 'agent', scope: 'binary', goal: 'find reward update' });
const elapsed = performance.now() - started;
assert.equal(result.usage.toolCalls, 1);
assert.equal(analyzed, 0, 'cheap index shortlist must precede Semantic IR');
assert.ok(result.evidence.length <= 40);
assert.ok(elapsed < 2000, `synthetic shortlist took ${elapsed}ms`);
console.log(`ai-performance: PASS (${elapsed.toFixed(1)}ms, IR functions=${analyzed}, candidates=${result.evidence.length})`);
