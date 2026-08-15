import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { ChatGPTWebProvider } from '../js/ai/provider/chatgpt-web.js';

const bridgeCalls = [], toolCalls = [];
let turn = 0;
const bridge = {
  async request(prompt, options) {
    bridgeCalls.push({ prompt, options: { sessionKey: options.sessionKey, model: options.model, reasoning: options.reasoning } });
    turn++;
    if (turn === 1) return { text: '{"type":"tool","tool":"search_strings","arguments":{"query":"reward"},"purpose":"find anchors"}', conversation: { id: 'c1', url: 'https://chatgpt.com/c/c1' } };
    const match = /"evidenceIds":\s*\[\s*"([^"]+)"/.exec(prompt);
    const id = match?.[1];
    return { text: JSON.stringify({ type: 'final', answer: 'The reward string is the deterministic anchor.', confidence: 0.6, evidenceIds: id ? [id] : [], hypothesisIds: [], suggestedActions: [], followups: [] }) };
  },
  cancel() {},
};
const provider = new ChatGPTWebProvider({ bridge });
const runtime = new AIRuntime({
  context: {
    binaryId: 'chatgpt-loop-fixture',
    searchStrings: async (query) => { toolCalls.push(query); return [{ addr: 0x5000n, text: 'reward_value' }]; },
    addressExists: () => true,
  },
  provider, planner: false,
});
const result = await runtime.turn({
  mode: 'agent', scope: 'binary', goal: 'Find the reward anchor', conversationId: 'ui-chat-A',
  provider: 'chatgpt-web', model: 'chatgpt-web/sol', reasoning: 'high',
});
assert.deepEqual(toolCalls, ['reward']);
assert.equal(bridgeCalls.length, 2);
assert.ok(bridgeCalls[0].options.sessionKey);
assert.equal(bridgeCalls[0].options.sessionKey, bridgeCalls[1].options.sessionKey);
assert.equal(bridgeCalls[0].options.model, 'chatgpt-web/sol');
assert.equal(bridgeCalls[0].options.reasoning, 'high');
assert.ok(result.evidence.length >= 1);
assert.equal(result.limits.exhausted, false);

console.log('chatgpt-web-agent-loop: ok');
