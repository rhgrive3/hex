import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IframeWorkerPool } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { startParentDevWorkerRuntime } from '../../js/userscript/dev/parent-worker-runtime.js';

await testCompletedBeforeWait();
await testCompletionWhileWaiting();
await testCompletionAcrossSupervisorRunSwitch();
await testMultipleSimultaneousCompletions();
await testCompletionDeliveredExactlyOnce();
await testReleasedLeaseCompletionIsNotDelivered();
await testResultRetainedAfterCompletionDelivery();

console.log('iframe worker pool completion events: ok');

async function testCompletedBeforeWait() {
  const harness = await createHarness(1);
  try {
    const lease = await harness.pool.claim({ taskId: 'completed-before-wait' });
    await harness.pool.start({ leaseId: lease.leaseId, instruction: 'before' });
    await waitForResult(harness.pool, lease.leaseId);

    const event = await harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-before' });
    assert.equal(event.type, 'worker.completed');
    assert.equal(event.data.poolLeaseId, lease.leaseId);
    assert.equal(event.data.responseText, 'done:before');
  } finally {
    harness.runtime.close();
  }
}

async function testCompletionWhileWaiting() {
  const harness = await createHarness(1);
  try {
    const lease = await harness.pool.claim({ taskId: 'completion-while-waiting' });
    await harness.pool.start({ leaseId: lease.leaseId, instruction: 'during' });
    const event = await harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-waiting' });
    assert.equal(event.data.poolLeaseId, lease.leaseId);
    assert.equal(event.data.responseText, 'done:during');
  } finally {
    harness.runtime.close();
  }
}

async function testCompletionAcrossSupervisorRunSwitch() {
  const harness = await createHarness(1);
  try {
    const lease = await harness.pool.claim({ taskId: 'run-switch' });
    await harness.pool.start({ leaseId: lease.leaseId, instruction: 'switch' });
    await waitForResult(harness.pool, lease.leaseId);

    // The pool lease is still authoritative even if the Supervisor loop has
    // materialized a fresh run object before it registers its next event wait.
    const event = await harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-after-switch' });
    assert.equal(event.data.poolLeaseId, lease.leaseId);
    assert.equal(event.data.responseText, 'done:switch');
  } finally {
    harness.runtime.close();
  }
}

async function testMultipleSimultaneousCompletions() {
  const harness = await createHarness(2);
  try {
    const first = await harness.pool.claim({ taskId: 'multi-a' });
    const second = await harness.pool.claim({ taskId: 'multi-b' });
    await Promise.all([
      harness.pool.start({ leaseId: first.leaseId, instruction: 'multi-a' }),
      harness.pool.start({ leaseId: second.leaseId, instruction: 'multi-b' }),
    ]);
    await Promise.all([
      waitForResult(harness.pool, first.leaseId),
      waitForResult(harness.pool, second.leaseId),
    ]);

    const events = await Promise.all([
      harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-multi' }),
      harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-multi' }),
    ]);
    assert.deepEqual(
      new Set(events.map((event) => event.data.poolLeaseId)),
      new Set([first.leaseId, second.leaseId]),
      'each simultaneous completion must be delivered independently',
    );
    assert.equal(new Set(events.map((event) => event.data.completionId)).size, 2);
  } finally {
    harness.runtime.close();
  }
}

async function testCompletionDeliveredExactlyOnce() {
  const harness = await createHarness(1);
  try {
    const lease = await harness.pool.claim({ taskId: 'exactly-once' });
    await harness.pool.start({ leaseId: lease.leaseId, instruction: 'once' });
    const first = await harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-once' });
    assert.equal(first.data.poolLeaseId, lease.leaseId);

    await expectNoCompletion(harness.runtime, 'supervisor-run-once');
  } finally {
    harness.runtime.close();
  }
}

async function testReleasedLeaseCompletionIsNotDelivered() {
  const harness = await createHarness(1);
  try {
    const lease = await harness.pool.claim({ taskId: 'released-stale' });
    await harness.pool.start({ leaseId: lease.leaseId, instruction: 'stale' });
    await waitForResult(harness.pool, lease.leaseId);
    await harness.pool.release({ leaseId: lease.leaseId });

    await expectNoCompletion(harness.runtime, 'supervisor-run-after-release');
  } finally {
    harness.runtime.close();
  }
}

async function testResultRetainedAfterCompletionDelivery() {
  const harness = await createHarness(1);
  try {
    const lease = await harness.pool.claim({ taskId: 'retained-result' });
    await harness.pool.start({ leaseId: lease.leaseId, instruction: 'retained' });
    const event = await harness.runtime.waitEvent({ events: ['worker.completed'], runId: 'supervisor-run-retained' });
    assert.equal(event.data.poolLeaseId, lease.leaseId);

    const result = await harness.pool.result({ leaseId: lease.leaseId });
    assert.equal(result.status, 'completed');
    assert.equal(result.responseText, 'done:retained');
  } finally {
    harness.runtime.close();
  }
}

async function createHarness(size) {
  const frames = new FakeFrameFactory();
  const pool = new IframeWorkerPool({
    maxWorkers: size,
    createFrame: (args) => frames.create(args),
    createWorkerRuntime: ({ slot, document }) => fakeWorkerRuntime(slot, document),
    documentRef: new FakeDocument(),
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    sleep: async () => tick(),
  });
  const provisioned = await pool.provision({ size, timeoutMs: 2000 });
  assert.equal(provisioned.readyCount, size);

  const controller = {
    on() { return () => {}; },
    currentConversation() { return { id: 'supervisor-cid', url: 'https://chatgpt.com/c/supervisor-cid' }; },
  };
  const runtime = await startParentDevWorkerRuntime({
    controller,
    workerPool: pool,
    pageInspector: {},
    skillRegistry: {},
    taskGraphHost: { close() {} },
    cryptoRef: webcrypto,
    now: () => '2026-08-19T00:00:00.000Z',
  });
  assert.equal(runtime.enabled, true);
  return { pool, runtime };
}

class FakeFrameFactory {
  create({ slot }) {
    const contentDocument = { readyState: 'complete', composer: true };
    const frame = {
      slot,
      src: null,
      removed: false,
      get contentDocument() { return this.src ? contentDocument : null; },
    };
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
    async claim(args) { claim = { runId: args.runId, workerId: args.workerId }; return { ...claim, claimed: true }; },
    async createChat(args) { verify(args); return { ...claim, prepared: true }; },
    async send(args) {
      verify(args);
      await delay(8);
      result = { status: 'completed', responseText: `done:${args.instruction}`, chatgptConversationId: `c-${slot}` };
      return result;
    },
    async observe(args) { verify(args); return { status: result?.status || 'available' }; },
    async followup(args) { verify(args); return result; },
    async nudge(args) { verify(args); return { outcome: 'still-working' }; },
    async stop(args) { verify(args); return { outcome: 'not-running' }; },
    async result(args) { verify(args); return result || { status: 'available' }; },
    async release(args) { verify(args); claim = null; result = null; return { role: 'available', claimed: false }; },
    close() {},
  };
  return { coordinator, ready: () => !!document?.composer, close() { coordinator.close(); } };

  function verify(args) {
    assert.equal(args.runId, claim?.runId);
    assert.equal(args.workerId, claim?.workerId);
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = { children: [], append(node) { node.parent = this; this.children.push(node); } };
  }
}

async function waitForResult(pool, leaseId) {
  for (let index = 0; index < 50; index++) {
    const result = await pool.result({ leaseId });
    if (result.status !== 'working') return result;
    await tick();
  }
  throw new Error('pool result did not settle');
}

async function expectNoCompletion(runtime, runId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('fixture-complete'), 20);
  try {
    await assert.rejects(
      runtime.waitEvent({ events: ['worker.completed'], runId }, { signal: controller.signal }),
      (error) => error?.name === 'AbortError',
      'no stale or duplicate completion may be delivered',
    );
  } finally {
    clearTimeout(timer);
  }
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
