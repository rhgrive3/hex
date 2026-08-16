import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { ChatGPTWebProvider } from '../js/ai/provider/chatgpt-web.js';
import { normalizeResponse } from '../js/ai/render/normalize.js';

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

{
  /*
   * A browser-bridge failure keeps the friendly beginner label, but the turn
   * activity — the only record a production report can quote — must still name
   * the exact guard that refused the turn instead of a bare `provider_error`.
   */
  const previousLoader = globalThis.__HEX_SECURE_LOADER__;
  globalThis.__HEX_SECURE_LOADER__ = { version: '2.0.0', buildId: '33e3b7a70d995e874c432974' };
  try {
    const failing = new ChatGPTWebProvider({
      bridge: {
        async request() {
          throw Object.assign(new Error('The submitted ChatGPT turn does not match the Hex request.'), { code: 'manual-interference', stage: 'turn-controller' });
        },
        cancel() {},
      },
    });
    const failingRuntime = new AIRuntime({
      context: { binaryId: 'chatgpt-loop-fixture', searchStrings: async () => [], addressExists: () => true },
      provider: failing, planner: false,
    });
    const failed = await failingRuntime.turn({ mode: 'chat', scope: 'binary', goal: '解析の始め方を教えて', provider: 'chatgpt-web' });
    const entry = failed.activity.find((item) => item.type === 'error');
    assert.ok(entry, 'a failed provider turn must record an error activity entry');
    assert.equal(entry.errorType, 'provider_error');
    assert.deepEqual(
      { provider: entry.provider, bridgeCode: entry.bridgeCode, bridgeStage: entry.bridgeStage, runtimeBuildId: entry.runtimeBuildId },
      { provider: 'chatgpt-web', bridgeCode: 'manual-interference', bridgeStage: 'turn-controller', runtimeBuildId: '33e3b7a70d995e874c432974' },
      'the bridge subtype and the deployed runtime must survive provider -> runtime normalization',
    );
    /* ...and survive the renderer, which is where the developer actually reads it. */
    const rendered = normalizeResponse(failed).activity.find((item) => item.error === 'provider_error');
    assert.deepEqual(rendered?.diagnostics, {
      provider: 'chatgpt-web', bridgeCode: 'manual-interference', bridgeStage: 'turn-controller', runtimeBuildId: '33e3b7a70d995e874c432974',
    }, 'the activity renderer must not erase the bridge subtype');
    assert.match(failed.answer, /AI provider を利用できませんでした/);
  } finally {
    if (previousLoader === undefined) delete globalThis.__HEX_SECURE_LOADER__;
    else globalThis.__HEX_SECURE_LOADER__ = previousLoader;
  }
}

console.log('chatgpt-web-agent-loop: ok');
