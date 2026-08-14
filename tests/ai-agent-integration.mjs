import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AIRuntime } from '../js/ai/runtime.js';

// Stable synthetic integration covers string -> xref -> function and a pinned-evidence follow-up.
const calls = [];
const context = {
  binaryId: 'integration-fixture',
  searchStrings: async (query) => { calls.push(['string', query]); return [{ addr: 0x5000n, text: 'coin_reward' }]; },
  searchFunctions: async (query) => { calls.push(['function', query]); return [{ addr: 0x1000n, name: 'applyReward' }]; },
  addressExists: (address) => ['0x1000', '0x5000'].includes(address),
};
let step = 0;
const provider = {
  async nextTurn(request) {
    step++;
    if (step === 1) return { type: 'tool', tool: 'search_strings', arguments: { query: 'coin' } };
    if (step === 2) return { type: 'tool', tool: 'search_functions', arguments: { query: 'reward' } };
    const ids = request.context.recentObservations.flatMap((item) => item.evidenceIds);
    return { type: 'final', answer: 'applyReward is the strongest lexical candidate; semantic write verification is still required.', confidence: 0.55, evidenceIds: ids, suggestedActions: [{ kind: 'open-function', target: '0x1000' }] };
  },
};
const runtime = new AIRuntime({ context, provider, planner: false });
const result = await runtime.turn({ mode: 'agent', scope: 'binary', goal: 'Locate the coin increase behavior' });
assert.deepEqual(calls.map(([kind]) => kind), ['string', 'function']);
assert.equal(result.actions[0].target, '0x1000');
const session = await runtime.sessionStore.get(result.sessionId);
session.pinnedEvidence = [result.evidence[0].id];
assert.equal(runtime.contextBroker.buildModelContext({ request: { goal: 'follow up', mode: 'chat', style: 'analyst', scope: 'auto' }, session, evidenceStore: runtime.evidenceStore }).context.pinnedEvidence.length, 1);

// The large real fixtures are opt-in for CI/nightly because opening all three performs full binary indexing.
if (process.env.HEX_AI_REAL_BINARIES === '1') {
  const { openBinary } = await import('./harness.mjs');
  for (const fixture of ['tests/battlecats', 'tests/YWP', 'tests/TsumTsum']) {
    assert.equal(fs.existsSync(fixture), true);
    const world = await openBinary(fixture, { objc: false, strings: false });
    assert.ok(world.program && world.region && typeof world.analyze === 'function', `${fixture} exposes Hex analysis APIs`);
  }
}
console.log('ai-agent-integration: PASS');
