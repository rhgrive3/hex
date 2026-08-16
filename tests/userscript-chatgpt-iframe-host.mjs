import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION } from '../js/userscript/embed-protocol.js';
import {
  EMBED_BOOTSTRAP_TYPE,
  EMBED_GENERATION_PARAM,
} from '../js/userscript/embed-bootstrap.js';
import { createChatGPTIframeHost } from '../js/userscript/chatgpt-iframe-host.js';

await testHttpsAndPersistentLifecycle();
await testBootstrapMustPrecedeAttach();
await testAttachOrderAndReady();
await testBootstrapTimeout();
await testReadyTimeout();
await testReloadRejectsStaleGeneration();
await testOnPortFailure();
await testEmergencyCloseAndFocus();
await testDestroyIdempotent();

console.log('userscript chatgpt iframe host: ok');

async function testHttpsAndPersistentLifecycle() {
  const env = fakeEnvironment();
  assert.throws(() => makeHost(env, { src: 'http://worker.example/embed/chatgpt' }), /HTTPS/);
  const host = makeHost(env, { loadTimeoutMs: 0 });
  const iframe = host.iframe;
  assert.equal(host.state().childOrigin, 'https://worker.example');
  assert.equal(iframe.referrerPolicy, 'no-referrer');
  assert.equal(countTags(env.documentRef.documentElement, 'IFRAME'), 1);
  for (let i = 0; i < 10; i++) host.show();
  host.hide();
  assert.equal(host.iframe, iframe);
  assert.equal(env.documentRef.documentElement.contains(iframe), true);
  assert.equal(host.wrapper.style.visibility, 'hidden');
  host.destroy();
  assert.equal(env.documentRef.documentElement.contains(iframe), false);
}

async function testBootstrapMustPrecedeAttach() {
  const env = fakeEnvironment();
  const host = makeHost(env, { loadTimeoutMs: 200 });
  await delay(10);
  assert.equal(env.postMessages.length, 0, 'parent must not attach on document load/navigation alone');
  const generation = currentGeneration(host.iframe.src);
  env.signalBootstrap(host.iframe, generation);
  await waitFor(() => env.postMessages.length === 1);
  assert.equal(env.postMessages[0].data.type, 'hex.embed.attach');
  host.destroy();
}

async function testAttachOrderAndReady() {
  const order = [];
  const env = fakeEnvironment({
    onAttach(call) {
      order.push('attach');
      const port = call.transfer[0];
      setTimeout(() => port.postMessage(ready(call.data.nonce, 'ready-1')), 0);
    },
  });
  const host = makeHost(env, {
    onPort(port, context) {
      order.push('onPort');
      assert.equal(context.generation, 1);
      port.start?.();
      return () => order.push('cleanup');
    },
  });
  assert.equal(host.state().status, 'loading');
  const generation = currentGeneration(host.iframe.src);
  env.signalBootstrap(host.iframe, generation);
  await waitFor(() => host.state().status === 'hidden');
  assert.deepEqual(order.slice(0, 2), ['onPort', 'attach']);
  assert.equal(env.postMessages[0].targetOrigin, 'https://worker.example');
  assert.notEqual(env.postMessages[0].targetOrigin, '*');
  assert.equal(env.postMessages[0].data.generation, '1');
  host.show();
  assert.equal(host.state().status, 'visible');
  host.hide();
  assert.equal(host.state().status, 'hidden');
  assert.equal(env.postMessages.length, 1, 'show/hide reuses the same iframe and port');
  host.destroy();
}

async function testBootstrapTimeout() {
  const env = fakeEnvironment();
  const failures = [];
  const host = makeHost(env, { loadTimeoutMs: 15, onFailure: (value) => failures.push(value) });
  await waitFor(() => host.state().status === 'failed');
  assert.equal(host.state().failure.stage, 'iframe-bootstrap');
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /bootstrap timed out/i);
  host.destroy();
}

async function testReadyTimeout() {
  const env = fakeEnvironment();
  const cleanups = [];
  const host = makeHost(env, {
    readyTimeoutMs: 15,
    onPort(_port, context) { return () => cleanups.push(context.generation); },
  });
  env.signalBootstrap(host.iframe, currentGeneration(host.iframe.src));
  await waitFor(() => host.state().status === 'failed');
  assert.equal(host.state().failure.stage, 'handshake/app-ready');
  assert.deepEqual(cleanups, [1]);
  host.destroy();
}

async function testReloadRejectsStaleGeneration() {
  const env = fakeEnvironment({
    onAttach(call) {
      const port = call.transfer[0];
      setTimeout(() => port.postMessage(ready(call.data.nonce, `ready-${call.data.generation}`)), 0);
    },
  });
  const cleanups = [];
  const host = makeHost(env, { onPort(_port, context) { return () => cleanups.push(context.generation); } });
  const first = currentGeneration(host.iframe.src);
  host.reload();
  const second = currentGeneration(host.iframe.src);
  assert.equal(first, '1');
  assert.equal(second, '2');
  env.signalBootstrap(host.iframe, first);
  await delay(10);
  assert.equal(env.postMessages.length, 0, 'stale bootstrap cannot attach a new generation');
  env.signalBootstrap(host.iframe, second);
  await waitFor(() => host.state().status === 'hidden');
  assert.equal(env.postMessages.length, 1);
  assert.equal(env.postMessages[0].data.generation, second);
  host.reload();
  assert.deepEqual(cleanups, [2], 'old live RPC generation is cleaned before reload');
  host.destroy();
}

async function testOnPortFailure() {
  const env = fakeEnvironment();
  const host = makeHost(env, { onPort() { throw new Error('rpc install failed'); } });
  env.signalBootstrap(host.iframe, currentGeneration(host.iframe.src));
  await waitFor(() => host.state().status === 'failed');
  assert.equal(env.postMessages.length, 0, 'attach is forbidden when parent RPC did not install');
  assert.match(host.state().failure.message, /rpc install failed/);
  host.destroy();
}

async function testEmergencyCloseAndFocus() {
  const env = fakeEnvironment();
  const prior = env.documentRef.createElement('button');
  env.documentRef.documentElement.append(prior);
  env.documentRef.activeElement = prior;
  const host = makeHost(env, { loadTimeoutMs: 0 });
  host.show();
  assert.equal(host.iframe.contentWindow.focusCalls, 1);
  host.closeButton.click();
  assert.equal(host.wrapper.style.visibility, 'hidden');
  assert.equal(env.documentRef.documentElement.contains(host.iframe), true);
  assert.equal(prior.focusCalls, 1);
  host.destroy();
}

async function testDestroyIdempotent() {
  const env = fakeEnvironment();
  const host = makeHost(env, { loadTimeoutMs: 0 });
  host.destroy();
  assert.doesNotThrow(() => host.destroy());
  assert.equal(host.state().status, 'destroyed');
}

function makeHost(env, overrides = {}) {
  return createChatGPTIframeHost({
    src: 'https://worker.example/embed/chatgpt?__hex_ai_provider=chatgpt',
    onPort: () => {},
    documentRef: env.documentRef,
    windowRef: env.windowRef,
    MessageChannelCtor: MessageChannel,
    loadTimeoutMs: 200,
    readyTimeoutMs: 200,
    ...overrides,
  });
}

function ready(nonce, id) {
  return { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'control', id, method: 'ready', nonce };
}
function currentGeneration(src) { return new URL(src).searchParams.get(EMBED_GENERATION_PARAM); }

function fakeEnvironment(options = {}) {
  const postMessages = [];
  const root = new FakeElement('html');
  const windowListeners = new Map();
  const windowRef = {
    addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn); },
    removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
    dispatchMessage(event) { for (const fn of [...(windowListeners.get('message') || [])]) fn(event); },
  };
  const env = { documentRef: null, windowRef, postMessages };
  const documentRef = {
    documentElement: root,
    activeElement: null,
    createElement(tag) {
      const element = new FakeElement(tag);
      if (String(tag).toLowerCase() === 'iframe') {
        element.contentWindow = {
          focusCalls: 0,
          focus() { this.focusCalls++; },
          postMessage(data, targetOrigin, transfer) {
            const call = { data, targetOrigin, transfer };
            postMessages.push(call);
            options.onAttach?.(call);
          },
        };
      }
      return element;
    },
    contains(node) { return root.contains(node); },
  };
  env.documentRef = documentRef;
  env.signalBootstrap = (iframe, generation, patch = {}) => {
    windowRef.dispatchMessage({
      source: iframe.contentWindow,
      origin: 'https://worker.example',
      data: {
        type: EMBED_BOOTSTRAP_TYPE,
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        generation,
        ...patch,
      },
    });
  };
  return env;
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentElement = null;
    this.style = {}; this.hidden = false; this.attributes = new Map(); this.listeners = new Map();
    this.textContent = ''; this._src = ''; this.focusCalls = 0;
  }
  set src(value) { this._src = String(value); }
  get src() { return this._src; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  remove() { if (!this.parentElement) return; const i = this.parentElement.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); this.parentElement = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn.call(this, event); }
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
  focus() { this.focusCalls++; }
}

function countTags(root, tag) { return collectTags(root).filter((value) => value === tag).length; }
function collectTags(root, out = []) { out.push(root.tagName); for (const child of root.children) collectTags(child, out); return out; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await delay(2); }
  assert.fail('condition timed out');
}
