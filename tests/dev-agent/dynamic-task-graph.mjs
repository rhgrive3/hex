import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { DynamicTaskGraphHost } from '../../js/userscript/dev/task-graph/dynamic-task-graph.js';
import { IframeWorkerPool, DEV_WORKER_POOL_MAX } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../../js/userscript/dev/parent-rpc.js';
import { createDevAdminToolSurface } from '../../js/ai/dev/admin/tool-surface.js';

async function testReadyOnlyParallelMaxSixAndNoDuplicates() {
  const harness = new WorkerHarness({
    rootA: { delay: 20 }, rootB: { delay: 20 }, child: { delay: 2 },
    t4: { delay: 20 }, t5: { delay: 20 }, t6: { delay: 20 }, t7: { delay: 20 },
  });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({
    graphId: 'parallel',
    maxConcurrency: 6,
    tasks: [task('rootA'), task('rootB'), task('child', ['rootA']), task('t4'), task('t5'), task('t6'), task('t7')],
  });
  const status = await waitTerminal(host, 'parallel');
  assert.equal(status.state, 'SUCCEEDED');
  assert.equal(harness.peak, DEV_WORKER_POOL_MAX, 'independent ready tasks should use all six iframe Workers but never exceed max-6');
  for (const id of ['rootA','rootB','child','t4','t5','t6','t7']) assert.equal(harness.attempts.get(id), 1, `task ${id} must execute exactly once`);
  assert.ok(harness.events.indexOf('complete:rootA') < harness.events.indexOf('start:child'), 'dependency task must dispatch only after dependency success');
  assert.equal(pool.status().claimedCount, 0, 'every completed task lease must be released');
  assert.equal(harness.sawNestingBan, true, 'graph dispatch must preserve the no-nested-Worker instruction contract');
  host.close();
  pool.close();
}

async function testRetryAndDependencyFailurePropagation() {
  const harness = new WorkerHarness({ retry: { failTimes: 1 }, afterRetry: {}, bad: { failTimes: 9 }, blocked: {} });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({
    graphId: 'retry-failure',
    tasks: [
      { ...task('retry'), maxAttempts: 2 }, task('afterRetry', ['retry']),
      task('bad'), task('blocked', ['bad']),
    ],
  });
  const status = await waitTerminal(host, 'retry-failure');
  assert.equal(status.state, 'FAILED');
  const retry = host.taskResult({ graphId: 'retry-failure', taskId: 'retry' });
  assert.equal(retry.state, 'SUCCEEDED');
  assert.equal(retry.attempts, 2);
  assert.equal(host.taskResult({ graphId: 'retry-failure', taskId: 'afterRetry' }).state, 'SUCCEEDED');
  assert.equal(host.taskResult({ graphId: 'retry-failure', taskId: 'bad' }).state, 'FAILED');
  const blocked = host.taskResult({ graphId: 'retry-failure', taskId: 'blocked' });
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.error.code, 'dependency-failed');
  assert.deepEqual(blocked.error.dependencies, ['bad']);
  assert.equal(harness.attempts.has('blocked'), false, 'failed dependencies must prevent dispatch');
  assert.equal(pool.status().claimedCount, 0);
  host.close();
  pool.close();
}

async function testTimeoutCancellationAndLeaseCleanup() {
  const timeoutHarness = new WorkerHarness({ slow: { hang: true } });
  const timeoutPool = timeoutHarness.pool();
  const timeoutHost = graphHost(timeoutPool);
  await timeoutHost.start({ graphId: 'timeout', tasks: [{ ...task('slow'), timeoutMs: 20 }] });
  const timedOut = await waitTerminal(timeoutHost, 'timeout');
  assert.equal(timedOut.state, 'FAILED');
  assert.equal(timeoutHost.taskResult({ graphId: 'timeout', taskId: 'slow' }).error.code, 'task-timeout');
  assert.equal(timeoutPool.status().claimedCount, 0, 'timeout must stop and release its Worker lease');
  timeoutHost.close();
  timeoutPool.close();

  const cancelHarness = new WorkerHarness({ hanging: { hang: true }, never: {} });
  const cancelPool = cancelHarness.pool();
  const cancelHost = graphHost(cancelPool);
  await cancelHost.start({ graphId: 'cancel', maxConcurrency: 1, tasks: [task('hanging'), task('never', ['hanging'])] });
  await waitFor(() => cancelHost.status({ graphId: 'cancel' }).tasks.some((item) => item.id === 'hanging' && item.state === 'RUNNING'));
  cancelHost.cancel({ graphId: 'cancel', reason: 'test-cancel' });
  const cancelled = await waitTerminal(cancelHost, 'cancel');
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelHost.taskResult({ graphId: 'cancel', taskId: 'hanging' }).state, 'CANCELLED');
  assert.equal(cancelHost.taskResult({ graphId: 'cancel', taskId: 'never' }).state, 'CANCELLED');
  assert.equal(cancelPool.status().claimedCount, 0, 'cancellation must clean the active lease');
  cancelHost.close();
  cancelPool.close();
}

async function testCleanupFallsBackToFrameDiscard() {
  const harness = new WorkerHarness({ discardMe: { releaseFails: true } });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({ graphId: 'cleanup-discard', tasks: [task('discardMe')] });
  const status = await waitTerminal(host, 'cleanup-discard');
  assert.equal(status.state, 'SUCCEEDED', 'safe iframe retirement preserves the completed task result');
  assert.equal(pool.status().claimedCount, 0);
  assert.equal(pool.status().slots[0].ready, false, 'ambiguous ownership must quarantine the old iframe');
  assert.equal(pool.status().slots[0].error.code, 'worker-discarded');
  host.close();
  pool.close();
}

async function testGraphValidationAndSupervisorRouting() {
  const harness = new WorkerHarness({ a: {} });
  const pool = harness.pool();
  const host = graphHost(pool);
  await assert.rejects(host.start({ graphId: 'duplicate', tasks: [task('a'), task('a')] }), (error) => error?.code === 'duplicate-task-id');
  await assert.rejects(host.start({ graphId: 'cycle', tasks: [task('a', ['b']), task('b', ['a'])] }), (error) => error?.code === 'dependency-cycle');

  const { port1, port2 } = new MessageChannel();
  const server = createDevWorkerParentRpc({ port: port1, runtime: { taskGraphStatus: (args) => ({ graphId: args.graphId, state: 'RUNNING' }) } });
  const client = createDevWorkerParentRpcClient({ port: port2, timeoutMs: 1000 });
  assert.deepEqual(await client.graphStatus({ graphId: 'rpc-graph' }), { graphId: 'rpc-graph', state: 'RUNNING' });
  const surface = createDevAdminToolSurface({ enabled: true, graphStatus: (args) => ({ graphId: args.graphId, state: 'RUNNING' }) });
  assert.equal(surface.has('worker.graph.status'), true);
  assert.deepEqual(await surface.execute('worker.graph.status', { graphId: 'surface-graph' }), { graphId: 'surface-graph', state: 'RUNNING' });
  client.close();
  server.close();
  port1.close();
  port2.close();
  host.close();
  pool.close();
}

function task(id, dependencies = []) {
  return { id, dependencies, instruction: id, timeoutMs: 500, maxAttempts: 1 };
}

function graphHost(workerPool) {
  return new DynamicTaskGraphHost({ workerPool, cryptoRef: webcrypto, pollMs: 1, cleanupTimeoutMs: 50 });
}

async function waitTerminal(host, graphId, timeoutMs = 2500) {
  let status = null;
  await waitFor(() => {
    status = host.status({ graphId });
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state);
  }, timeoutMs);
  return status;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition did not settle');
}

class WorkerHarness {
  constructor(behaviors = {}) {
    this.behaviors = behaviors;
    this.attempts = new Map();
    this.events = [];
    this.active = 0;
    this.peak = 0;
    this.sawNestingBan = false;
    this.frames = [];
  }

  pool() {
    return new IframeWorkerPool({
      maxWorkers: 6,
      createFrame: ({ slot }) => this.createFrame(slot),
      createWorkerRuntime: ({ slot, document }) => this.createRuntime(slot, document),
      documentRef: { documentElement: {} },
      cryptoRef: webcrypto,
      location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
  }

  createFrame(slot) {
    const frame = {
      slot,
      src: null,
      removed: false,
      get contentDocument() { return this.src ? { composer: true } : null; },
    };
    this.frames.push(frame);
    return {
      frame,
      async navigate(href) { frame.src = href; },
      close() { frame.removed = true; },
    };
  }

  createRuntime(slot, document) {
    const harness = this;
    let claim = null;
    let current = null;
    let last = null;
    let currentTask = null;
    const coordinator = {
      async claim(args) {
        claim = { runId: args.runId, workerId: args.workerId };
        return { ...claim, claimed: true };
      },
      async createChat(args) {
        verify(args);
        return { prepared: true };
      },
      async send(args) {
        verify(args);
        harness.sawNestingBan ||= String(args.instruction).includes('Do not spawn, create, delegate to, or manage subagents or other Workers.');
        currentTask = assignedTask(args.instruction);
        const attempt = (harness.attempts.get(currentTask) || 0) + 1;
        harness.attempts.set(currentTask, attempt);
        const behavior = harness.behaviors[currentTask] || {};
        harness.events.push(`start:${currentTask}`);
        harness.active += 1;
        harness.peak = Math.max(harness.peak, harness.active);
        return new Promise((resolve) => {
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            if (current?.timer) clearTimeout(current.timer);
            harness.active -= 1;
            last = value;
            harness.events.push(`complete:${currentTask}`);
            current = null;
            resolve(value);
          };
          current = { finish, timer: null };
          if (behavior.hang) return;
          current.timer = setTimeout(() => {
            if (attempt <= Number(behavior.failTimes || 0)) finish({ status: 'failed', error: { code: 'fixture-failure', message: `failed ${currentTask}` } });
            else finish({ status: 'completed', responseText: `done:${currentTask}`, chatgptConversationId: `c-${slot}-${attempt}` });
          }, Number(behavior.delay || 1));
        });
      },
      async stop(args) {
        verify(args);
        current?.finish({ status: 'cancelled', error: { code: 'cancelled', message: 'stopped' } });
        return { outcome: 'stopped' };
      },
      async result(args) {
        verify(args);
        return last || { status: current ? 'working' : 'available' };
      },
      async release(args) {
        verify(args);
        const behavior = harness.behaviors[currentTask] || {};
        if (behavior.releaseFails) {
          const error = new Error('fixture release failure');
          error.code = 'transport-failure';
          throw error;
        }
        claim = null;
        last = null;
        currentTask = null;
        return { claimed: false };
      },
      async observe(args) { verify(args); return { status: current ? 'working' : last?.status || 'available' }; },
      async followup(args) { verify(args); return { status: 'completed' }; },
      async nudge(args) { verify(args); return { outcome: 'still-working' }; },
      close() {
        current?.finish({ status: 'cancelled', error: { code: 'cancelled', message: 'frame-closed' } });
        claim = null;
      },
    };
    return { coordinator, ready: () => !!document?.composer, close() { coordinator.close(); } };

    function verify(args) {
      assert.equal(args.runId, claim?.runId);
      assert.equal(args.workerId, claim?.workerId);
    }
  }
}

function assignedTask(instruction) {
  const text = String(instruction || '');
  const marker = '\nASSIGNED TASK\n';
  const index = text.lastIndexOf(marker);
  return (index >= 0 ? text.slice(index + marker.length) : text).trim();
}

await testReadyOnlyParallelMaxSixAndNoDuplicates();
await testRetryAndDependencyFailurePropagation();
await testTimeoutCancellationAndLeaseCleanup();
await testCleanupFallsBackToFrameDiscard();
await testGraphValidationAndSupervisorRouting();
console.log('dynamic task graph: ok');
