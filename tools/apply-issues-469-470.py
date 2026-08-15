from pathlib import Path
import json


def once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

p = Path('worker.js')
s = p.read_text()

s = once(s,
"""const AI_RATE_WINDOW_MS = 60_000;\nconst AI_RATE_LIMIT = 30;\nconst aiRateWindows = new Map();\n""",
"""const AI_QUOTA_BINDING = 'AI_QUOTA';\n""", 'remove isolate rate state')

s = once(s,
"""  async fetch(request, env) {\n    const url = new URL(request.url);\n    if (url.pathname === '/api/ai/turn') return handleAITurn(request, env);\n    if (url.pathname === '/api/gemini') return handleGemini(request, env);""",
"""  async fetch(request, env, executionCtx) {\n    const url = new URL(request.url);\n    if (url.pathname === '/api/ai/turn') return handleAITurn(request, env);\n    if (url.pathname === '/api/gemini') return handleGemini(request, env, executionCtx);""", 'execution context')

s = once(s,
"""  if (!env.GEMINI_API_KEY) return jsonError(503, 'service_not_configured', 'The analysis service is not configured.');\n  if (!consumeRateLimit(request)) return jsonError(429, 'rate_limited', 'Too many AI turns. Please retry shortly.', { 'retry-after': '60' });\n\n  let incoming;""",
"""  if (!env.GEMINI_API_KEY) return jsonError(503, 'service_not_configured', 'The analysis service is not configured.');\n\n  let incoming;""", 'remove local turn limiter')

s = once(s,
"""  try { payload = normalizeAITurnRequest(incoming); }\n  catch (error) {\n    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);\n    return jsonError(400, 'invalid_request', 'The AI turn request is invalid.');\n  }\n\n  const upstreamAbort = new AbortController();""",
"""  try { payload = normalizeAITurnRequest(incoming); }\n  catch (error) {\n    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);\n    return jsonError(400, 'invalid_request', 'The AI turn request is invalid.');\n  }\n\n  const quota = await acquireDistributedQuota(request, env, payload.sessionId);\n  if (quota.response) return quota.response;\n  let quotaReleased = false;\n  const releaseQuota = async () => {\n    if (quotaReleased) return;\n    quotaReleased = true;\n    await releaseDistributedQuota(quota.lease);\n  };\n\n  const upstreamAbort = new AbortController();""", 'turn quota acquire')

s = once(s,
"""  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abortOnDisconnect); };""",
"""  const cleanup = async () => {\n    clearTimeout(timeout);\n    request.signal.removeEventListener('abort', abortOnDisconnect);\n    await releaseQuota();\n  };""", 'turn async cleanup')

# handleAITurn's cleanup calls are all before handleGemini begins.
turn_start = s.index('async function handleAITurn')
gemini_start = s.index('async function handleGemini', turn_start)
turn = s[turn_start:gemini_start]
turn = turn.replace('cleanup(); return ', 'await cleanup(); return ')
turn = turn.replace('  cleanup();\n  try {', '  await cleanup();\n  try {')
s = s[:turn_start] + turn + s[gemini_start:]

s = once(s,
"""async function handleGemini(request, env) {""",
"""async function handleGemini(request, env, executionCtx) {""", 'legacy execution ctx')

s = once(s,
"""  try {\n    payload = normalizeRequest(incoming);\n  } catch (error) {\n    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);\n    return jsonError(400, 'invalid_request', 'The analysis request is invalid.');\n  }\n\n  const upstreamAbort = new AbortController();""",
"""  try {\n    payload = normalizeRequest(incoming);\n  } catch (error) {\n    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);\n    return jsonError(400, 'invalid_request', 'The analysis request is invalid.');\n  }\n\n  const quota = await acquireDistributedQuota(request, env, request.headers.get('x-hex-session'));\n  if (quota.response) return quota.response;\n  let quotaReleased = false;\n  const releaseQuota = async () => {\n    if (quotaReleased) return;\n    quotaReleased = true;\n    await releaseDistributedQuota(quota.lease);\n  };\n\n  const upstreamAbort = new AbortController();""", 'legacy quota acquire')

s = once(s,
"""  const cleanup = () => {\n    clearTimeout(timeout);\n    request.signal.removeEventListener('abort', abortOnDisconnect);\n  };""",
"""  const cleanup = async () => {\n    clearTimeout(timeout);\n    request.signal.removeEventListener('abort', abortOnDisconnect);\n    await releaseQuota();\n  };""", 'legacy async cleanup')

# Replace cleanup calls only inside legacy handler before isJsonRequest.
gemini_start = s.index('async function handleGemini')
gemini_end = s.index('\nfunction isJsonRequest', gemini_start)
gemini = s[gemini_start:gemini_end]
gemini = gemini.replace('cleanup();\n        return ', 'await cleanup();\n        return ')
gemini = gemini.replace('cleanup();\n      return ', 'await cleanup();\n      return ')
gemini = gemini.replace('cleanup();\n    return ', 'await cleanup();\n    return ')
gemini = gemini.replace('cleanup();\n    ', 'await cleanup();\n    ')
# Stream lifecycle owns the quota lease until the upstream response completes/cancels.
gemini = gemini.replace(
"""  void upstream.body.pipeTo(writable, { signal: upstreamAbort.signal })\n    .catch(() => {})\n    .finally(cleanup);""",
"""  const piping = upstream.body.pipeTo(writable, { signal: upstreamAbort.signal })\n    .catch(() => {})\n    .finally(cleanup);\n  if (executionCtx && typeof executionCtx.waitUntil === 'function') executionCtx.waitUntil(piping);\n  else void piping;""")
s = s[:gemini_start] + gemini + s[gemini_end:]

# Replace the isolate-local rate limiter with a Durable Object client.
old_start = s.index('function consumeRateLimit(request) {')
old_end = s.index('\n\nfunction jsonResponse', old_start)
quota_client = r'''function quotaClientKey(request) {
  const forwarded = boundedText(request.headers.get('cf-connecting-ip'), 128).trim();
  return forwarded || 'unknown';
}

function quotaSessionId(value) {
  const text = boundedText(value, 128).trim();
  return text || 'anonymous';
}

async function acquireDistributedQuota(request, env, sessionId) {
  const binding = env && env[AI_QUOTA_BINDING];
  if (!binding || typeof binding.getByName !== 'function') {
    return {
      response: jsonError(503, 'quota_unavailable', 'AI quota enforcement is unavailable; requests are blocked fail-closed.'),
      lease: null,
    };
  }
  try {
    const stub = binding.getByName('ip:' + quotaClientKey(request));
    if (!stub || typeof stub.acquire !== 'function' || typeof stub.release !== 'function') throw new Error('invalid quota stub');
    const result = await stub.acquire({ sessionId: quotaSessionId(sessionId) });
    if (!result || result.allowed !== true) {
      const retrySeconds = Math.max(1, Math.ceil(Number(result?.retryAfterMs || 1000) / 1000));
      const code = result?.reason === 'concurrency' ? 'concurrency_limited' : 'rate_limited';
      const message = result?.reason === 'concurrency'
        ? 'Too many concurrent AI requests. Please retry shortly.'
        : 'Too many AI requests. Please retry shortly.';
      return { response: jsonError(429, code, message, { 'retry-after': String(retrySeconds) }), lease: null };
    }
    if (!result.token) throw new Error('quota lease token missing');
    return { response: null, lease: { stub, token: result.token } };
  } catch (error) {
    console.error('[ai-quota] acquire failed', { message: error?.message || String(error) });
    return {
      response: jsonError(503, 'quota_unavailable', 'AI quota enforcement is temporarily unavailable; requests are blocked fail-closed.'),
      lease: null,
    };
  }
}

async function releaseDistributedQuota(lease) {
  if (!lease?.stub || !lease.token) return;
  try { await lease.stub.release(lease.token); }
  catch (error) { console.error('[ai-quota] release failed', { message: error?.message || String(error) }); }
}'''
s = s[:old_start] + quota_client + s[old_end:]

s = once(s,
"""  normalizeRequest, normalizeAITurnRequest, normalizeAIInteraction, readLimitedText,\n  isRetryableUpstreamFailure, retryDelayMs, parseRetryAfterMs,\n};""",
"""  normalizeRequest, normalizeAITurnRequest, normalizeAIInteraction, readLimitedText,\n  isRetryableUpstreamFailure, retryDelayMs, parseRetryAfterMs,\n  acquireDistributedQuota, releaseDistributedQuota, quotaClientKey, quotaSessionId,\n};""", 'test exports')
p.write_text(s)

# Cloudflare production entrypoint + distributed binding (declarative exports).
p = Path('wrangler.jsonc')
config = json.loads(p.read_text())
config['main'] = './worker-entry.js'
config['durable_objects'] = {'bindings': [{'name': 'AI_QUOTA', 'class_name': 'AIQuota'}]}
config['exports'] = {'AIQuota': {'type': 'durable-object', 'storage': 'sqlite'}}
p.write_text(json.dumps(config, indent=2) + '\n')

# Existing worker happy-path test now supplies a quota binding and checks release.
p = Path('tests/ai-worker.mjs')
s = p.read_text()
s = once(s,
"""try {\n  const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {""",
"""try {\n  let acquired = 0, released = 0;\n  const quotaStub = {\n    async acquire() { acquired++; return { allowed: true, token: 'test-lease' }; },\n    async release(token) { assert.equal(token, 'test-lease'); released++; return { released: true }; },\n  };\n  const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {""", 'worker test quota stub')
s = once(s,
"""  }), { GEMINI_API_KEY: 'server-only', ASSETS: { fetch: () => new Response('asset') } });\n  assert.equal(response.status, 200);\n  assert.equal((await response.json()).decision.answer, 'safe answer');""",
"""  }), {\n    GEMINI_API_KEY: 'server-only',\n    AI_QUOTA: { getByName: () => quotaStub },\n    ASSETS: { fetch: () => new Response('asset') },\n  });\n  assert.equal(response.status, 200);\n  assert.equal((await response.json()).decision.answer, 'safe answer');\n  assert.equal(acquired, 1);\n  assert.equal(released, 1);""", 'worker test env')
p.write_text(s)

# Make quota/worker tests part of the dedicated AI gate.
p = Path('package.json')
data = json.loads(p.read_text())
for test in ['node tests/ai-quota.mjs', 'node tests/ai-worker.mjs']:
    if test not in data['scripts']['ai:test']:
        data['scripts']['ai:test'] = test + ' && ' + data['scripts']['ai:test']
p.write_text(json.dumps(data, indent=2) + '\n')
