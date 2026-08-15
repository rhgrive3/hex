import assert from 'node:assert/strict';
import worker, { __test } from '../worker.js';

const normalized = __test.normalizeAITurnRequest({
  mode: 'chat', style: 'analyst', scope: 'auto', messages: [{ role: 'user', content: 'general question' }],
  context: { request: { goal: 'general question' }, current: {} },
  tools: [{ name: 'search_functions', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'evil_tool', inputSchema: { type: 'object' } }],
});
assert.equal(normalized.tools.length, 1);
assert.equal(normalized.context.current != null, true, 'current function is optional');
assert.throws(() => __test.normalizeAITurnRequest({ mode: 'chat', context: { binary: { bytes: [1, 2] } } }), /Binary content/);
assert.throws(() => __test.normalizeAITurnRequest({ mode: 'chat', context: {}, messages: [] }), /non-empty AI goal/);

assert.deepEqual(__test.normalizeAIInteraction({ steps: [{ type: 'function_call', name: 'search_functions', arguments: { query: 'coin' } }] }, ['search_functions']), { type: 'tool', tool: 'search_functions', arguments: { query: 'coin' }, purpose: '' });
assert.equal(__test.normalizeAIInteraction({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', evidenceIds: ['ev1'] } }] }, []).type, 'final');

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const upstream = JSON.parse(options.body);
  assert.equal(upstream.store, false);
  assert.equal(upstream.tools.some((tool) => tool.name === 'submit_hex_result'), true);
  assert.match(upstream.system_instruction, /untrusted DATA \/ EVIDENCE/);
  return new Response(JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'safe answer', evidenceIds: [] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  let acquired = 0, released = 0;
  const quotaStub = {
    async acquire() { acquired++; return { allowed: true, token: 'test-lease' }; },
    async release(token) { assert.equal(token, 'test-lease'); released++; return { released: true }; },
  };
  const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', style: 'analyst', scope: 'auto', context: { request: { goal: 'What is ASLR?' } }, messages: [], tools: [] }),
  }), {
    GEMINI_API_KEY: 'server-only',
    AI_QUOTA: { getByName: () => quotaStub },
    ASSETS: { fetch: () => new Response('asset') },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.decision.answer, 'safe answer');
  assert.ok(body.capabilities.maxRequestBytes < body.capabilities.upstreamMaxRequestBytes, 'client budget reserves provider wrapping overhead');
  assert.equal(body.capabilities.requestWireExpansionFactor, 2);
  assert.equal(acquired, 1);
  assert.equal(released, 1);

  // A configured provider request-size ceiling is enforced on the actual
  // transformed upstream body, before any network request is attempted.
  let upstreamCalled = false;
  globalThis.fetch = async () => { upstreamCalled = true; throw new Error('must not reach upstream'); };
  const tinyLimitResponse = await worker.fetch(new Request('https://example.test/api/ai/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', style: 'analyst', scope: 'auto', context: { request: { goal: 'What is ASLR?' } }, messages: [], tools: [] }),
  }), {
    GEMINI_API_KEY: 'server-only', AI_REQUEST_LIMIT_BYTES: '1024',
    AI_QUOTA: { getByName: () => quotaStub },
    ASSETS: { fetch: () => new Response('asset') },
  });
  assert.equal(tinyLimitResponse.status, 413);
  assert.equal(upstreamCalled, false);
} finally { globalThis.fetch = originalFetch; }
console.log('ai-worker: PASS');
