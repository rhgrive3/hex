import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { AIError } from '../js/ai/schema.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { HypothesisStore } from '../js/ai/hypothesis.js';

function searchContext() {
  return {
    binaryId: 'fixture:1',
    currentAddress: 0x1000n,
    searchFunctions: async () => [{ addr: 0x1000n, name: 'addCoins', score: 10, reasons: ['name'] }],
    searchStrings: async () => [],
    addressExists: (address) => address === '0x1000',
  };
}

let turns = 0;
const provider = {
  async nextTurn(request) {
    turns++;
    if (turns === 1) return { type: 'tool', tool: 'search_functions', arguments: { query: 'coin', limit: 10 }, purpose: 'lexical candidates' };
    const observation = request.context.recentObservations.find((item) => item.tool === 'search_functions');
    return { type: 'final', answer: 'addCoins is the strongest indexed candidate.', confidence: 0.9, evidenceIds: observation.evidenceIds, suggestedActions: [{ kind: 'open-function', target: '0x1000' }], followups: ['verify the write'] };
  },
};
const runtime = new AIRuntime({ context: searchContext(), provider, planner: false });
const result = await runtime.turn({ mode: 'agent', style: 'analyst', scope: 'auto', goal: 'Locate coin increase behavior' });
assert.equal(result.usage.toolCalls, 1);
assert.equal(result.evidence.length > 0, true);
assert.equal(result.actions[0].target, '0x1000');
assert.equal(result.activity.some((event) => event.type === 'scope-expand'), true);

const followup = await runtime.turn({ sessionId: result.sessionId, mode: 'chat', style: 'beginner', scope: 'auto', goal: 'Explain that candidate', budget: { maxModelCalls: 1 } });
assert.equal(followup.sessionId, result.sessionId);
assert.match(followup.answer, /Hex/);

const immediate = new AIRuntime({ context: {}, planner: false, provider: { nextTurn: async () => ({ type: 'final', answer: 'General RE answer', evidenceIds: [], suggestedActions: [] }) } });
assert.equal((await immediate.turn({ mode: 'chat', goal: 'What is ASLR?' })).answer, 'General RE answer');

let invalidCalls = 0;
const invalid = new AIRuntime({ context: searchContext(), planner: false, provider: { nextTurn: async () => { invalidCalls++; return { type: 'tool', tool: 'does_not_exist', arguments: {} }; } } });
const invalidResult = await invalid.turn({ mode: 'agent', goal: 'x', budget: { maxModelCalls: 2 } });
assert.equal(invalidCalls, 2, 'invalid model output is repaired only once');
assert.equal(invalidResult.limits.reason, 'invalid_tool_call');

const loop = new AIRuntime({ context: searchContext(), planner: false, provider: { nextTurn: async () => ({ type: 'tool', tool: 'search_functions', arguments: { query: 'same' } }) } });
const loopResult = await loop.turn({ mode: 'agent', goal: 'loop', budget: { maxModelCalls: 6, maxToolCalls: 6 } });
assert.equal(loopResult.limits.reason, 'repeated-tool-loop');
assert.equal(loopResult.usage.toolCalls, 2);

const controller = new AbortController();
const cancelling = new AIRuntime({ context: {}, planner: false, provider: { nextTurn: (_request, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new AIError('cancelled', 'cancel')), { once: true })) } });
const cancelled = cancelling.turn({ mode: 'chat', goal: 'wait' }, { signal: controller.signal });
controller.abort();
assert.equal((await cancelled).limits.reason, 'cancelled');

const timed = new AIRuntime({ context: {}, planner: false, provider: { nextTurn: async () => { throw new AIError('model_timeout', 'timeout'); } } });
assert.equal((await timed.turn({ mode: 'chat', goal: 'timeout' })).limits.reason, 'model_timeout');

const hungTool = new AIRuntime({
  context: { searchFunctions: () => new Promise(() => {}) }, planner: false,
  provider: { nextTurn: async () => ({ type: 'tool', tool: 'search_functions', arguments: { query: 'hang' } }) },
});
const hungResult = await hungTool.turn({ mode: 'agent', scope: 'binary', goal: 'bounded tool', budget: { timeoutMs: 20 } });
assert.equal(hungResult.limits.reason, 'budget_exhausted');

/* A model must not turn a real verified evidence ID into a verified arbitrary
   claim. Terminal deterministic hypotheses are also immutable to model upserts. */
const truthEvidence = new EvidenceStore();
const planEvidence = truthEvidence.ingestPlan({
  best: { address: 0x1000n },
  candidates: [{
    address: 0x1000n,
    name: 'verified_candidate',
    score: 10,
    sources: ['fixture'],
    evidence: ['fixture-proof'],
    verification: { verified: true },
  }],
});
const verifiedEvidence = planEvidence.find((item) => item.kind === 'candidate-verification');
assert.ok(verifiedEvidence, 'verified candidate verdict is emitted as its own evidence record');
assert.equal(verifiedEvidence.status, 'verified');
const hypotheses = new HypothesisStore(truthEvidence);
const spoofed = hypotheses.upsert({
  id: 'model_spoof',
  claim: 'Verified evidence proves an unrelated arbitrary claim',
  status: 'verified',
  supportEvidenceIds: [verifiedEvidence.id],
});
assert.notEqual(spoofed.status, 'verified', 'model-supplied hypothesis cannot self-promote to verified');
const terminal = hypotheses.upsert({ id: 'terminal', claim: 'deterministic claim', status: 'open' });
const verifiedHypothesis = hypotheses.verify(terminal.id, [verifiedEvidence.id]);
assert.equal(verifiedHypothesis.status, 'verified');
const hijack = hypotheses.upsert({
  id: terminal.id,
  claim: 'rewritten malicious claim',
  status: 'verified',
  supportEvidenceIds: [verifiedEvidence.id],
});
assert.equal(hijack.claim, 'deterministic claim', 'model upsert cannot rewrite a terminal verified claim');
assert.equal(hijack.status, 'verified');
const fakeReject = hypotheses.upsert({ id: 'fake_reject', claim: 'model rejected this', status: 'rejected' });
assert.notEqual(fakeReject.status, 'rejected', 'model cannot create a rejected verdict without deterministic authority');

console.log('ai-runtime: PASS');
