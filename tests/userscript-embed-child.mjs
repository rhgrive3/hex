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
const childSource = await readFile(new URL('../js/userscript/embed-child.js', import.meta.url), 'utf8');

// 1-4: context classification and route isolation.
testContextClassification();

// 5-10: bounded/validated parent attach.
await testValidAttach();
await testIgnoredAttach('wrong origin', { origin: 'https://evil.invalid' });
await testIgnoredAttach('wrong source', { source: {} });
await testRejectedAttachMismatch('wrong protocol', { protocol: 'other-protocol' });
await testRejectedAttachMismatch('wrong version', { version: EMBED_PROTOCOL_VERSION + 1 });
await testAttachTimeout();

// 11-24, 28: RPC client proxy, sync compatibility, caches, privacy.
await testRpcProxyContract();
await testAbortMapping();
await testCancelBestEffort();
await testCapabilities();
await testInitialSafeCaches();
await testBackgroundCacheRefresh();
await testRequestCacheUpdate();
await testSetSelectionCacheUpdate();
await testConversationCacheUpdate();
await testPlainDataBoundary();

// 25-27, 33-34: bootstrap/source boundaries.
testProtectedEntryBoundaries();
await testCanonicalCssAndNoHostInsertion();

// 29-32: ready ordering/failure/direct route behavior.
await testReadyOrdering();
await testFailedAppDoesNotSendReady();
await testDirectEmbedTimesOut();

console.log('userscript embed child: ok');

function testContextClassification() {
  const workerOrigin = 'https://ida.rhgrive.workers.dev';
  const legacyWindow = fakeWindow();
  assert.equal(classifyProtectedRuntime({
    location: { hostname: 'chatgpt.com', origin: 'https://chatgpt.com', pathname: '/' },
    apiOrigin: workerOrigin,
    window: legacyWindow,
  }), PROTECTED_RUNTIME_CONTEXT.LEGACY_CHATGPT, '1 legacy classification');

  const iframeWindow = fakeWindow({ parent: {} });
  assert.equal(classifyProtectedRuntime({
    location: { hostname: 'ida.rhgrive.workers.dev', origin: workerOrigin, pathname: EMBED_PATH },
    apiOrigin: workerOrigin,
    window: iframeWindow,
  }), PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT, '2 iframe classification');

  const standaloneWindow = fakeWindow();
  standaloneWindow.parent = standaloneWindow;
  assert.equal(classifyProtectedRuntime({
    location: { hostname: 'ida.rhgrive.workers.dev', origin: workerOrigin, pathname: '/' },
    apiOrigin: workerOrigin,
    window: standaloneWindow,
  }), PROTECTED_RUNTIME_CONTEXT.STANDALONE, '3 standalone classification');

  assert.equal(classifyProtectedRuntime({
    location: { hostname: 'ida.rhgrive.workers.dev', origin: workerOrigin, pathname: '/embed/other' },
    apiOrigin: workerOrigin,
    window: iframeWindow,
  }), PROTECTED_RUNTIME_CONTEXT.STANDALONE, '4 iframe classification is exact-path only');
}

async function testValidAttach() {
  const parent = {};
  const window = fakeWindow({ parent });
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const pending = waitForEmbedParentAttach({ window, expectedParent: parent, timeoutMs: 100 });
  window.dispatchMessage(attachEvent({ source: parent, nonce, port: channel.port1 }));
  const result = await pending;
  assert.equal(result.nonce, nonce, '5 valid attach nonce');
  assert.equal(result.port, channel.port1, '5 valid attach port');
  channel.port1.close(); channel.port2.close();
}

async function testIgnoredAttach(label, patch) {
  const parent = {};
  const window = fakeWindow({ parent });
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const pending = waitForEmbedParentAttach({ window, expectedParent: parent, timeoutMs: 15 });
  const base = attachEvent({ source: parent, nonce, port: channel.port1 });
  window.dispatchMessage({ ...base, ...patch });
  await assert.rejects(pending, /embed parent attach timeout/, label === 'wrong origin' ? '6 wrong origin ignored' : '7 wrong source ignored');
  channel.port1.close(); channel.port2.close();
}

async function testRejectedAttachMismatch(label, patch) {
  const parent = {};
  const window = fakeWindow({ parent });
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const pending = waitForEmbedParentAttach({ window, expectedParent: parent, timeoutMs: 100 });
  const event = attachEvent({ source: parent, nonce, port: channel.port1 });
  window.dispatchMessage({ ...event, data: { ...event.data, ...patch } });
  await assert.rejects(pending, /protocol\/version mismatch/, label === 'wrong protocol' ? '8 wrong protocol rejected' : '9 wrong version rejected');
  channel.port1.close(); channel.port2.close();
}

async function testAttachTimeout() {
  const parent = {};
  const window = fakeWindow({ parent });
  await assert.rejects(
    waitForEmbedParentAttach({ window, expectedParent: parent, timeoutMs: 10 }),
    /embed parent attach timeout/,
    '10 attach timeout',
  );
}

async function testRpcProxyContract() {
  let requestParams = null;
  let requestSignal = null;
  const pair = proxyPair({
    'chatgpt.request': (params, context) => {
      requestParams = params;
      requestSignal = context.signal;
      return { text: 'ok' };
    },
    'chatgpt.status': () => ({ ready: true }),
    'chatgpt.getSelection': () => null,
  });
  const result = await pair.proxy.request('hello', {
    timeoutMs: 110000,
    sessionKey: 'session-1',
    model: 'gpt-5',
    reasoning: 'high',
  });
  assert.deepEqual(result, { text: 'ok' }, '11 child RPC client returns result');
  assert.deepEqual(requestParams, {
    prompt: 'hello', timeoutMs: 110000, sessionKey: 'session-1', model: 'gpt-5', reasoning: 'high',
  }, '12/13 request proxy params');
  assert.equal(Object.hasOwn(requestParams, 'signal'), false, '13 AbortSignal is not serialized into params');
  assert.ok(requestSignal instanceof AbortSignal, '11 child side uses protocol RPC cancellation signal');
  pair.close();
}

async function testAbortMapping() {
  let parentAborted = false;
  const pair = proxyPair({
    'chatgpt.request': (_params, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { parentAborted = true; reject(new Error('aborted')); }, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = pair.proxy.request('cancel me', { signal: controller.signal });
  controller.abort('test-abort');
  await assert.rejects(pending, (error) => error?.code === 'RPC_ABORTED', '14 Abort maps to RPC call signal');
  await waitFor(() => parentAborted);
  pair.close();
}

async function testCancelBestEffort() {
  let cancelled = 0;
  let requestAborted = false;
  const pair = proxyPair({
    'chatgpt.request': (_params, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { requestAborted = true; reject(new Error('cancelled')); }, { once: true });
    }),
    'chatgpt.cancel': () => { cancelled += 1; return null; },
  });
  const pending = pair.proxy.request('cancel me');
  await delay(1);
  assert.equal(pair.proxy.cancel(), undefined, '15 cancel remains synchronous');
  await assert.rejects(pending, (error) => error?.code === 'RPC_ABORTED');
  await waitFor(() => requestAborted && cancelled === 1);
  pair.close();
}

async function testCapabilities() {
  const pair = proxyPair({ 'chatgpt.capabilities': () => ({ provider: 'chatgpt-web', maxConcurrentRequests: 1 }) });
  assert.deepEqual(await pair.proxy.capabilities(), { provider: 'chatgpt-web', maxConcurrentRequests: 1 }, '16 capabilities proxy');
  pair.close();
}

async function testInitialSafeCaches() {
  const pair = proxyPair({});
  assert.deepEqual(pair.proxy.status(), { ...EMBED_SAFE_STATUS }, '17/20 sync safe initial status');
  assert.equal(pair.proxy.getSelection(), null, '18/20 sync safe initial selection');
  assert.equal(pair.proxy.conversationFor('missing'), null, '19/20 sync conversation cache miss');
  pair.close();
}

async function testBackgroundCacheRefresh() {
  const selection = { model: 'gpt-5', reasoning: 'high' };
  const pair = proxyPair({
    'chatgpt.status': () => ({ ready: true, busy: true, selection }),
    'chatgpt.getSelection': () => selection,
  });
  await pair.proxy.refresh({ timeoutMs: 200 });
  assert.equal(pair.proxy.status().ready, true, '21 status background refresh');
  assert.equal(pair.proxy.status().busy, true, '21 status cache updated');
  assert.deepEqual(pair.proxy.getSelection(), selection, '21 selection cache updated');
  pair.close();
}

async function testRequestCacheUpdate() {
  const selection = { model: 'gpt-5', reasoning: 'medium' };
  const pair = proxyPair({
    'chatgpt.request': () => ({ text: 'ok', conversation: 'conv-7', selection }),
  });
  await pair.proxy.request('hello', { sessionKey: 's7' });
  assert.equal(pair.proxy.conversationFor('s7'), 'conv-7', '22 request conversation cache update');
  assert.deepEqual(pair.proxy.getSelection(), selection, '22 request selection cache update');
  assert.equal(pair.proxy.status().conversation, 'conv-7', '22 request status cache update');
  pair.close();
}

async function testSetSelectionCacheUpdate() {
  let params = null;
  const pair = proxyPair({
    'chatgpt.setSelection': (value) => { params = value; return { model: value.model, reasoning: value.reasoning }; },
  });
  const selected = await pair.proxy.setSelection({ provider: 'chatgpt-web', model: 'gpt-5', reasoning: 'high' });
  assert.deepEqual(params, { model: 'gpt-5', reasoning: 'high' }, '23 setSelection sends parent RPC contract');
  assert.deepEqual(pair.proxy.getSelection(), selected, '23 setSelection updates sync cache');
  pair.close();
}

async function testConversationCacheUpdate() {
  const pair = proxyPair({ 'chatgpt.conversationFor': ({ sessionKey }) => `conversation:${sessionKey}` });
  assert.equal(pair.proxy.conversationFor('alpha'), null, '24 conversation cache first read is synchronous miss');
  await waitFor(() => pair.proxy.conversationFor('alpha') === 'conversation:alpha');
  assert.equal(pair.proxy.conversationFor('alpha'), 'conversation:alpha', '24 background conversation RPC updates cache');
  pair.close();
}

async function testPlainDataBoundary() {
  assert.equal(isPlainData({ ok: [1, 'x', null] }), true);
  assert.equal(isPlainData(new Uint8Array([1, 2, 3])), false);
  assert.equal(isPlainData(new ArrayBuffer(4)), false);
  const pair = proxyPair({
    'chatgpt.capabilities': () => new Uint8Array([1, 2, 3]),
    'chatgpt.setSelection': () => ({ model: null, reasoning: null }),
  });
  await assert.rejects(pair.proxy.capabilities(), /plain data only/, '28 parent binary result rejected');
  await assert.rejects(pair.proxy.request(new Uint8Array([1, 2])), /string-normalizable scalar/, '28 binary prompt cannot be stringified across boundary');
  await assert.rejects(
    pair.proxy.setSelection({ model: new Uint8Array([1]), reasoning: null }),
    /plain data only/,
    '28 child binary input rejected before transfer',
  );
  pair.close();
}

function testProtectedEntryBoundaries() {
  assert.doesNotMatch(childSource, /installUserscriptNetworkBridge/, '25 iframe does not install GM network bridge');
  assert.doesNotMatch(protectedEntrySource, /installUserscriptNetworkBridge/, '25 protected iframe bootstrap does not install GM network bridge');
  assert.match(protectedEntrySource, /await import\('\.\/entry\.js'\)/, '26 legacy still imports legacy entry');
  assert.match(protectedEntrySource, /host\.innerHTML\s*=\s*PROTECTED_HOST\.html/, '26 legacy still inserts protected host HTML');
  assert.match(protectedEntrySource, /PROTECTED_HOST\.scopedCss/, '26 legacy still uses scoped CSS');
  assert.match(protectedEntrySource, /document\.documentElement[\s\S]*PROTECTED_HOST\.css[\s\S]*await import\('\.\.\/app\.js'\)[\s\S]*await import\('\.\.\/ux\.js'\)/, '27 standalone path preserved');
  assert.match(protectedEntrySource, /startEmbedChildRuntime\(\{ cssText: PROTECTED_HOST\.css \}\)/, '33 iframe receives canonical unscoped CSS');
  assert.doesNotMatch(childSource, /PROTECTED_HOST\.html|innerHTML/, '34 iframe child never reinserts protected host HTML');
  const embedStart = protectedEntrySource.indexOf('} else if (context === PROTECTED_RUNTIME_CONTEXT.EMBED_CHATGPT');
  const standaloneStart = protectedEntrySource.indexOf('} else {', embedStart + 1);
  assert.ok(embedStart >= 0 && standaloneStart > embedStart, '34 embed branch is explicit');
  assert.doesNotMatch(protectedEntrySource.slice(embedStart, standaloneStart), /PROTECTED_HOST\.html|innerHTML/, '34 protected-entry embed branch never reinserts host HTML');
}

async function testCanonicalCssAndNoHostInsertion() {
  const document = fakeDocument({ canonicalReady: true });
  const css = ':root{--x:1}html, body{margin:0}body{display:block}';
  const style = installCanonicalCss(document, css);
  assert.equal(style.textContent, css, '33 canonical CSS remains unscoped');
  assert.equal(document.createdTags.filter((tag) => tag !== 'style').length, 0, '34 CSS install creates no host DOM');
}

async function testReadyOrdering() {
  const order = [];
  const parent = {};
  const window = fakeWindow({ parent });
  const document = fakeDocument({ canonicalReady: true, onAppend: (node) => { if (node.id === 'hex-userscript-style') order.push('css'); } });
  const globalObject = { navigator: { language: 'ja' } };
  const bridge = {
    refresh: async () => { order.push('refresh'); },
    request() {}, cancel() {}, capabilities() {}, getSelection() {}, setSelection() {}, status() {}, conversationFor() {},
  };
  let readySent = false;
  const result = await startEmbedChildRuntime({
    window,
    document,
    location: { origin: 'https://ida.rhgrive.workers.dev', pathname: EMBED_PATH },
    globalObject,
    cssText: ':root{color-scheme:dark}',
    waitForEmbedParentAttach: async () => { order.push('attach'); return { port: {}, nonce: 'a'.repeat(64) }; },
    createEmbedBridgeProxy: () => { order.push('bridge'); return bridge; },
    setUiRoot: (root) => { assert.equal(root, document.documentElement); order.push('root'); },
    installProtectedWorkers: () => { order.push('workers'); },
    importApp: async () => { assert.equal(readySent, false, '29 ready not sent before app init'); order.push('app'); globalObject.__app = {}; },
    importUx: async () => { order.push('ux'); },
    waitForAppReady: async () => { order.push('readiness'); },
    sendEmbedReady: (_port, { nonce }) => { assert.equal(nonce, 'a'.repeat(64)); readySent = true; order.push('ready'); },
  });
  assert.equal(result.bridge, bridge);
  assert.equal(globalObject.__HEX_CHATGPT_BRIDGE__, bridge);
  assert.equal(globalObject.__HEX_API_BASE__, 'https://ida.rhgrive.workers.dev');
  assert.equal(globalObject.__HEX_AI_PROVIDER__, 'chatgpt');
  assert.equal(readySent, true, '30 ready sent after initialization');
  assert.deepEqual(order, ['attach', 'bridge', 'refresh', 'root', 'css', 'workers', 'app', 'ux', 'readiness', 'ready'], '29/30 strict ready ordering');
}

async function testFailedAppDoesNotSendReady() {
  const parent = {};
  const window = fakeWindow({ parent });
  const document = fakeDocument({ canonicalReady: true });
  let readyCount = 0;
  await assert.rejects(startEmbedChildRuntime({
    window,
    document,
    location: { origin: 'https://ida.rhgrive.workers.dev', pathname: EMBED_PATH },
    globalObject: { navigator: { language: 'ja' } },
    cssText: 'body{}',
    waitForEmbedParentAttach: async () => ({ port: {}, nonce: 'b'.repeat(64) }),
    createEmbedBridgeProxy: () => ({ refresh: async () => {} }),
    setUiRoot: () => {},
    installProtectedWorkers: () => {},
    importApp: async () => { throw new Error('boom'); },
    importUx: async () => {},
    sendEmbedReady: () => { readyCount += 1; },
  }), /embed app import: boom/, '31 failed app rejects with stage');
  assert.equal(readyCount, 0, '31 failed app sends no ready');
}

async function testDirectEmbedTimesOut() {
  const window = fakeWindow();
  window.parent = window;
  const document = fakeDocument({ canonicalReady: true });
  await assert.rejects(startEmbedChildRuntime({
    window,
    document,
    location: { origin: 'https://ida.rhgrive.workers.dev', pathname: EMBED_PATH },
    globalObject: { navigator: { language: 'ja' } },
    cssText: '',
    attachTimeoutMs: 10,
    setUiRoot: () => {},
    installProtectedWorkers: () => {},
    importApp: async () => {},
    importUx: async () => {},
  }), /embed parent attach: embed parent attach timeout/, '32 direct embed is bounded and fails closed');
}

function proxyPair(handlers, options = {}) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, { handlers });
  const proxy = createEmbedBridgeProxy({ port: channel.port2, rpcOptions: { timeoutMs: options.timeoutMs ?? 200 } });
  return {
    proxy,
    server,
    close() {
      try { proxy.close(); } catch {}
      try { server.close(); } catch {}
      try { channel.port1.close(); channel.port2.close(); } catch {}
    },
  };
}

function attachEvent({ source, nonce, port }) {
  return {
    origin: 'https://chatgpt.com',
    source,
    data: { type: 'hex.embed.attach', protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce },
    ports: [port],
  };
}

function fakeWindow({ parent = null } = {}) {
  const listeners = new Set();
  const value = {
    parent: null,
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    dispatchMessage(event) { for (const listener of [...listeners]) listener(event); },
  };
  value.parent = parent || value;
  return value;
}

function fakeDocument({ canonicalReady = false, onAppend = null } = {}) {
  const byId = new Map();
  const documentElement = { lang: '' };
  const createdTags = [];
  const document = {
    documentElement,
    createdTags,
    head: {
      append(node) { if (node.id) byId.set(node.id, node); onAppend?.(node); },
    },
    createElement(tag) {
      createdTags.push(tag);
      return {
        tagName: String(tag).toUpperCase(), id: '', textContent: '', dataset: {},
        setAttribute(name, value) { this[name] = String(value); },
      };
    },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) {
      if (canonicalReady && (selector === '#app' || selector === '#btn-open')) return { id: selector.slice(1) };
      return null;
    },
  };
  return document;
}

async function waitFor(predicate, timeoutMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(2);
  }
  throw new Error('condition did not become true');
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
