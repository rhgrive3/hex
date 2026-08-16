import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  CHATGPT_PARENT_ORIGINS,
  CHATGPT_RPC_METHODS,
  EMBED_RPC_METHODS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
  createRpcClient,
  createRpcServer,
  sendEmbedReady,
  validateAttachEvent,
  waitForEmbedReady,
} from '../js/userscript/embed-protocol.js';

assert.equal(EMBED_PROTOCOL, 'hex-embed-v1');
assert.equal(EMBED_PROTOCOL_VERSION, 1);
assert.deepEqual([...CHATGPT_PARENT_ORIGINS], ['https://chatgpt.com', 'https://chat.openai.com']);
assert.deepEqual([...CHATGPT_RPC_METHODS], [
  'chatgpt.request', 'chatgpt.cancel', 'chatgpt.capabilities', 'chatgpt.getSelection',
  'chatgpt.setSelection', 'chatgpt.status', 'chatgpt.conversationFor',
]);
assert.ok(EMBED_RPC_METHODS.includes('ui.close'));

await testAttachValidation();
await testExplicitReadyHandshake();
await testReadyTimeoutRejectsStaleAndWrongMessages();
await testKnownRpc();
await testUnknownRpcRejection();
await testConcurrentIndependentRequests();
await testCancellationIsolation();
await testTimeout();
await testRemoteErrorSanitization();
await testDuplicateRequestId();
await testRequestIdReplayWindowPrunes();
await testStaleResponse();
await testCloseCleanup();
await testStackNeverCrossesWire();
await testArbitraryMethodCannotExecute();

console.log('userscript embed protocol: ok');

async function testAttachValidation() {
  const source = {};
  const nonce = createEmbedNonce();
  assert.match(nonce, /^[a-f0-9]{64}$/);
  const validChannel = new MessageChannel();
  const validEvent = attachEvent({ source, nonce, port: validChannel.port1 });
  const accepted = validateAttachEvent(validEvent, { expectedSource: source });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.nonce, nonce);
  assert.equal(accepted.port, validChannel.port1);

  const duplicateChannel = new MessageChannel();
  assert.deepEqual(validateAttachEvent(attachEvent({ source, nonce: createEmbedNonce(), port: duplicateChannel.port1 }), { expectedSource: source }), { ok: false, code: 'duplicate-attach' });

  await assertAttachRejected('wrong-origin', { origin: 'https://evil.invalid' });
  await assertAttachRejected('wrong-source', { source: {} }, { expectedSource: {} });
  await assertAttachRejected('wrong-protocol', { data: { protocol: 'other' } });
  await assertAttachRejected('wrong-version', { data: { version: 2 } });
  await assertAttachRejected('malformed-nonce', { data: { nonce: 'not-random' } });

  validChannel.port1.close(); validChannel.port2.close(); duplicateChannel.port1.close(); duplicateChannel.port2.close();
}

async function testExplicitReadyHandshake() {
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const parentServer = createRpcServer(channel.port1, { handlers: { 'chatgpt.status': () => ({ ready: true }) } });
  const childClient = createRpcClient(channel.port2, { timeoutMs: 200 });

  assert.equal(await noMessageWithin(channel.port2, 15), true, 'createRpcServer must not auto-send ready');
  const ready = waitForEmbedReady(channel.port1, { nonce, timeoutMs: 100 });

  channel.port2.postMessage({ ...control('wrong-protocol', 'ready'), protocol: 'other', nonce });
  channel.port2.postMessage({ ...control('stale-ready', 'ready'), nonce: createEmbedNonce() });
  const readyId = sendEmbedReady(channel.port2, { nonce });
  assert.deepEqual(await ready, { id: readyId, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce });

  assert.deepEqual(await childClient.call('chatgpt.status'), { ready: true });
  childClient.close(); parentServer.close();
}

async function testReadyTimeoutRejectsStaleAndWrongMessages() {
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const ready = waitForEmbedReady(channel.port1, { nonce, timeoutMs: 25 });
  channel.port2.start();
  channel.port2.postMessage({ ...control('stale', 'ready'), nonce: createEmbedNonce() });
  channel.port2.postMessage({ ...control('wrong-version', 'ready'), version: 2, nonce });
  channel.port2.postMessage({ ...control('wrong-method', 'not-ready'), nonce });
  await assert.rejects(ready, (error) => error?.code === 'RPC_READY_TIMEOUT');
  channel.port1.close(); channel.port2.close();
}

async function assertAttachRejected(code, patch = {}, optionPatch = {}) {
  const source = patch.source ?? {};
  const channel = new MessageChannel();
  const base = attachEvent({ source, nonce: createEmbedNonce(), port: channel.port1 });
  const event = { ...base, ...patch, data: { ...base.data, ...(patch.data || {}) } };
  const result = validateAttachEvent(event, { expectedSource: source, ...optionPatch });
  assert.deepEqual(result, { ok: false, code });
  channel.port1.close(); channel.port2.close();
}

function attachEvent({ source, nonce, port }) {
  return {
    origin: 'https://chatgpt.com', source,
    data: { type: 'hex.embed.attach', protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce },
    ports: [port],
  };
}

async function testKnownRpc() {
  const pair = rpcPair({ 'chatgpt.status': async (params) => ({ ready: true, echo: params }) });
  assert.deepEqual(await pair.client.call('chatgpt.status', { n: 7 }), { ready: true, echo: { n: 7 } });
  pair.close();
}

async function testUnknownRpcRejection() {
  const pair = rpcPair({ 'chatgpt.status': () => 'ok' });
  await assert.rejects(pair.client.call('danger.eval'), (error) => error?.code === 'RPC_METHOD_NOT_ALLOWED');
  pair.close();

  const raw = rawServer({ 'chatgpt.status': () => 'ok' });
  const responsePromise = onceMessage(raw.port);
  raw.port.postMessage(request('unknown-1', 'danger.eval'));
  const message = await responsePromise;
  assert.equal(message.kind, 'error');
  assert.equal(message.error.code, 'RPC_METHOD_NOT_ALLOWED');
  raw.close();
}

async function testConcurrentIndependentRequests() {
  const pair = rpcPair({
    'chatgpt.request': async ({ value, delay: wait }, { signal }) => {
      await sleep(wait, signal);
      return value;
    },
  });
  const results = await Promise.all([
    pair.client.call('chatgpt.request', { value: 'slow', delay: 25 }),
    pair.client.call('chatgpt.request', { value: 'fast', delay: 5 }),
  ]);
  assert.deepEqual(results, ['slow', 'fast']);
  pair.close();
}

async function testCancellationIsolation() {
  const pair = rpcPair({
    'chatgpt.request': async ({ value, delay: wait }, { signal }) => {
      await sleep(wait, signal);
      return value;
    },
  });
  const controller = new AbortController();
  const first = pair.client.call('chatgpt.request', { value: 'cancelled', delay: 100 }, { signal: controller.signal });
  const second = pair.client.call('chatgpt.request', { value: 'kept', delay: 20 });
  setTimeout(() => controller.abort('test-cancel'), 5);
  await assert.rejects(first, (error) => error?.code === 'RPC_ABORTED');
  assert.equal(await second, 'kept');
  pair.close();
}

async function testTimeout() {
  let aborted = false;
  const pair = rpcPair({
    'chatgpt.request': async (_params, { signal }) => {
      try { await sleep(1000, signal); }
      finally { aborted = signal.aborted; }
    },
  }, { timeoutMs: 20 });
  await assert.rejects(pair.client.call('chatgpt.request', {}), (error) => error?.code === 'RPC_TIMEOUT');
  await waitFor(() => aborted);
  pair.close();
}

async function testRemoteErrorSanitization() {
  const pair = rpcPair({
    'chatgpt.status': () => {
      const error = new Error('safe-message');
      error.code = 'EXPECTED_FAILURE';
      error.details = { safe: 1, stack: 'secret-stack', nested: { ok: true, cause: 'secret-cause' } };
      throw error;
    },
  });
  await assert.rejects(pair.client.call('chatgpt.status'), (error) => {
    assert.equal(error.code, 'EXPECTED_FAILURE');
    assert.equal(error.message, 'safe-message');
    assert.deepEqual({ ...error.details, nested: { ...error.details.nested } }, { safe: 1, nested: { ok: true } });
    return true;
  });
  pair.close();
}

async function testDuplicateRequestId() {
  const raw = rawServer({ 'chatgpt.request': async () => { await delay(25); return 'first'; } });
  const duplicate = request('same-id', 'chatgpt.request', { n: 1 });
  const messagesPromise = collectMessages(raw.port, 2);
  raw.port.postMessage(duplicate);
  raw.port.postMessage(duplicate);
  const messages = await messagesPromise;
  assert.ok(messages.some((message) => message.kind === 'error' && message.error.code === 'RPC_DUPLICATE_ID'));
  raw.close();
}

async function testRequestIdReplayWindowPrunes() {
  let now = 0;
  const raw = rawServer({ 'chatgpt.status': ({ value }) => value }, {
    requestIdTtlMs: 5,
    recentRequestIdLimit: 2,
    now: () => now,
  });

  assert.equal((await rawRequest(raw.port, 'old-a', 'chatgpt.status', { value: 'a' })).result, 'a');
  now = 1;
  assert.equal((await rawRequest(raw.port, 'old-b', 'chatgpt.status', { value: 'b' })).result, 'b');
  now = 2;
  assert.equal((await rawRequest(raw.port, 'old-c', 'chatgpt.status', { value: 'c' })).result, 'c');

  const duplicate = await rawRequest(raw.port, 'old-c', 'chatgpt.status', { value: 'duplicate' });
  assert.equal(duplicate.kind, 'error');
  assert.equal(duplicate.error.code, 'RPC_DUPLICATE_ID');

  const evicted = await rawRequest(raw.port, 'old-a', 'chatgpt.status', { value: 'reused-after-lru' });
  assert.equal(evicted.result, 'reused-after-lru');

  now = 20;
  const expired = await rawRequest(raw.port, 'old-c', 'chatgpt.status', { value: 'reused-after-ttl' });
  assert.equal(expired.result, 'reused-after-ttl');
  raw.close();
}

async function testStaleResponse() {
  const channel = new MessageChannel();
  const client = createRpcClient(channel.port1, { timeoutMs: 200 });
  channel.port2.start();
  channel.port2.postMessage({ ...response('stale-id', 'chatgpt.status'), result: 'stale' });
  channel.port2.addEventListener('message', (event) => {
    const message = event.data;
    if (message.kind === 'request') channel.port2.postMessage({ ...response(message.id, message.method), result: 'fresh' });
  });
  assert.equal(await client.call('chatgpt.status'), 'fresh');
  client.close(); channel.port2.close();
}

async function testCloseCleanup() {
  const pair = rpcPair({ 'chatgpt.request': async (_params, { signal }) => sleep(1000, signal) });
  const pending = pair.client.call('chatgpt.request', {});
  await delay(5);
  pair.client.close('test-close');
  await assert.rejects(pending, (error) => error?.code === 'RPC_CLOSED');
  assert.equal(pair.client.closed, true);
  pair.server.close();
}

async function testStackNeverCrossesWire() {
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('wire-safe');
      error.code = 'WIRE_SAFE';
      error.details = { stack: 'do-not-send', keep: 'yes' };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'stack-test', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.equal(message.error.code, 'WIRE_SAFE');
  assert.equal(message.error.details.keep, 'yes');
  assert.equal(Object.hasOwn(message.error, 'stack'), false);
  assert.equal(Object.hasOwn(message.error.details, 'stack'), false);
  assert.doesNotMatch(JSON.stringify(message), /do-not-send|\"stack\"/i);
  raw.close();
}

async function testArbitraryMethodCannotExecute() {
  let executed = 0;
  Object.prototype['danger.eval'] = () => { executed += 1; };
  try {
    const raw = rawServer({ 'chatgpt.status': () => 'safe' });
    const message = await rawRequest(raw.port, 'arbitrary-1', 'danger.eval');
    assert.equal(message.kind, 'error');
    assert.equal(message.error.code, 'RPC_METHOD_NOT_ALLOWED');
    assert.equal(executed, 0);
    raw.close();
  } finally {
    delete Object.prototype['danger.eval'];
  }
}

function rpcPair(handlers, options = {}) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, { handlers, ...options.server });
  const client = createRpcClient(channel.port2, { timeoutMs: options.timeoutMs ?? 200 });
  return { client, server, close() { client.close(); server.close(); } };
}

function rawServer(handlers, options = {}) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, { handlers, ...options });
  channel.port2.start();
  return { port: channel.port2, server, close() { server.close(); channel.port2.close(); } };
}

function request(id, method, params) { return { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'request', id, method, params }; }
function response(id, method) { return { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'result', id, method }; }
function control(id, method) { return { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'control', id, method }; }
function onceMessage(port) { return new Promise((resolve) => port.addEventListener('message', (event) => resolve(event.data), { once: true })); }
async function rawRequest(port, id, method, params) {
  const responsePromise = onceMessage(port);
  port.postMessage(request(id, method, params));
  return responsePromise;
}
function collectMessages(port, count) {
  return new Promise((resolve) => {
    const messages = [];
    const onMessage = (event) => {
      messages.push(event.data);
      if (messages.length >= count) { port.removeEventListener('message', onMessage); resolve(messages); }
    };
    port.addEventListener('message', onMessage);
  });
}
function noMessageWithin(port, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const onMessage = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      resolve(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      port.removeEventListener('message', onMessage);
      resolve(true);
    }, ms);
    port.addEventListener('message', onMessage);
    port.start();
  });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
}
async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('condition did not become true');
}
