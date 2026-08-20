import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  IframeWorkerPool,
  DEV_WORKER_POOL_MAX,
  WORKER_FRAME_HOST_ID,
  defaultCreateFrame,
} from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { ChatGPTDOMAdapter } from '../../js/userscript/chatgpt-adapter.js';

/* The Pool attaches its own handlers to every started turn. A rejected Worker
   send must therefore become a retained failed result, never a process-level
   unhandled rejection. */
const unhandledRejections = [];
process.on('unhandledRejection', (reason) => unhandledRejections.push(reason));

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

async function testNavigationDocumentReplacementRebindsRuntime() {
  const initialDocument = { readyState: 'complete', composer: false, location: { href: 'about:blank' } };
  const committedDocument = { readyState: 'complete', composer: true, location: { href: 'https://chatgpt.com/' } };
  let activeDocument = initialDocument;
  const runtimes = [];
  const frame = {
    src: null, removed: false,
    get contentDocument() { return activeDocument; },
  };
  const pool = new IframeWorkerPool({
    maxWorkers: 1,
    createFrame: () => ({
      frame,
      async navigate(href) {
        frame.src = href;
        // A real iframe exposes its initial about:blank Document before the
        // first cross-document navigation commits a replacement Document.
        setTimeout(() => { activeDocument = committedDocument; }, 0);
      },
      close() { frame.removed = true; },
    }),
    createWorkerRuntime: ({ slot, document }) => {
      const runtime = fakeWorkerRuntime(slot, document);
      runtime.boundDocument = document;
      runtime.closed = false;
      const close = runtime.close.bind(runtime);
      runtime.close = () => { runtime.closed = true; close(); };
      runtimes.push(runtime);
      return runtime;
    },
    documentRef: new FakeDocument(),
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    sleep: async () => tick(),
  });

  const provisioned = await pool.provision({ size: 1, timeoutMs: 120 });
  assert.equal(provisioned.readyCount, 1, 'the committed ChatGPT Document must become the authoritative Worker realm');
  assert.equal(runtimes.length, 2, 'runtime must be rebound exactly once when navigation replaces the initial Document');
  assert.equal(runtimes[0].boundDocument, initialDocument);
  assert.equal(runtimes[0].closed, true, 'the runtime bound to initial about:blank must be retired');
  assert.equal(runtimes[1].boundDocument, committedDocument);
  pool.close();
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

/* Characterization of the completion ownership contract the Pool implements
   today: an active turn is pending, a settled turn is a retained terminal
   result, and neither survives the lease that produced it. */
async function testCompletionOwnershipIsRetainedPerLease() {
  const runtimes = new ControlledRuntimes();
  const pool = newPool(new FakeFrameFactory(), { createWorkerRuntime: ({ slot }) => runtimes.create(slot) });
  await pool.provision({ size: 2, timeoutMs: 2000 });

  const first = await pool.claim({ taskId: 'char-first' });
  const second = await pool.claim({ taskId: 'char-second' });
  await pool.createChat({ leaseId: first.leaseId });
  await pool.createChat({ leaseId: second.leaseId });

  const started = await pool.start({ leaseId: first.leaseId, instruction: 'first turn' });
  assert.equal(started.started, true);
  assert.equal(started.working, true, 'start must mark the slot as actively pending');
  assert.equal(publicSlot(pool, first.slot).working, true);
  assert.equal((await pool.result({ leaseId: first.leaseId })).status, 'working', 'an active turn has no terminal result yet');
  await assert.rejects(
    pool.start({ leaseId: first.leaseId, instruction: 'second turn on one lease' }),
    (error) => error?.code === 'worker-busy',
    'a slot with an active turn must refuse a second start',
  );
  await assert.rejects(
    pool.release({ leaseId: first.leaseId }),
    (error) => error?.code === 'worker-busy',
    'release must be refused while the Worker is still generating',
  );
  assert.equal(pool.status().claimedCount, 2, 'a refused release keeps the lease owned');

  await pool.start({ leaseId: second.leaseId, instruction: 'second turn' });
  runtimes.get(second.slot).complete({ status: 'completed', responseText: 'second done', chatgptConversationId: 'c-second' });
  await settle();
  assert.equal(publicSlot(pool, second.slot).working, false, 'the completed Worker settles');
  assert.equal(publicSlot(pool, first.slot).working, true, 'one Worker completing must never settle another');
  assert.equal((await pool.result({ leaseId: second.leaseId })).responseText, 'second done');
  assert.equal((await pool.result({ leaseId: first.leaseId })).status, 'working');

  runtimes.get(first.slot).complete({ status: 'completed', responseText: 'first done', chatgptConversationId: 'c-first' });
  await settle();
  assert.equal(publicSlot(pool, first.slot).working, false, 'settlement clears the active pending state');
  const retained = await pool.result({ leaseId: first.leaseId });
  assert.equal(retained.status, 'completed');
  assert.equal(retained.responseText, 'first done');
  assert.deepEqual(await pool.result({ leaseId: first.leaseId }), retained, 'a retained terminal result is stable across repeated reads');
  assert.equal(runtimes.get(first.slot).resultCalls, 0, 'the retained result is the authority; the Worker is not re-asked');
  assert.equal(publicSlot(pool, first.slot).chatgptConversationId, 'c-first');

  await pool.release({ leaseId: first.leaseId });
  await assert.rejects(
    pool.result({ leaseId: first.leaseId }),
    (error) => error?.code === 'lease-missing',
    'a released lease can no longer read the Worker',
  );
  const released = publicSlot(pool, first.slot);
  assert.equal(released.claimed, false);
  assert.equal(released.leaseId, null);
  assert.equal(released.workerId, null);
  assert.equal(released.taskId, null);
  assert.equal(released.chatgptConversationId, null, 'the retained result must not survive its lease');

  const reclaimed = await pool.claim({ taskId: 'char-reclaim' });
  assert.equal(reclaimed.slot, first.slot, 'the released frame is reusable');
  assert.notEqual(reclaimed.leaseId, first.leaseId, 'reclaim mints a fresh leaseId');
  assert.notEqual(reclaimed.workerId, first.workerId, 'reclaim mints a fresh workerId');
  const identities = runtimes.get(first.slot).claims;
  assert.equal(identities.length, 2);
  assert.notEqual(identities[1].runId, identities[0].runId, 'reclaim mints a fresh runId');
  assert.notEqual(identities[1].workerId, identities[0].workerId);
  await assert.rejects(
    pool.result({ leaseId: first.leaseId }),
    (error) => error?.code === 'lease-missing',
    'the stale lease stays invalid after the slot is reclaimed',
  );

  await pool.release({ leaseId: reclaimed.leaseId });
  await pool.release({ leaseId: second.leaseId });
  pool.close();
}

async function testRejectedWorkerTurnBecomesRetainedFailure() {
  const runtimes = new ControlledRuntimes();
  const pool = newPool(new FakeFrameFactory(), { createWorkerRuntime: ({ slot }) => runtimes.create(slot) });
  await pool.provision({ size: 1, timeoutMs: 2000 });
  const lease = await pool.claim({ taskId: 'char-failure' });
  await pool.createChat({ leaseId: lease.leaseId });
  await pool.start({ leaseId: lease.leaseId, instruction: 'doomed turn' });

  const transport = new Error('the Worker frame went away');
  transport.code = 'transport-failure';
  runtimes.get(lease.slot).fail(transport);
  await settle();

  assert.equal(publicSlot(pool, lease.slot).working, false, 'a rejected turn clears the active pending state');
  const failure = await pool.result({ leaseId: lease.leaseId });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error.code, 'transport-failure');
  assert.match(failure.error.message, /Worker frame went away/);
  assert.deepEqual(await pool.result({ leaseId: lease.leaseId }), failure, 'a retained failure is stable across repeated reads');
  assert.equal(runtimes.get(lease.slot).resultCalls, 0);

  await pool.release({ leaseId: lease.leaseId });
  assert.equal(publicSlot(pool, lease.slot).claimed, false, 'release clears ownership after a failed turn too');
  pool.close();
  await settle();
  assert.deepEqual(unhandledRejections, [], 'a rejected Worker send must never escape as an unhandled rejection');
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
    const contentDocument = { readyState: 'complete', composer: factory.composer };
    const frame = {
      slot,
      src: null,
      removed: false,
      style: { cssText: '' },
      get contentDocument() {
        if (factory.crossOrigin) throw new Error('Blocked a frame with origin "https://chatgpt.com" from accessing a cross-origin frame.');
        return this.src ? contentDocument : null;
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

/* A Worker turn that only settles when the test says so. The real Pool owns the
   send promise, so completion timing is the only thing a characterization test
   needs to control. */
class ControlledRuntimes {
  constructor() { this.bySlot = new Map(); }
  create(slot) {
    const state = { slot, claims: [], resultCalls: 0, releaseCalls: 0, pending: null };
    let claim = null;
    const verify = (args) => { assert.equal(args.runId, claim?.runId); assert.equal(args.workerId, claim?.workerId); };
    const coordinator = {
      async claim(args) { claim = { runId: args.runId, workerId: args.workerId }; state.claims.push({ ...claim }); return { ...claim, claimed: true, dedicatedFrame: true }; },
      async createChat(args) { verify(args); return { ...claim, prepared: true }; },
      async send(args) { verify(args); return new Promise((resolve, reject) => { state.pending = { resolve, reject }; }); },
      async followup(args) { verify(args); return { status: 'completed', responseText: `follow:${args.text}` }; },
      async nudge(args) { verify(args); return { outcome: state.pending ? 'still-working' : 'not-running' }; },
      async stop(args) { verify(args); return { outcome: state.pending ? 'stopped' : 'not-running' }; },
      async observe(args) { verify(args); return { status: state.pending ? 'working' : 'available' }; },
      async result(args) { verify(args); state.resultCalls += 1; return { status: state.pending ? 'working' : 'available' }; },
      async release(args) { verify(args); state.releaseCalls += 1; claim = null; return { role: 'available', claimed: false }; },
      close() { claim = null; state.pending = null; },
    };
    state.complete = (value) => { const pending = state.pending; state.pending = null; pending.resolve(value); };
    state.fail = (error) => { const pending = state.pending; state.pending = null; pending.reject(error); };
    this.bySlot.set(slot, state);
    return { coordinator, ready: () => true, close() { coordinator.close(); } };
  }
  get(slot) { const state = this.bySlot.get(slot); assert.ok(state, `no controlled runtime for slot ${slot}`); return state; }
}

function publicSlot(pool, index) {
  const slot = pool.status().slots.find((item) => item.slot === index);
  assert.ok(slot, `slot ${index} must exist`);
  return slot;
}

/* The Pool settles a turn through chained then/finally handlers, so a single
   microtask drain is not enough to observe the retained result. */
async function settle() { for (let index = 0; index < 5; index++) await tick(); }

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
await testNavigationDocumentReplacementRebindsRuntime();
await testCrossOriginProjectUrlFailsClosed();
await testCompletionOwnershipIsRetainedPerLease();
await testRejectedWorkerTurnBecomesRetainedFailure();
testOffscreenFrameHost();
testAdapterUsesWorkerFrameRealm();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(unhandledRejections, [], 'no Pool turn in this file may escape as an unhandled rejection');
console.log('iframe worker pool: ok');
