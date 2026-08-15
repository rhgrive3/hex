import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../worker.js';
import { AI_QUOTA, acquireQuotaState, releaseQuotaState } from '../js/ai/quota.js';

// Pure quota policy: the existing 30/min IP ceiling survives restarts/isolate
// splits because it is computed from persisted state, not module memory.
{
  let state = null;
  const now = 1_000_000;
  for (let i = 0; i < AI_QUOTA.ipRateLimit; i++) {
    const acquired = acquireQuotaState(state, { now, token: `rate-${i}`, sessionId: 's1' });
    assert.equal(acquired.result.allowed, true, `request ${i + 1} should be allowed`);
    state = acquired.state;
    state = releaseQuotaState(state, `rate-${i}`, now).state;
  }
  const denied = acquireQuotaState(state, { now, token: 'rate-over', sessionId: 's1' });
  assert.equal(denied.result.allowed, false);
  assert.equal(denied.result.reason, 'rate');
  assert.ok(denied.result.retryAfterMs > 0);
}

// Per-session concurrency is stricter than the per-IP ceiling, while different
// sessions on the same IP still share the global active-request cap.
{
  let state = null;
  const now = 2_000_000;
  for (let i = 0; i < AI_QUOTA.sessionConcurrencyLimit; i++) {
    const acquired = acquireQuotaState(state, { now, token: `same-${i}`, sessionId: 'same' });
    assert.equal(acquired.result.allowed, true);
    state = acquired.state;
  }
  const sessionDenied = acquireQuotaState(state, { now, token: 'same-over', sessionId: 'same' });
  assert.equal(sessionDenied.result.allowed, false);
  assert.equal(sessionDenied.result.reason, 'concurrency');

  let n = AI_QUOTA.sessionConcurrencyLimit;
  while (n < AI_QUOTA.ipConcurrencyLimit) {
    const acquired = acquireQuotaState(state, { now, token: `other-${n}`, sessionId: `other-${n}` });
    assert.equal(acquired.result.allowed, true);
    state = acquired.state;
    n++;
  }
  const ipDenied = acquireQuotaState(state, { now, token: 'ip-over', sessionId: 'new-session' });
  assert.equal(ipDenied.result.allowed, false);
  assert.equal(ipDenied.result.reason, 'concurrency');

  const afterExpiry = acquireQuotaState(state, {
    now: now + AI_QUOTA.leaseMs + 1,
    token: 'after-expiry',
    sessionId: 'same',
  });
  assert.equal(afterExpiry.result.allowed, true, 'expired concurrency leases must self-heal after crashes');
}

function createSharedQuotaBinding() {
  const records = new Map();
  let serial = 0;
  return {
    getByName(name) {
      // A new stub object each time models independent Worker isolates talking to
      // the same Durable Object storage/state.
      return {
        async acquire({ sessionId }) {
          const key = String(name);
          const acquired = acquireQuotaState(records.get(key), {
            now: Date.now(),
            token: `lease-${++serial}`,
            sessionId,
          });
          records.set(key, acquired.state);
          return acquired.result;
        },
        async release(token) {
          const key = String(name);
          const released = releaseQuotaState(records.get(key), token, Date.now());
          records.set(key, released.state);
          return { released: released.released };
        },
      };
    },
    record(name) { return records.get(name); },
  };
}

const turnBody = (sessionId = 'shared') => JSON.stringify({
  sessionId,
  mode: 'chat', style: 'analyst', scope: 'auto',
  context: { request: { goal: 'What is ASLR?' } }, messages: [], tools: [],
});
const legacyBody = JSON.stringify({
  question: 'What is this function?', thinkingLevel: 'minimal',
  currentFunction: { address: '0x1000', assembly: 'ret' },
});
function request(path, body, ip = '203.0.113.10', sessionId = 'shared') {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      'x-hex-session': sessionId,
    },
    body,
  });
}
function envFor(binding) {
  return {
    GEMINI_API_KEY: 'server-only',
    AI_QUOTA: { getByName: (name) => binding.getByName(name) },
    ASSETS: { fetch: () => new Response('asset') },
  };
}

const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async (_url, options) => {
  upstreamCalls++;
  const accept = new Headers(options.headers).get('accept') || '';
  if (accept.includes('text/event-stream')) {
    return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok', evidenceIds: [] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  // #470 + #469 integration: two independent env/handler facades share one
  // durable quota state, and both API routes consume the same 30/min budget.
  const shared = createSharedQuotaBinding();
  const envA = envFor(shared);
  const envB = envFor(shared);
  for (let i = 0; i < AI_QUOTA.ipRateLimit; i++) {
    const isTurn = i % 2 === 0;
    const response = await worker.fetch(
      isTurn ? request('/api/ai/turn', turnBody()) : request('/api/gemini', legacyBody),
      i % 4 < 2 ? envA : envB,
    );
    assert.equal(response.status, 200, `shared request ${i + 1} should pass`);
    if (isTurn) await response.json(); else await response.text();
  }
  const over = await worker.fetch(request('/api/gemini', legacyBody), envB);
  assert.equal(over.status, 429, '31st request must be rejected across routes/isolate facades');
  assert.equal((await over.json()).error.code, 'rate_limited');
  assert.equal(upstreamCalls, AI_QUOTA.ipRateLimit, 'denied request must not reach Gemini upstream');

  const otherIp = await worker.fetch(request('/api/ai/turn', turnBody(), '203.0.113.11'), envA);
  assert.equal(otherIp.status, 200, 'a different IP has an independent quota object');
  await otherIp.json();

  // Fail closed: an accidentally missing/misconfigured binding must never fall
  // back to a process-local limiter and silently expose the server API key.
  const missing = await worker.fetch(request('/api/ai/turn', turnBody(), '203.0.113.12'), {
    GEMINI_API_KEY: 'server-only', ASSETS: { fetch: () => new Response('asset') },
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'quota_unavailable');

  const broken = await worker.fetch(request('/api/gemini', legacyBody, '203.0.113.13'), {
    GEMINI_API_KEY: 'server-only',
    AI_QUOTA: { getByName() { throw new Error('namespace unavailable'); } },
    ASSETS: { fetch: () => new Response('asset') },
  });
  assert.equal(broken.status, 503);
  assert.equal((await broken.json()).error.code, 'quota_unavailable');
} finally {
  globalThis.fetch = originalFetch;
}

// Production configuration must route through the Cloudflare-only entrypoint
// and provision exactly one SQLite-backed DO class binding.
{
  const cfg = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(cfg.main, './worker-entry.js');
  assert.deepEqual(cfg.durable_objects?.bindings, [{ name: 'AI_QUOTA', class_name: 'AIQuota' }]);
  assert.deepEqual(cfg.exports?.AIQuota, { type: 'durable-object', storage: 'sqlite' });
  const entry = fs.readFileSync(new URL('../worker-entry.js', import.meta.url), 'utf8');
  assert.match(entry, /extends DurableObject/);
  assert.match(entry, /storage\.get\(STATE_KEY\)/);
  assert.match(entry, /storage\.put\(STATE_KEY, state\)/);
}

console.log('issues #469-#470 distributed AI quota regressions PASS');
