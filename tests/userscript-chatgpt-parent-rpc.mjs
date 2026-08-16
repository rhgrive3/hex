import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION, createRpcClient } from '../js/userscript/embed-protocol.js';
import { createChatGPTParentRpc } from '../js/userscript/chatgpt-parent-rpc.js';

await testRequestAndPropagation();
await testCancelIsolation();
await testMethods();
await testUnknownAndNoForwarding();
await testUnsafeResults();
await testErrorSanitization();
await testCloseCleanup();
await testFailureRecovery();
await testPrototypePollution();
console.log('userscript chatgpt parent rpc: ok');

function fakeBridge(overrides = {}) {
  return {
    request: async () => ({ text: 'ok' }),
    cancel() {},
    capabilities: async () => ({ provider: 'chatgpt-web' }),
    getSelection: () => ({ model: null, reasoning: null }),
    setSelection: async (selection) => selection,
    status: () => ({ ready: true }),
    conversationFor: (sessionKey) => sessionKey ? { id: sessionKey } : null,
    ...overrides,
  };
}

function pair(bridge, onUiClose) {
  const channel = new MessageChannel();
  const parent = createChatGPTParentRpc({ port: channel.port1, bridge, onUiClose });
  const client = createRpcClient(channel.port2, { timeoutMs: 300 });
  return { parent, client, port: channel.port2, close() { client.close(); parent.close(); } };
}

async function testRequestAndPropagation() {
  let observed;
  const p = pair(fakeBridge({ request: async (prompt, options) => { observed = { prompt, options }; return { text: 'answer', meta: [1, true, null] }; } }));
  const result = await p.client.call('chatgpt.request', { prompt: 123, timeoutMs: 456, sessionKey: 's1', model: 'm1', reasoning: 'high', ignored: { danger: true } });
  assert.deepEqual(result, { text: 'answer', meta: [1, true, null] });
  assert.equal(observed.prompt, '123');
  assert.equal(observed.options.timeoutMs, 456);
  assert.equal(observed.options.sessionKey, 's1');
  assert.equal(observed.options.model, 'm1');
  assert.equal(observed.options.reasoning, 'high');
  assert.equal(observed.options.signal instanceof AbortSignal, true);
  assert.deepEqual(Object.keys(observed.options).sort(), ['model','reasoning','sessionKey','signal','timeoutMs'].sort());
  await assert.rejects(p.client.call('chatgpt.request', { prompt: 'x', timeoutMs: Infinity }), (e) => e.code === 'RPC_INVALID_PARAMS');
  p.close();
}

async function testCancelIsolation() {
  const signals = new Map();
  const releases = new Map();
  const bridge = fakeBridge({
    request(prompt, { signal }) {
      signals.set(prompt, signal);
      return new Promise((resolve, reject) => {
        releases.set(prompt, resolve);
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    },
  });
  const p = pair(bridge);
  const controller = new AbortController();
  const a = p.client.call('chatgpt.request', { prompt: 'A' }, { signal: controller.signal });
  const b = p.client.call('chatgpt.request', { prompt: 'B' });
  await waitFor(() => signals.size === 2);
  controller.abort('only-a');
  await assert.rejects(a, (e) => e.code === 'RPC_ABORTED');
  await waitFor(() => signals.get('A')?.aborted === true);
  assert.equal(signals.get('B')?.aborted, false);
  releases.get('B')({ text: 'B-ok' });
  assert.deepEqual(await b, { text: 'B-ok' });
  p.close();
}

async function testMethods() {
  const calls = [];
  let closed = 0;
  const bridge = fakeBridge({
    cancel() { calls.push(['cancel']); },
    capabilities(options) { calls.push(['capabilities', options]); return { models: ['x'] }; },
    getSelection() { calls.push(['getSelection']); return { model: 'x', reasoning: 'high' }; },
    setSelection(selection, options) { calls.push(['setSelection', selection, options]); return selection; },
    status() { calls.push(['status']); return { ready: true, busy: false }; },
    conversationFor(key) { calls.push(['conversationFor', key]); return { id: key }; },
  });
  const p = pair(bridge, () => { closed++; });
  assert.equal(await p.client.call('chatgpt.cancel'), null);
  assert.deepEqual(await p.client.call('chatgpt.capabilities', { ignored: 1 }), { models: ['x'] });
  assert.deepEqual(await p.client.call('chatgpt.getSelection'), { model: 'x', reasoning: 'high' });
  assert.deepEqual(await p.client.call('chatgpt.setSelection', { model: 'x', reasoning: 'high', provider: 'ignored' }), { model: 'x', reasoning: 'high' });
  assert.deepEqual(await p.client.call('chatgpt.status'), { ready: true, busy: false });
  assert.deepEqual(await p.client.call('chatgpt.conversationFor', { sessionKey: 's9' }), { id: 's9' });
  assert.equal(await p.client.call('ui.close'), null);
  assert.equal(closed, 1);
  const set = calls.find((entry) => entry[0] === 'setSelection');
  assert.deepEqual(set[1], { model: 'x', reasoning: 'high' });
  assert.equal(set[2].signal instanceof AbortSignal, true);
  p.close();
}

async function testUnknownAndNoForwarding() {
  let arbitrary = 0;
  const bridge = fakeBridge();
  bridge['danger.eval'] = () => { arbitrary++; };
  const channel = new MessageChannel();
  const parent = createChatGPTParentRpc({ port: channel.port1, bridge });
  channel.port2.start();
  const response = rawRequest(channel.port2, 'u1', 'danger.eval', {});
  const message = await response;
  assert.equal(message.kind, 'error');
  assert.equal(message.error.code, 'RPC_METHOD_NOT_ALLOWED');
  assert.equal(arbitrary, 0);
  parent.close(); channel.port2.close();
}

async function testUnsafeResults() {
  for (const value of [
    { nested: { nodeType: 1, nodeName: 'DIV' } },
    () => 'nope',
  ]) {
    const p = pair(fakeBridge({ status: () => value }));
    await assert.rejects(p.client.call('chatgpt.status'), (e) => e.code === 'RPC_UNSAFE_RESULT');
    p.close();
  }
  const cyclic = {}; cyclic.self = cyclic;
  const p = pair(fakeBridge({ status: () => cyclic }));
  await assert.rejects(p.client.call('chatgpt.status'), (e) => e.code === 'RPC_UNSAFE_RESULT');
  p.close();
}

async function testErrorSanitization() {
  const bridge = fakeBridge({ status() { const e = new Error('querySelector #prompt-textarea https://host/path?token=secret'); e.code = 'BRIDGE_FAIL'; e.details = { stack: 'secret-stack', cause: 'secret-cause', cookie: 'abc' }; throw e; } });
  const channel = new MessageChannel();
  const parent = createChatGPTParentRpc({ port: channel.port1, bridge });
  channel.port2.start();
  const message = await rawRequest(channel.port2, 'e1', 'chatgpt.status', {});
  assert.equal(message.kind, 'error');
  assert.equal(message.error.code, 'BRIDGE_FAIL');
  assert.equal(message.error.message, 'ChatGPT parent bridge call failed.');
  const text = JSON.stringify(message);
  assert.doesNotMatch(text, /secret-stack|secret-cause|prompt-textarea|token=secret|cookie/i);
  assert.equal(Object.hasOwn(message.error, 'stack'), false);
  assert.equal(Object.hasOwn(message.error, 'details'), false);
  parent.close(); channel.port2.close();
}

async function testCloseCleanup() {
  let signal;
  const p = pair(fakeBridge({ request(_prompt, options) { signal = options.signal; return new Promise((_r, reject) => options.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })); } }));
  const pending = p.client.call('chatgpt.request', { prompt: 'hold' });
  await waitFor(() => signal);
  p.parent.close('done');
  await assert.rejects(pending, (e) => ['RPC_REMOTE_CLOSED','RPC_CLOSED'].includes(e.code));
  assert.equal(signal.aborted, true);
  p.client.close();
}

async function testFailureRecovery() {
  let count = 0;
  const p = pair(fakeBridge({ status() { count++; if (count === 1) throw Object.assign(new Error('first failure'), { code: 'FIRST_FAIL' }); return { ready: true }; } }));
  await assert.rejects(p.client.call('chatgpt.status'), (e) => e.code === 'FIRST_FAIL');
  assert.deepEqual(await p.client.call('chatgpt.status'), { ready: true });
  p.close();
}

async function testPrototypePollution() {
  let polluted = 0;
  Object.prototype['danger.eval'] = () => { polluted++; };
  try {
    const bridge = fakeBridge();
    const channel = new MessageChannel();
    const parent = createChatGPTParentRpc({ port: channel.port1, bridge });
    channel.port2.start();
    const message = await rawRequest(channel.port2, 'p1', 'danger.eval', {});
    assert.equal(message.error.code, 'RPC_METHOD_NOT_ALLOWED');
    assert.equal(polluted, 0);
    parent.close(); channel.port2.close();
  } finally {
    delete Object.prototype['danger.eval'];
  }
}

function rawRequest(port, id, method, params) {
  return new Promise((resolve) => {
    port.addEventListener('message', (event) => resolve(event.data), { once: true });
    port.postMessage({ protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'request', id, method, params });
  });
}
function waitFor(check, timeoutMs = 200) { const start = Date.now(); return new Promise((resolve, reject) => { const tick=()=>{ if(check())return resolve(); if(Date.now()-start>timeoutMs)return reject(new Error('wait timeout')); setTimeout(tick,1); }; tick(); }); }
