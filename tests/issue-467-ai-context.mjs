import assert from 'node:assert/strict';
import worker, { __test } from '../worker.js';
import { buildGeminiPayload } from '../js/gemini.js';

const BASE = 0x100000000n;
const report = {
  identity: { startAddr: BASE, name: 'long_function' },
  callers: [], callees: [], strings: [], updates: [], comprehension: null,
};

function longModel(count) {
  return {
    instructions: Array.from({ length: count }, (_, row) => ({
      row,
      address: BASE + BigInt(row * 4),
      mnemonic: row === count - 1 ? 'ret' : 'add',
      operands: row === count - 1 ? '' : 'x0, x0, #1',
    })),
    addressRefs: [],
  };
}

{
  const payload = buildGeminiPayload(report, longModel(500), 'この関数全体を説明して', 'high');
  assert.equal(payload.currentFunction.assemblyMeta.totalInstructions, 500);
  assert.equal(payload.currentFunction.assemblyMeta.includedInstructions, 360);
  assert.equal(payload.currentFunction.assemblyMeta.startRow, 0);
  assert.equal(payload.currentFunction.assemblyMeta.endRow, 359);
  assert.equal(payload.currentFunction.assemblyMeta.omittedInstructions, 140);
  assert.equal(payload.currentFunction.assemblyMeta.truncated, true);
  assert.equal(payload.currentFunction.assemblyMeta.selection, 'head');
  assert.match(payload.currentFunction.assembly, /^\/\/ \[Hex context incomplete: showing 360 of 500 instructions;/);
  assert.ok(!payload.currentFunction.assembly.includes((BASE + 4n * 499n).toString(16).toUpperCase()), 'omitted tail must not appear in the bounded text');

  const normalized = __test.normalizeRequest(payload);
  assert.deepEqual(normalized.context.currentFunction.assemblyMeta, payload.currentFunction.assemblyMeta,
    'worker normalization must preserve completeness metadata sent to Gemini');
}

{
  const payload = buildGeminiPayload(report, longModel(4), '説明', 'medium');
  assert.equal(payload.currentFunction.assemblyMeta.totalInstructions, 4);
  assert.equal(payload.currentFunction.assemblyMeta.includedInstructions, 4);
  assert.equal(payload.currentFunction.assemblyMeta.truncated, false);
  assert.equal(payload.currentFunction.assemblyMeta.omittedInstructions, 0);
  assert.doesNotMatch(payload.currentFunction.assembly, /Hex context incomplete/);
}

{
  const payload = buildGeminiPayload(report, longModel(500), '説明', 'high');
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response('event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const quotaStub = {
      async acquire() { return { allowed: true, token: 'issue-467-test-lease' }; },
      async release() { return { released: true }; },
    };
    const response = await worker.fetch(new Request('https://example.test/api/gemini', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }), {
      GEMINI_API_KEY: 'test-key',
      AI_QUOTA: { getByName: () => quotaStub },
      ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.match(upstreamBody.system_instruction, /assemblyMeta\.truncated/);
    const modelContext = JSON.parse(upstreamBody.input);
    assert.equal(modelContext.currentFunction.assemblyMeta.truncated, true);
    assert.equal(modelContext.currentFunction.assemblyMeta.totalInstructions, 500);
    assert.equal(modelContext.currentFunction.assemblyMeta.includedInstructions, 360);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('issue #467 AI assembly completeness regressions PASS');
