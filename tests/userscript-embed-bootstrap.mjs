import assert from 'node:assert/strict';
import {
  EMBED_BOOTSTRAP_TYPE,
  EMBED_GENERATION_PARAM,
  announceEmbedChildBootstrapReady,
  createEmbedBootstrapMessage,
  readEmbedGeneration,
  readEmbedProvider,
  setEmbedProvider,
  waitForEmbedChildBootstrap,
  withEmbedGeneration,
} from '../js/userscript/embed-bootstrap.js';
import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION } from '../js/userscript/embed-protocol.js';

await testUrlState();
await testChildAnnouncement();
await testParentValidation();
await testStaleAndWrongMessages();
await testTimeoutAndAbort();

console.log('userscript embed bootstrap: ok');

async function testUrlState() {
  const url = withEmbedGeneration('https://worker.example/embed/chatgpt?x=1', 7);
  assert.equal(new URL(url).searchParams.get(EMBED_GENERATION_PARAM), '7');
  assert.equal(readEmbedGeneration({ search: '?__hex_embed_generation=7' }), '7');
  assert.equal(readEmbedGeneration({ search: '?__hex_embed_generation=0' }), null);
  const providerUrl = setEmbedProvider(url, 'gemini');
  assert.equal(readEmbedProvider({ href: providerUrl }), 'gemini');
  assert.equal(readEmbedGeneration({ href: providerUrl }), '7');
}

async function testChildAnnouncement() {
  const calls = [];
  const parent = { postMessage(data, targetOrigin) { calls.push({ data, targetOrigin }); } };
  const child = { parent };
  const message = announceEmbedChildBootstrapReady({ windowRef: child, parent, generation: '3' });
  assert.equal(message.type, EMBED_BOOTSTRAP_TYPE);
  assert.equal(message.protocol, EMBED_PROTOCOL);
  assert.equal(message.version, EMBED_PROTOCOL_VERSION);
  assert.equal(message.generation, '3');
  assert.deepEqual(calls.map((call) => call.targetOrigin), ['https://chatgpt.com', 'https://chat.openai.com']);
  assert.ok(calls.every((call) => call.targetOrigin !== '*'));
}

async function testParentValidation() {
  const parent = eventTarget();
  const child = {};
  const pending = waitForEmbedChildBootstrap({
    windowRef: parent,
    expectedSource: child,
    childOrigin: 'https://worker.example',
    generation: '11',
    timeoutMs: 100,
  });
  parent.dispatch({
    source: child,
    origin: 'https://worker.example',
    data: createEmbedBootstrapMessage('11'),
  });
  const result = await pending;
  assert.equal(result.generation, '11');
  assert.equal(result.origin, 'https://worker.example');
}

async function testStaleAndWrongMessages() {
  const parent = eventTarget();
  const child = {};
  let settled = false;
  const pending = waitForEmbedChildBootstrap({
    windowRef: parent,
    expectedSource: child,
    childOrigin: 'https://worker.example',
    generation: '5',
    timeoutMs: 100,
  }).then((value) => { settled = true; return value; });

  parent.dispatch({ source: {}, origin: 'https://worker.example', data: createEmbedBootstrapMessage('5') });
  parent.dispatch({ source: child, origin: 'https://evil.example', data: createEmbedBootstrapMessage('5') });
  parent.dispatch({ source: child, origin: 'https://worker.example', data: createEmbedBootstrapMessage('4') });
  parent.dispatch({ source: child, origin: 'https://worker.example', data: { ...createEmbedBootstrapMessage('5'), version: 2 } });
  await delay(10);
  assert.equal(settled, false);
  parent.dispatch({ source: child, origin: 'https://worker.example', data: createEmbedBootstrapMessage('5') });
  await pending;
}

async function testTimeoutAndAbort() {
  const parent = eventTarget();
  const child = {};
  await assert.rejects(waitForEmbedChildBootstrap({
    windowRef: parent, expectedSource: child, childOrigin: 'https://worker.example', generation: '1', timeoutMs: 10,
  }), (error) => error?.code === 'EMBED_BOOTSTRAP_TIMEOUT');

  const controller = new AbortController();
  const pending = waitForEmbedChildBootstrap({
    windowRef: parent, expectedSource: child, childOrigin: 'https://worker.example', generation: '2', timeoutMs: 100,
    signal: controller.signal,
  });
  controller.abort('superseded');
  await assert.rejects(pending, (error) => error?.code === 'EMBED_BOOTSTRAP_ABORTED' && error?.name === 'AbortError');
}

function eventTarget() {
  const listeners = new Set();
  return {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
  };
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
