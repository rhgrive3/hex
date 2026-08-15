import assert from 'node:assert/strict';
import worker, { __test } from '../worker.js';
import { WorkerAIProvider } from '../js/ai/provider/index.js';

const normalized = __test.normalizeAITurnRequest({
  mode: 'chat', style: 'analyst', scope: 'auto', messages: [{ role: 'user', content: 'general question' }],
  context: { request: { goal: 'general question' }, current: {} },
  tools: [
    { name: 'search_functions', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'future_probe', description: 'future registry read tool', inputSchema: { type: 'object' } },
    { name: 'Bad-Tool', inputSchema: { type: 'object' } },
    { name: 'submit_hex_result', inputSchema: { type: 'object' } },
  ],
});
assert.deepEqual(normalized.tools.map((tool) => tool.name), ['search_functions', 'future_probe'], 'Worker accepts future safe Registry tools but rejects invalid/reserved names');
assert.equal(normalized.context.current != null, true, 'current function is optional');
assert.throws(() => __test.normalizeAITurnRequest({ mode: 'chat', context: { binary: { bytes: [1, 2] } } }), /Binary content/);
assert.throws(() => __test.normalizeAITurnRequest({ mode: 'chat', context: {}, messages: [] }), /non-empty AI goal/);

assert.deepEqual(__test.normalizeAIInteraction({ steps: [{ type: 'function_call', name: 'search_functions', arguments: { query: 'coin' } }] }, ['search_functions']), { type: 'tool', tool: 'search_functions', arguments: { query: 'coin' }, purpose: '' });
assert.equal(__test.normalizeAIInteraction({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', evidenceIds: ['ev1'] } }] }, []).type, 'final');

// Capability discovery is quota-free and available before the first model turn.
const capabilityResponse = await worker.fetch(new Request('https://example.test/api/ai/capabilities', { method: 'GET' }), {
  GEMINI_API_KEY: 'server-only', AI_REQUEST_LIMIT_BYTES: '100000',
});
assert.equal(capabilityResponse.status, 200);
const capabilityBody = await capabilityResponse.json();
assert.equal(capabilityBody.configured, true);
assert.ok(capabilityBody.capabilities.maxRequestBytes < capabilityBody.capabilities.upstreamMaxRequestBytes);

let capabilityFetches = 0;
const provider = new WorkerAIProvider({
  fetchImpl: async (_url, options) => {
    capabilityFetches++;
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ capabilities: { provider: 'gemini', contextTokens: 100000, maxOutputTokens: 4096, maxTools: 7, maxRequestBytes: 24000 } }), { status: 200 });
  },
});
await provider.prepareCapabilities();
await provider.prepareCapabilities();
assert.equal(capabilityFetches, 1, 'provider capability preflight is cached');
assert.equal(provider.getCapabilities().maxRequestBytes, 24000);
assert.equal(provider.getCapabilities().maxTools, 7);

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
