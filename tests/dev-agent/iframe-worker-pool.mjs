import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  IframeWorkerPool,
  DEV_WORKER_POOL_MAX,
  WORKER_FRAME_HOST_ID,
  defaultCreateFrame,
} from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { ChatGPTDOMAdapter } from '../../js/userscript/chatgpt-adapter.js';

async function testSixFramesSeventhWaitsAndReuse() {
  const frames = new FakeFrameFactory();
  const pool = newPool(frames);
  const provisioned = await pool.provision({ size: 6, timeoutMs: 2000 });
  assert.equal(provisioned.readyCount, DEV_WORKER_POOL_MAX);
  assert.equal(frames.created.length, 6, 'each Worker gets its own same-origin iframe');
  assert.deepEqual([...new Set(frames.created.map((frame) => frame.src))], ['https://chatgpt.com/']);

  const leases = [];
  for (let index = 0; index < 6; index++) leases.push(await pool.claim({ taskId: `task-${index}` }));
  assert.equal(new Set(leases.map((lease) => lease.slot)).size, 6, 'six distinct frames must be claimable');
  assert.equal(pool.status().claimedCount, 6);

  let seventhSettled = false;
  const seventh = pool.claim({ taskId: 'task-7' }).then((value) => { seventhSettled = true; return value; });
  await tick();
  assert.equal(seventhSettled, false, 'seventh claim must wait while all six frames are occupied');

  await pool.createChat({ leaseId: leases[0].leaseId });
  await pool.start({ leaseId: leases[0].leaseId, instruction: 'worker zero' });
  const firstResult = await waitForResult(pool, leases[0].leaseId);
  assert.equal(firstResult.responseText, 'done:worker zero');
  await pool.release({ leaseId: leases[0].leaseId });
  const lease7 = await seventh;
  assert.equal(lease7.slot, leases[0].slot, 'freed frame must be reusable by the waiting seventh task');

  for (const lease of leases.slice(1)) await pool.release({ leaseId: lease.leaseId });
  await pool.release({ leaseId: lease7.leaseId });
  pool.close();
  assert.equal(frames.created.every((frame) => frame.removed), true, 'closing the pool must remove every Worker iframe');
}

async function testConcurrentClaimReservesSlotBeforeSettling() {
  const pool = newPool(new FakeFrameFactory());
  await pool.provision({ size: 1, timeoutMs: 2000 });
  const firstClaim = pool.claim({ taskId: 'first', wait: false });
  await assert.rejects(
    pool.claim({ taskId: 'second', wait: false }),
    (error) => error?.code === 'worker-pool-full',
    'a frame whose claim is still settling must already be reserved locally',
  );
  const lease = await firstClaim;
  assert.equal(lease.slot, 1);
  await pool.release({ leaseId: lease.leaseId });
  pool.close();
}

async function testBlockedEmbeddingIsReportedExactly() {
  const blocked = new FakeFrameFactory({ crossOrigin: true });
  const blockedPool = newPool(blocked);
  const blockedResult = await blockedPool.provision({ size: 1, timeoutMs: 60 });
  assert.equal(blockedResult.readyCount, 0);
  assert.equal(blockedResult.slots[0].error.code, 'worker-frame-blocked');
  blockedPool.close();

  const silent = new FakeFrameFactory({ composer: false });
  const silentPool = newPool(silent);
  const silentResult = await silentPool.provision({ size: 1, timeoutMs: 60 });
  assert.equal(silentResult.slots[0].error.code, 'worker-frame-timeout', 'a loaded frame without a composer is not an embedding block');
  silentPool.close();

  const unavailable = newPool(new FakeFrameFactory(), { createFrame: () => null });
  const unavailableResult = await unavailable.provision({ size: 1, timeoutMs: 60 });
  assert.equal(unavailableResult.slots[0].error.code, 'worker-frame-unavailable');
  unavailable.close();
}

async function testCrossOriginProjectUrlFailsClosed() {
  const pool = newPool(new FakeFrameFactory());
  await assert.rejects(
    pool.provision({ size: 1, projectUrl: 'https://chat.openai.com/g/g-p-demo/project' }),
    (error) => error?.code === 'worker-frame-origin',
    'a Worker frame on another origin could never be driven, so provisioning must fail closed',
  );
  await assert.rejects(
    pool.provision({ size: 1, projectUrl: 'https://evil.example/project' }),
    (error) => error?.code === 'worker-frame-origin',
  );
  const scoped = await pool.provision({ size: 1, projectUrl: 'https://chatgpt.com/g/g-p-demo/project#hex', timeoutMs: 2000 });
  assert.equal(scoped.readyCount, 1);
  pool.close();
}

function testOffscreenFrameHost() {
  const document = new FakeDocument();
  const handle = defaultCreateFrame({ slot: 3, documentRef: document });
  const host = document.getElementById(WORKER_FRAME_HOST_ID);
  assert.ok(host, 'Worker frames live in one dedicated host element');
  assert.doesNotMatch(host.style.cssText, /display\s*:\s*none|visibility\s*:\s*hidden/, 'a non-rendered frame never mounts the ChatGPT composer');
  assert.match(host.style.cssText, /position:fixed/);
  assert.match(handle.frame.style.cssText, /width:1024px/);
  assert.equal(handle.frame.getAttribute('aria-hidden'), 'true');
  handle.close();
  assert.equal(document.getElementById(WORKER_FRAME_HOST_ID), null, 'the host is removed with its last frame');
}

function testAdapterUsesWorkerFrameRealm() {
  const observed = [];
  class FrameObserver { observe() { observed.push('observe'); } disconnect() {} }
  class FrameEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); this.realm = 'frame'; } }
  const dispatched = [];
  const node = { tagName: 'DIV', focus() {}, dispatchEvent(event) { dispatched.push(event); return true; } };
  const view = { MutationObserver: FrameObserver, Event: FrameEvent, InputEvent: FrameEvent, getSelection: () => null };
  const document = { querySelector: () => null, querySelectorAll: () => [], createRange: () => null, documentElement: {} };
  const adapter = new ChatGPTDOMAdapter({ document, view, location: { href: 'https://chatgpt.com/' } });
  adapter.setComposerText(node, 'hello');
  assert.deepEqual(dispatched.map((event) => event.realm), ['frame', 'frame'], 'composer events must be built in the Worker frame realm');
  adapter.observeMutations({}, () => {});
  assert.deepEqual(observed, ['observe'], 'mutation observers must come from the Worker frame realm');
}

function newPool(frames, overrides = {}) {
  return new IframeWorkerPool({
    maxWorkers: 6,
    createFrame: (args) => frames.create(args),
    createWorkerRuntime: ({ slot, document }) => fakeWorkerRuntime(slot, document),
    documentRef: new FakeDocument(),
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    sleep: async () => tick(),
    ...overrides,
  });
}

class FakeFrameFactory {
  constructor({ crossOrigin = false, composer = true } = {}) {
    this.crossOrigin = crossOrigin;
    this.composer = composer;
    this.created = [];
  }
  create({ slot }) {
    const factory = this;
    const frame = {
      slot,
      src: null,
      removed: false,
      style: { cssText: '' },
      get contentDocument() {
        if (factory.crossOrigin) throw new Error('Blocked a frame with origin "https://chatgpt.com" from accessing a cross-origin frame.');
        return this.src ? { readyState: 'complete', composer: factory.composer } : null;
      },
    };
    this.created.push(frame);
    return {
      frame,
      async navigate(href) { frame.src = href; },
      close() { frame.removed = true; },
    };
  }
}

function fakeWorkerRuntime(slot, document) {
  let claim = null;
  let result = null;
  const coordinator = {
    async discover() { return [{ tabNodeId: `frame-${slot}`, role: claim ? 'worker' : 'available', claimed: !!claim, dedicatedFrame: true }]; },
    async claim(args) { claim = { runId: args.runId, workerId: args.workerId }; return { tabNodeId: `frame-${slot}`, ...claim, claimed: true, dedicatedFrame: true }; },
    async createChat(args) { verify(args); return { ...claim, prepared: true }; },
    async send(args) { verify(args); await tick(); result = { status: 'completed', responseText: `done:${args.instruction}`, chatgptConversationId: `c-${slot}` }; return result; },
    async observe(args) { verify(args); return { status: result?.status || 'available' }; },
    async followup(args) { verify(args); result = { status: 'completed', responseText: `follow:${args.text}` }; return result; },
    async nudge(args) { verify(args); return { outcome: 'still-working' }; },
    async stop(args) { verify(args); return { outcome: 'not-running' }; },
    async result(args) { verify(args); return result || { status: 'available' }; },
    async release(args) { verify(args); claim = null; result = null; return { role: 'available', claimed: false }; },
    close() {},
  };
  return { coordinator, ready: () => !!document?.composer, close() { coordinator.close(); } };
  function verify(args) { assert.equal(args.runId, claim?.runId); assert.equal(args.workerId, claim?.workerId); }
}

class FakeDocument {
  constructor() {
    this.documentElement = { children: [], append(node) { node.parent = this; this.children.push(node); } };
  }
  createElement(tag) {
    return {
      tag, id: '', title: '', style: { cssText: '' }, attributes: new Map(), children: [], parent: null,
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      append(child) { child.parent = this; this.children.push(child); },
      querySelector(selector) { return this.children.find((child) => child.tag === selector) || null; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; },
    };
  }
  getElementById(id) { return this.documentElement.children.find((node) => node.id === id) || null; }
}

async function waitForResult(pool, leaseId) {
  for (let index = 0; index < 20; index++) {
    const result = await pool.result({ leaseId });
    if (result.status !== 'working') return result;
    await tick();
  }
  throw new Error('pool result did not settle');
}
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

await testSixFramesSeventhWaitsAndReuse();
await testConcurrentClaimReservesSlotBeforeSettling();
await testBlockedEmbeddingIsReportedExactly();
await testCrossOriginProjectUrlFailsClosed();
testOffscreenFrameHost();
testAdapterUsesWorkerFrameRealm();
console.log('iframe worker pool: ok');
