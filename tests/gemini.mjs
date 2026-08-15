import assert from 'node:assert/strict';
import worker, { __test } from '../worker.js';
import { buildGeminiPayload, streamGemini } from '../js/gemini.js';

let quotaTokenSerial = 0;
const ALLOW_QUOTA = {
  getByName() {
    return {
      async acquire() { return { allowed: true, token: `gemini-test-${++quotaTokenSerial}` }; },
      async release() { return { released: true }; },
    };
  },
};
const quotaEnv = (extra = {}) => ({ ...extra, AI_QUOTA: ALLOW_QUOTA });

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  process.stdout.write('  ok  ' + name + '\n');
}

const BASE = 0x100000000n;
const baseReport = {
  identity: { startAddr: BASE, name: 'sub_100000000' },
  comprehension: null,
  callers: [{ addr: 0x100000100n, site: 0x100000008n, name: 'caller', count: 1 }],
  callees: [{ addr: 0x100000200n, site: 0x100000004n, name: 'callee', count: 1 }],
  strings: [{ addr: 0x100010000n, row: 2, text: 'Health' }],
  updates: [{
    kind: 'read-modify-write',
    store: { address: 0x10000000cn },
    location: { base: 'x0', disp: 0x20n, stack: false },
    steps: [{ op: 'sub', imm: 10n, row: 3 }],
  }],
};
const baseModel = {
  instructions: [
    { address: BASE, mnemonic: 'ldr', operands: 'w8, [x0, #0x20]' },
    { address: BASE + 4n, mnemonic: 'sub', operands: 'w8, w8, #0xa' },
    { address: BASE + 8n, mnemonic: 'str', operands: 'w8, [x0, #0x20]' },
    { address: BASE + 12n, mnemonic: 'ret', operands: '' },
  ],
  addressRefs: [],
};

function workerRequest() {
  return new Request('https://example.test/api/gemini', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: 'この関数を説明してください。',
      thinkingLevel: 'high',
      currentFunction: { address: '0x100000000', assembly: 'ret' },
    }),
  });
}

await test('Gemini payloadは現在の関数に必要な根拠だけを整形する', () => {
  const payload = buildGeminiPayload(baseReport, baseModel, 'この値はどこで書き込まれますか？', 'high');
  assert.equal(payload.currentFunction.address, '0x100000000');
  assert.match(payload.currentFunction.assembly, /ldr/);
  assert.equal(payload.callers[0].name, 'caller');
  assert.equal(payload.globals[0].offset, '32');
  assert.equal(payload.thinkingLevel, 'high');
});

await test('SSEのテキストdeltaを順序どおりにストリーミングする', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"解析"}}\n\n' +
    'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"結果"}}\n\n' +
    'event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    let text = '';
    let completed = false;
    await streamGemini({ question: 'x' }, { onText: (chunk) => { text += chunk; }, onDone: (done) => { completed = done; } });
    assert.equal(text, '解析結果');
    assert.equal(completed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('文字出力前の一時的SSE errorは1回だけ安全に再試行する', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        'event: error\ndata: {"event_type":"error","error":{"code":"service_unavailable","message":"busy"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(
      'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"復旧"}}\n\n' +
      'event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    let text = '';
    await streamGemini({ question: 'x' }, { onText: (chunk) => { text += chunk; } });
    assert.equal(calls, 2);
    assert.equal(text, '復旧');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('文字出力後のSSE errorは二重出力を避けるため再試行しない', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"途中"}}\n\n' +
      'event: error\ndata: {"event_type":"error","error":{"code":"service_unavailable","message":"busy"}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    let text = '';
    await assert.rejects(
      () => streamGemini({ question: 'x' }, { onText: (chunk) => { text += chunk; } }),
      (error) => error && error.code === 'service_unavailable',
    );
    assert.equal(calls, 1);
    assert.equal(text, '途中');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('WorkerはGETを拒否し、CORSワイルドカードを付けない', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/gemini'), { ASSETS: { fetch: () => new Response('asset') } });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

await test('WorkerはJSON Content-Type以外を拒否する', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/gemini', {
    method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' },
  }), quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }));
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'unsupported_media_type');
});

await test('Workerは不正JSONを明確に拒否する', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/gemini', {
    method: 'POST', body: '{', headers: { 'content-type': 'application/json' },
  }), quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_json');
});

await test('Workerは未設定のSecretをブラウザへ露出せずに扱う', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/gemini', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  }), { ASSETS: { fetch: () => new Response('asset') } });
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.ok(!text.includes('GEMINI_API_KEY'));
  assert.ok(!text.includes('not-exposed'));
});

await test('WorkerはGeminiのSSEを同一オリジンのクライアントへ中継する', async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (url, options) => {
    upstream = { url, options };
    return new Response('event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"ok"}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const response = await worker.fetch(workerRequest(), quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(await response.text(), 'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"ok"}}\n\n');
    assert.equal(upstream.url, 'https://generativelanguage.googleapis.com/v1/interactions');
    assert.equal(upstream.options.headers['x-goog-api-key'], 'not-exposed');
    const body = JSON.parse(upstream.options.body);
    assert.equal(body.model, 'gemini-3.7-flash');
    assert.equal(body.store, false);
    assert.equal(body.generation_config.thinking_level, 'high');
    assert.equal(body.generation_config.max_output_tokens, 65536);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('Workerは一時的503をRetry-Afterに従って再試行する', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { code: 'service_unavailable', message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return new Response('event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const response = await worker.fetch(workerRequest(), quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }));
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.match(await response.text(), /interaction\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('日次quota_exceededは無駄に再試行しない', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'daily quota' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    });
  };
  try {
    const response = await worker.fetch(workerRequest(), quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }));
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
    assert.equal((await response.json()).error.code, 'upstream_quota_exceeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('一時的rate_limit_exceededは最大3回まで再試行して停止する', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'rpm limit' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    });
  };
  try {
    const response = await worker.fetch(workerRequest(), quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }));
    assert.equal(response.status, 429);
    assert.equal(calls, 3);
    assert.equal((await response.json()).error.code, 'upstream_rate_limited');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('入力サイズ・thinking level・再試行分類を検証する', () => {
  assert.throws(() => __test.normalizeRequest({
    question: 'x', thinkingLevel: 'unsafe', currentFunction: { address: '0x1', assembly: 'ret' },
  }));
  assert.throws(() => __test.normalizeRequest({
    question: '', thinkingLevel: 'high', currentFunction: { address: '0x1', assembly: 'ret' },
  }));
  assert.equal(__test.isRetryableUpstreamFailure(503, 'service_unavailable'), true);
  assert.equal(__test.isRetryableUpstreamFailure(429, 'rate_limit_exceeded'), true);
  assert.equal(__test.isRetryableUpstreamFailure(429, 'quota_exceeded'), false);
  assert.equal(__test.isRetryableUpstreamFailure(400, 'invalid_request'), false);
  assert.equal(__test.parseRetryAfterMs('0'), 0);
});

process.stdout.write(`gemini tests: ${passed} ok\n`);
