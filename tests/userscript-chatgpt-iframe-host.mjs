import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION } from '../js/userscript/embed-protocol.js';
import { createChatGPTIframeHost } from '../js/userscript/chatgpt-iframe-host.js';

async function testHttpsAndOrigin() {
  const env = fakeEnvironment();
  assert.throws(() => makeHost(env, { src: 'http://worker.example/embed/chatgpt' }), /HTTPS/);
  assert.throws(() => makeHost(env, { src: 'javascript:alert(1)' }), /HTTPS/);
  const host = makeHost(env, { src: 'https://worker.example:8443/embed/chatgpt?x=1' });
  assert.equal(host.state().childOrigin, 'https://worker.example:8443');
  assert.equal(host.iframe.referrerPolicy, 'no-referrer');
  assert.equal(host.iframe.sandbox, undefined);
  host.destroy();
}

async function testPersistentShowHideDestroy() {
  const env = fakeEnvironment();
  const host = makeHost(env);
  const iframe = host.iframe;
  assert.equal(countTags(env.documentRef.documentElement, 'IFRAME'), 1);
  for (let i = 0; i < 10; i += 1) host.show();
  assert.equal(countTags(env.documentRef.documentElement, 'IFRAME'), 1, 'repeated show must not create iframes');
  host.hide();
  assert.equal(host.iframe, iframe);
  assert.equal(env.documentRef.documentElement.contains(iframe), true, 'hide must preserve iframe');
  assert.equal(host.wrapper.style.visibility, 'hidden');
  assert.equal(host.wrapper.style.pointerEvents, 'none');
  for (let i = 0; i < 5; i += 1) { host.show(); host.hide(); }
  assert.equal(countTags(env.documentRef.documentElement, 'IFRAME'), 1);
  host.destroy();
  assert.equal(env.documentRef.documentElement.contains(iframe), false);
}

async function testAttachOrderAndReady() {
  const env = fakeEnvironment();
  const order = [];
  let context;
  const host = makeHost(env, {
    onPort(port, ctx) {
      order.push('onPort');
      context = ctx;
      port.addEventListener('message', () => {});
      port.start?.();
      return () => order.push('cleanup');
    },
  });
  env.onPostMessage = ({ data, targetOrigin, transfer }) => {
    order.push('attach');
    assert.equal(targetOrigin, 'https://worker.example');
    assert.notEqual(targetOrigin, '*');
    assert.equal(transfer.length, 1);
    assert.equal(data.type, 'hex.embed.attach');
    assert.equal(data.protocol, EMBED_PROTOCOL);
    assert.equal(data.version, EMBED_PROTOCOL_VERSION);
    assert.equal(data.nonce, context.nonce);
    const port = transfer[0];
    setTimeout(() => port.postMessage(ready(data.nonce, 'valid-ready')), 0);
  };
  host.show();
  assert.equal(host.state().status, 'loading');
  host.iframe.dispatchEvent({ type: 'load' });
  assert.deepEqual(order.slice(0, 2), ['onPort', 'attach']);
  assert.equal(host.state().status, 'handshaking', 'port creation is not ready');
  assert.equal(context.generation, 1);
  assert.equal(env.postMessages.length, 1);
  await waitFor(() => host.state().status === 'visible');
  assert.equal(host.state().generation, 1);
  host.hide();
  assert.equal(host.state().status, 'hidden');
  host.show();
  assert.equal(host.state().status, 'visible');
  assert.equal(env.postMessages.length, 1, 'show after ready must reuse port/iframe');
  host.destroy();
}

async function testOnPortFailure() {
  const env = fakeEnvironment();
  const host = makeHost(env, { onPort() { throw new Error('install failed'); } });
  host.show();
  host.iframe.dispatchEvent({ type: 'load' });
  await waitFor(() => host.state().status === 'failed');
  assert.equal(env.postMessages.length, 0, 'attach must not happen after onPort throws');
  assert.equal(host.state().failure.stage, 'handshake/app-ready');
  assert.match(host.state().failure.message, /install failed/);
  host.destroy();
}

async function testWrongNonceAndStaleGeneration() {
  const env = fakeEnvironment();
  const cleanups = [];
  const ports = [];
  const host = makeHost(env, {
    readyTimeoutMs: 200,
    onPort(_port, ctx) {
      return () => cleanups.push(ctx.generation);
    },
  });
  env.onPostMessage = ({ data, transfer }) => ports.push({ nonce: data.nonce, port: transfer[0] });
  host.show();
  host.iframe.dispatchEvent({ type: 'load' });
  await tick();
  ports[0].port.postMessage(ready('0'.repeat(64), 'wrong-nonce'));
  await delay(10);
  assert.equal(host.state().status, 'handshaking', 'wrong nonce must be ignored');

  host.iframe.dispatchEvent({ type: 'load' });
  await tick();
  assert.equal(host.state().generation, 2);
  assert.deepEqual(cleanups, [1], 'reload must cleanup old RPC generation');
  ports[0].port.postMessage(ready(ports[0].nonce, 'stale-ready'));
  await delay(10);
  assert.equal(host.state().status, 'handshaking', 'stale generation ready must not win');
  ports[1].port.postMessage({ ...ready(ports[1].nonce, 'wrong-version'), version: 2 });
  await delay(10);
  assert.equal(host.state().status, 'handshaking');
  ports[1].port.postMessage(ready(ports[1].nonce, 'current-ready'));
  await waitFor(() => host.state().status === 'visible');
  host.destroy();
  assert.deepEqual(cleanups, [1, 2]);
}

async function testTimeoutsAndRetryCleanup() {
  const loadEnv = fakeEnvironment();
  const loadHost = makeHost(loadEnv, { loadTimeoutMs: 15 });
  loadHost.show();
  await waitFor(() => loadHost.state().status === 'failed');
  assert.equal(loadHost.state().failure.stage, 'iframe-load');
  loadHost.destroy();

  const env = fakeEnvironment();
  const cleanups = [];
  const ports = [];
  const host = makeHost(env, {
    readyTimeoutMs: 20,
    loadTimeoutMs: 100,
    onPort(port, ctx) {
      const originalClose = port.close.bind(port);
      let closed = false;
      port.close = () => { closed = true; originalClose(); };
      ports.push({ generation: ctx.generation, get closed() { return closed; } });
      return () => cleanups.push(ctx.generation);
    },
  });
  host.show();
  host.iframe.dispatchEvent({ type: 'load' });
  await waitFor(() => host.state().status === 'failed');
  assert.equal(host.state().failure.stage, 'handshake/app-ready');
  assert.deepEqual(cleanups, [1]);
  assert.equal(ports[0].closed, true, 'old parent port must close');

  const beforeSrcWrites = host.iframe.srcWrites;
  host.retryButton.click();
  assert.equal(host.state().status, 'loading');
  assert.ok(host.iframe.srcWrites > beforeSrcWrites, 'retry must reload iframe src');
  host.iframe.dispatchEvent({ type: 'load' });
  await tick();
  assert.equal(host.state().generation, 2, 'retry load must create a new generation');
  host.destroy();
}

async function testEmergencyCloseAndFocus() {
  const env = fakeEnvironment();
  const prior = env.documentRef.createElement('button');
  env.documentRef.documentElement.append(prior);
  env.documentRef.activeElement = prior;
  const host = makeHost(env);
  host.show();
  assert.equal(host.iframe.contentWindow.focusCalls, 1, 'show should best-effort focus iframe window');
  host.closeButton.click();
  assert.equal(host.wrapper.style.visibility, 'hidden');
  assert.equal(host.wrapper.style.pointerEvents, 'none');
  assert.equal(env.documentRef.documentElement.contains(host.iframe), true, 'emergency close must hide, not destroy');
  assert.equal(prior.focusCalls, 1, 'hide should restore prior focus');
  host.destroy();
}

async function testNoParentAppInjection() {
  const source = await readFile(new URL('../js/userscript/chatgpt-iframe-host.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML\s*=/);
  assert.doesNotMatch(source, /documentRef\.head|document\.head/);
  assert.doesNotMatch(source, /PROTECTED_HOST|scopedCss/);
  const env = fakeEnvironment();
  const host = makeHost(env);
  const tags = collectTags(env.documentRef.documentElement);
  assert.ok(tags.every((tag) => ['HTML', 'DIV', 'IFRAME', 'BUTTON', 'STRONG'].includes(tag)));
  host.destroy();
}

async function testDestroyIdempotent() {
  const env = fakeEnvironment();
  const host = makeHost(env);
  host.destroy();
  assert.doesNotThrow(() => host.destroy());
  assert.equal(host.state().status, 'destroyed');
  assert.equal(env.documentRef.documentElement.contains(host.wrapper), false);
  assert.equal(env.documentRef.documentElement.contains(host.launcher), false);
}

function makeHost(env, overrides = {}) {
  return createChatGPTIframeHost({
    src: 'https://worker.example/embed/chatgpt',
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

function fakeEnvironment() {
  const postMessages = [];
  const root = new FakeElement('html');
  const documentRef = {
    documentElement: root,
    activeElement: null,
    createElement(tag) {
      const element = new FakeElement(tag);
      if (String(tag).toLowerCase() === 'iframe') {
        element.contentWindow = {
          focusCalls: 0,
          focus() { this.focusCalls += 1; },
          postMessage(data, targetOrigin, transfer) {
            const call = { data, targetOrigin, transfer };
            postMessages.push(call);
            env.onPostMessage?.(call);
          },
        };
      }
      return element;
    },
    contains(node) { return root.contains(node); },
  };
  const env = { documentRef, windowRef: {}, postMessages, onPostMessage: null };
  return env;
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.hidden = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.srcWrites = 0;
    this._src = '';
    this.focusCalls = 0;
  }
  set src(value) { this._src = String(value); this.srcWrites += 1; }
  get src() { return this._src; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn.call(this, event); }
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
  focus() { this.focusCalls += 1; }
}

function countTags(root, tag) { return collectTags(root).filter((value) => value === tag).length; }
function collectTags(root, out = []) { out.push(root.tagName); for (const child of root.children) collectTags(child, out); return out; }
function tick() { return delay(0); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('condition timed out');
}

await testHttpsAndOrigin();
await testPersistentShowHideDestroy();
await testAttachOrderAndReady();
await testOnPortFailure();
await testWrongNonceAndStaleGeneration();
await testTimeoutsAndRetryCleanup();
await testEmergencyCloseAndFocus();
await testNoParentAppInjection();
await testDestroyIdempotent();

console.log('userscript chatgpt iframe host: ok');
