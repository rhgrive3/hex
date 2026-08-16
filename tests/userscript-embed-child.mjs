import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
  createRpcServer,
} from '../js/userscript/embed-protocol.js';
import { EMBED_BOOTSTRAP_TYPE } from '../js/userscript/embed-bootstrap.js';
import {
  EMBED_SAFE_STATUS,
  createEmbedBridgeProxy,
  isPlainData,
} from '../js/userscript/embed-bridge-proxy.js';
import {
  EMBED_PATH,
  PROTECTED_RUNTIME_CONTEXT,
  classifyProtectedRuntime,
  installCanonicalCss,
  startEmbedChildRuntime,
  waitForEmbedParentAttach,
} from '../js/userscript/embed-child.js';

const protectedEntrySource = await readFile(new URL('../js/userscript/protected-entry.js', import.meta.url), 'utf8');
const entrySource = await readFile(new URL('../js/userscript/entry.js', import.meta.url), 'utf8');
const childSource = await readFile(new URL('../js/userscript/embed-child.js', import.meta.url), 'utf8');
const opaqueEntrySource = await readFile(new URL('../js/userscript/opaque-embed-entry.js', import.meta.url), 'utf8');

await testContextClassification();
await testAttachAnnouncementAndValidation();
await testAttachGuards();
await testRpcProxyContract();
await testSyncCaches();
await testCancellation();
await testPlainDataBoundary();
await testReadyOrdering();
await testFailedAppDoesNotSendReady();
await testDirectEmbedFailsBounded();
testRuntimeResponsibilityBoundaries();

console.log('userscript embed child: ok');

async function testContextClassification() {
  const worker = 'https://ida.rhgrive.workers.dev';
  assert.equal(classifyProtectedRuntime({
    location: { origin: 'https://chatgpt.com', pathname: '/' }, apiOrigin: worker, window: fakeWindow(),
  }), PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT);
  assert.equal(classifyProtectedRuntime({
    location: { origin: 'https://chat.openai.com', pathname: '/' }, apiOrigin: worker, window: fakeWindow(),
  }), PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT);
  const framed = fakeWindow({ parent: {} });
  assert.equal(classifyProtectedRuntime({
    location: { origin: worker, pathname: EMBED_PATH }, apiOrigin: worker, window: framed,
  }), PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT);
  assert.equal(classifyProtectedRuntime({
    location: { origin: worker, pathname: '/embed/other' }, apiOrigin: worker, window: framed,
  }), PROTECTED_RUNTIME_CONTEXT.STANDALONE);
}

async function testAttachAnnouncementAndValidation() {
  const parentCalls = [];
  const parent = { postMessage(data, targetOrigin) { parentCalls.push({ data, targetOrigin }); } };
  const window = fakeWindow({ parent });
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const location = locationForGeneration(7);
  const pending = waitForEmbedParentAttach({ window, location, expectedParent: parent, timeoutMs: 100 });

  assert.equal(parentCalls.length, 2, 'child announces only after its attach listener exists');
  assert.ok(parentCalls.every((call) => call.data.type === EMBED_BOOTSTRAP_TYPE));
  assert.deepEqual(parentCalls.map((call) => call.targetOrigin), ['https://chatgpt.com', 'https://chat.openai.com']);

  window.dispatchMessage(attachEvent({ source: parent, nonce, port: channel.port1, generation: '6' }));
  await delay(5);
  window.dispatchMessage(attachEvent({ source: parent, nonce, port: channel.port1, generation: '7' }));
  const result = await pending;
  assert.equal(result.nonce, nonce);
  assert.equal(result.generation, '7');
  assert.equal(result.port, channel.port1);
  channel.port1.close(); channel.port2.close();
}

async function testAttachGuards() {
  await ignoredAttach({ origin: 'https://evil.invalid' });
  await ignoredAttach({ source: {} });

  for (const patch of [{ protocol: 'wrong' }, { version: 2 }]) {
    const parent = { postMessage() {} };
    const window = fakeWindow({ parent });
    const channel = new MessageChannel();
    const event = attachEvent({ source: parent, nonce: createEmbedNonce(), port: channel.port1, generation: '9' });
    const pending = waitForEmbedParentAttach({ window, location: locationForGeneration(9), expectedParent: parent, timeoutMs: 100 });
    window.dispatchMessage({ ...event, data: { ...event.data, ...patch } });
    await assert.rejects(pending, /protocol\/version mismatch/);
    channel.port1.close(); channel.port2.close();
  }

  const parent = { postMessage() {} };
  const window = fakeWindow({ parent });
  await assert.rejects(waitForEmbedParentAttach({
    window, location: locationForGeneration(10), expectedParent: parent, timeoutMs: 10,
  }), /attach timeout/);
}

async function ignoredAttach(patch) {
  const parent = { postMessage() {} };
  const window = fakeWindow({ parent });
  const channel = new MessageChannel();
  const base = attachEvent({ source: parent, nonce: createEmbedNonce(), port: channel.port1, generation: '8' });
  const pending = waitForEmbedParentAttach({ window, location: locationForGeneration(8), expectedParent: parent, timeoutMs: 12 });
  window.dispatchMessage({ ...base, ...patch });
  await assert.rejects(pending, /attach timeout/);
  channel.port1.close(); channel.port2.close();
}

async function testRpcProxyContract() {
  let requestParams;
  let requestSignal;
  const pair = proxyPair({
    'chatgpt.request': (params, context) => { requestParams = params; requestSignal = context.signal; return { text: 'ok', conversation: 'conv-1', selection: { model: 'm1', reasoning: 'high' } }; },
    'chatgpt.capabilities': () => ({ provider: 'chatgpt-web' }),
    'chatgpt.setSelection': (value) => value,
    'chatgpt.conversationFor': ({ sessionKey }) => `bound:${sessionKey}`,
  });
  const result = await pair.proxy.request('hello', { timeoutMs: 110000, sessionKey: 's1', model: 'm1', reasoning: 'high' });
  assert.equal(result.text, 'ok');
  assert.deepEqual(requestParams, { prompt: 'hello', timeoutMs: 110000, sessionKey: 's1', model: 'm1', reasoning: 'high' });
  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(Object.hasOwn(requestParams, 'signal'), false);
  assert.deepEqual(await pair.proxy.capabilities(), { provider: 'chatgpt-web' });
  const selected = await pair.proxy.setSelection({ provider: 'ignored', model: 'm2', reasoning: 'medium' });
  assert.deepEqual(selected, { model: 'm2', reasoning: 'medium' });
  assert.equal(pair.proxy.conversationFor('new'), null);
  await waitFor(() => pair.proxy.conversationFor('new') === 'bound:new');
  pair.close();
}

async function testSyncCaches() {
  const selection = { model: 'gpt-5', reasoning: 'high' };
  const pair = proxyPair({
    'chatgpt.status': () => ({ ready: true, busy: true, selection }),
    'chatgpt.getSelection': () => selection,
  });
  assert.deepEqual(pair.proxy.status(), { ...EMBED_SAFE_STATUS });
  assert.equal(pair.proxy.getSelection(), null);
  assert.equal(pair.proxy.conversationFor('missing'), null);
  await pair.proxy.refresh({ timeoutMs: 100 });
  assert.equal(pair.proxy.status().ready, true);
  assert.deepEqual(pair.proxy.getSelection(), selection);
  pair.close();
}

async function testCancellation() {
  let parentAborted = false;
  let explicitCancel = 0;
  const pair = proxyPair({
    'chatgpt.request': (_params, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { parentAborted = true; reject(new Error('aborted')); }, { once: true });
    }),
    'chatgpt.cancel': () => { explicitCancel++; return null; },
  });
  const controller = new AbortController();
  const pending = pair.proxy.request('cancel', { signal: controller.signal });
  controller.abort('stop');
  await assert.rejects(pending, (error) => error?.code === 'RPC_ABORTED');
  await waitFor(() => parentAborted);

  const second = pair.proxy.request('cancel-2');
  await delay(2);
  assert.equal(pair.proxy.cancel(), undefined);
  await assert.rejects(second, (error) => error?.code === 'RPC_ABORTED');
  await waitFor(() => explicitCancel === 1);
  pair.close();
}

async function testPlainDataBoundary() {
  assert.equal(isPlainData({ ok: [1, 'x', null] }), true);
  assert.equal(isPlainData(new Uint8Array([1])), false);
  assert.equal(isPlainData(new ArrayBuffer(4)), false);
  const pair = proxyPair({ 'chatgpt.capabilities': () => new Uint8Array([1, 2]) });
  await assert.rejects(pair.proxy.capabilities(), /plain data only/);
  await assert.rejects(pair.proxy.request(new Uint8Array([1])), /string-normalizable/);
  pair.close();
}

async function testReadyOrdering() {
  const order = [];
  const parent = {};
  const window = fakeWindow({ parent });
  const document = fakeDocument({ canonicalReady: true, onAppend(node) { if (node.id === 'hex-userscript-style') order.push('css'); } });
  const storage = new Map([['hex.ai.provider', 'gemini']]);
  const globalObject = { navigator: { language: 'ja' }, localStorage: { getItem: (key) => storage.get(key) || null } };
  const bridge = { refresh: async () => { order.push('refresh'); }, request() {}, cancel() {}, capabilities() {}, getSelection() {}, setSelection() {}, status() {}, conversationFor() {} };
  let readySent = false;
  const result = await startEmbedChildRuntime({
    window, document, location: locationForGeneration(12, 'chatgpt'), globalObject, cssText: ':root{color-scheme:dark}',
    waitForEmbedParentAttach: async () => { order.push('attach'); return { port: {}, nonce: 'a'.repeat(64), generation: '12' }; },
    createEmbedBridgeProxy: () => { order.push('bridge'); return bridge; },
    setUiRoot: (root) => { assert.equal(root, document.documentElement); order.push('root'); },
    installProtectedWorkers: () => { order.push('workers'); },
    importApp: async () => { assert.equal(readySent, false); order.push('app'); globalObject.__app = {}; },
    importUx: async () => { order.push('ux'); },
    waitForAppReady: async () => { order.push('readiness'); },
    sendEmbedReady: () => { readySent = true; order.push('ready'); },
  });
  assert.equal(result.generation, '12');
  assert.equal(globalObject.__HEX_CHATGPT_BRIDGE__, bridge);
  assert.equal(globalObject.__HEX_AI_PROVIDER__, 'gemini', 'Worker-origin stored provider wins, preserving iframe preference');
  assert.deepEqual(order, ['attach', 'bridge', 'refresh', 'root', 'css', 'workers', 'app', 'ux', 'readiness', 'ready']);
}

async function testFailedAppDoesNotSendReady() {
  const parent = {};
  const window = fakeWindow({ parent });
  let ready = 0;
  await assert.rejects(startEmbedChildRuntime({
    window,
    document: fakeDocument({ canonicalReady: true }),
    location: locationForGeneration(13),
    globalObject: { navigator: { language: 'ja' } },
    waitForEmbedParentAttach: async () => ({ port: {}, nonce: 'b'.repeat(64), generation: '13' }),
    createEmbedBridgeProxy: () => ({ refresh: async () => {} }),
    setUiRoot: () => {}, installProtectedWorkers: () => {},
    importApp: async () => { throw new Error('boom'); }, importUx: async () => {},
    sendEmbedReady: () => { ready++; },
  }), /embed app import: boom/);
  assert.equal(ready, 0);
}

async function testDirectEmbedFailsBounded() {
  const window = fakeWindow(); window.parent = window;
  await assert.rejects(startEmbedChildRuntime({
    window, document: fakeDocument(), location: locationForGeneration(14), globalObject: {},
  }), /requires an iframe/);
}

function testRuntimeResponsibilityBoundaries() {
  assert.doesNotMatch(childSource, /installUserscriptNetworkBridge/);
  assert.match(protectedEntrySource, /LEGACY_CHATGPT[\s\S]*await import\('\.\/entry\.js'\)/);
  const legacyBlock = protectedEntrySource.slice(protectedEntrySource.indexOf('LEGACY_CHATGPT'), protectedEntrySource.indexOf('EMBED_CHATGPT'));
  assert.doesNotMatch(legacyBlock, /PROTECTED_HOST\.html|scopedCss|installProtectedWorkers/);
  assert.match(entrySource, /ensureLegacyHost/);
  assert.match(entrySource, /PROTECTED_HOST\.scopedCss/);
  assert.match(entrySource, /createChatGPTIframeHost/);
  assert.match(entrySource, /createChatGPTParentRpc/);
  assert.match(entrySource, /PROTECTED_OPAQUE_EMBED_RUNTIME/);
  assert.match(entrySource, /readEmbedMode\(\) === LEGACY_MODE/);
  assert.doesNotMatch(entrySource, /falling back to legacy light DOM/);
  assert.match(opaqueEntrySource, /createEmbedBridgeProxy/);
  assert.match(opaqueEntrySource, /installProtectedWorkers/);
  assert.match(opaqueEntrySource, /import\('\.\.\/app\.js'\)/);
  assert.match(opaqueEntrySource, /import\('\.\.\/ux\.js'\)/);
  assert.doesNotMatch(opaqueEntrySource, /ChatGPTDOMAdapter|prompt-textarea|send-button/);
}

function proxyPair(handlers) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, { handlers });
  const proxy = createEmbedBridgeProxy({ port: channel.port2, rpcOptions: { timeoutMs: 200 }, refreshMinIntervalMs: 0 });
  return { proxy, server, close() { try { proxy.close(); } catch {} try { server.close(); } catch {} } };
}

function locationForGeneration(generation, provider = null) {
  const search = `?__hex_embed_generation=${generation}${provider ? `&__hex_ai_provider=${provider}` : ''}`;
  return { origin: 'https://ida.rhgrive.workers.dev', hostname: 'ida.rhgrive.workers.dev', pathname: EMBED_PATH, search, href: `https://ida.rhgrive.workers.dev${EMBED_PATH}${search}` };
}
function attachEvent({ source, nonce, port, generation }) {
  return { origin: 'https://chatgpt.com', source, data: { type: 'hex.embed.attach', protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce, generation }, ports: [port] };
}
function fakeWindow({ parent = null } = {}) {
  const listeners = new Set();
  const value = {
    parent: null,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatchMessage(event) { for (const fn of [...listeners]) fn(event); },
  };
  value.parent = parent || value;
  return value;
}
function fakeDocument({ canonicalReady = false, onAppend = null } = {}) {
  const byId = new Map();
  const documentElement = { lang: '' };
  return {
    documentElement,
    head: { append(node) { if (node.id) byId.set(node.id, node); onAppend?.(node); } },
    createElement(tag) { return { tagName: String(tag).toUpperCase(), id: '', textContent: '' }; },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) { return canonicalReady && (selector === '#app' || selector === '#btn-open') ? { id: selector.slice(1) } : null; },
  };
}
async function waitFor(predicate, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await delay(2); }
  throw new Error('condition did not become true');
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
