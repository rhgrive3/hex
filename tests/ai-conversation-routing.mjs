import assert from 'node:assert/strict';
import { createAiEngine } from '../js/ai/ui/bridge.js';

const calls = [];
const app = {
  store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
  notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
};
const core = {
  provider: {
    capabilities: async () => ({ providers: [{ id: 'chatgpt-web' }] }), status: () => ({ ready: true }),
    getSelection: () => ({ model: 'chatgpt-web/sol', reasoning: 'high' }), setSelection: async (value) => value,
  },
  async turn(input) {
    calls.push({ ...input });
    const id = input.sessionId || (input.conversationId === 'A' ? 'session-A' : input.conversationId === 'B' ? 'session-B' : 'session-default');
    return { sessionId: id, answer: 'ok' };
  },
};
const engine = createAiEngine(app, { loadCore: async () => core });
const base = { question: 'test', mode: 'chat', style: 'analyst', scope: 'auto', provider: 'chatgpt-web', model: 'chatgpt-web/sol', reasoning: 'high' };
await engine.run({ ...base, conversationId: 'A' });
await engine.run({ ...base, conversationId: 'B' });
await engine.run({ ...base, conversationId: 'A' });
assert.deepEqual(calls.map((item) => [item.conversationId, item.sessionId]), [['A', null], ['B', null], ['A', 'session-A']]);
assert.equal(calls[0].provider, 'chatgpt-web'); assert.equal(calls[0].model, 'chatgpt-web/sol'); assert.equal(calls[0].reasoning, 'high');
assert.deepEqual((await engine.aiCapabilities()).providers, [{ id: 'chatgpt-web' }]);
assert.equal((await engine.aiStatus()).ready, true);
assert.deepEqual(engine.getAISelection(), { model: 'chatgpt-web/sol', reasoning: 'high' });
assert.deepEqual(await engine.setAISelection({ model: 'chatgpt-web/terra' }), { model: 'chatgpt-web/terra' });

console.log('ai-conversation-routing: ok');
