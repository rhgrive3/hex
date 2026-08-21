import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { DynamicTaskGraphHost, devAttemptTraceDurations } from '../../js/userscript/dev/task-graph/dynamic-task-graph.js';
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
  const harness = new WorkerHarness({ retry: { failTimes: 1, releaseFailsTimes: 1 }, afterRetry: {}, bad: { failTimes: 9 }, blocked: {} });
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
  assert.equal(retry.attempts, 2, 'retry must continue after the first failed attempt');
  assert.equal(harness.frames.some((frame) => frame.removed), true, 'failed release must retire the ambiguous iframe before retry');
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
  const harness = new WorkerHarness({ discardMe: { releaseFailsTimes: 1 } });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({ graphId: 'cleanup-discard', maxConcurrency: 1, tasks: [task('discardMe')] });
  const status = await waitTerminal(host, 'cleanup-discard');
  assert.equal(status.state, 'SUCCEEDED', 'safe iframe retirement preserves the completed task result');
  assert.equal(pool.status().claimedCount, 0);
  assert.equal(pool.status().readyCount, 1, 'discard must replace the retired iframe so the pool remains usable');
  assert.equal(harness.frames.length, 2, 'one fresh iframe must replace the retired Worker slot');
  assert.equal(harness.frames[0].removed, true, 'the ambiguously owned iframe must be physically retired before replacement');
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

/* Characterization of the dispatch contract the Graph implements today: every
   attempt claims its own lease and issues exactly one Pool start under it, and
   SUCCEEDED reports Worker execution only. A Worker finishing is not verified
   engineering completion, and the Graph surface must never imply otherwise. */
async function testOneStartPerLeaseAttemptAndExecutionOnlySuccess() {
  const harness = new WorkerHarness({ retry: { failTimes: 1 }, solo: {} });
  const pool = harness.pool();
  const observed = observedPool(pool);
  const host = graphHost(observed);
  await host.start({
    graphId: 'one-start',
    maxConcurrency: 2,
    tasks: [{ ...task('retry'), maxAttempts: 2 }, task('solo')],
  });
  const status = await waitTerminal(host, 'one-start');
  assert.equal(status.state, 'SUCCEEDED');
  assert.equal(harness.attempts.get('retry'), 2, 'the fixture must exercise a real retry');
  assert.equal(harness.attempts.get('solo'), 1);

  assert.equal(observed.calls.starts.length, 3, 'three attempts issue three Pool starts');
  assert.equal(observed.calls.claims.length, 3, 'every attempt claims its own lease');
  assert.equal(new Set(observed.calls.starts).size, 3, 'no lease is started twice');
  assert.deepEqual(
    [...observed.calls.starts].sort(),
    observed.calls.claims.map((claim) => claim.leaseId).sort(),
    'every started lease is exactly the lease that attempt claimed',
  );
  const retryLeases = observed.calls.claims.filter((claim) => claim.taskId === 'retry').map((claim) => claim.leaseId);
  assert.equal(retryLeases.length, 2);
  assert.notEqual(retryLeases[0], retryLeases[1], 'a retry runs under a fresh lease, never the failed one');
  assert.equal(pool.status().claimedCount, 0, 'no lease outlives its attempt');

  const solo = host.taskResult({ graphId: 'one-start', taskId: 'solo' });
  assert.equal(solo.state, 'SUCCEEDED');
  assert.equal(solo.result.status, 'completed', 'SUCCEEDED reflects the Worker execution outcome only');
  for (const claim of ['accepted', 'acceptance', 'approved', 'verified', 'supervisorAccepted', 'review', 'reviewed']) {
    assert.equal(claim in solo, false, `task result must not assert ${claim}`);
    assert.equal(claim in status, false, `graph status must not assert ${claim}`);
  }

  host.close();
  pool.close();
}

/* Records the exact Pool calls the Graph makes without changing any of them. */
function observedPool(pool) {
  const calls = { claims: [], starts: [], results: [], releases: [], waits: [] };
  return {
    calls,
    provision: (args) => pool.provision(args),
    status: () => pool.status(),
    async claim(args) {
      const lease = await pool.claim(args);
      calls.claims.push({ leaseId: lease.leaseId, slot: lease.slot, taskId: args?.taskId ?? null });
      return lease;
    },
    createChat: (args) => pool.createChat(args),
    start(args) {
      // Recorded when issued, not when it resolves: a refused duplicate start is
      // still a second start against the same lease.
      calls.starts.push(String(args?.leaseId || ''));
      return pool.start(args);
    },
    result(args) {
      calls.results.push(String(args?.leaseId || ''));
      return pool.result(args);
    },
    waitResult(args, options) {
      calls.waits.push(String(args?.leaseId || ''));
      return pool.waitResult(args, options);
    },
    stop: (args) => pool.stop(args),
    async release(args) {
      calls.releases.push(String(args?.leaseId || ''));
      return pool.release(args);
    },
    discard: (args) => pool.discard(args),
  };
}

/* CARD C's core claim: a long model turn costs the Graph nothing. The Pool wakes
   it once, so nothing re-reads the turn on a cadence while the Worker generates,
   and two turns in flight settle through their own waits. */
async function testLongTurnIsAwaitedNotPolled() {
  const harness = new WorkerHarness({ slowA: { hang: true }, slowB: { hang: true } });
  const pool = harness.pool();
  const observed = observedPool(pool);
  const host = graphHost(observed);
  await host.start({
    graphId: 'no-poll',
    maxConcurrency: 2,
    tasks: [{ ...task('slowA'), timeoutMs: 5000 }, { ...task('slowB'), timeoutMs: 5000 }],
  });
  await waitFor(() => host.status({ graphId: 'no-poll' }).tasks.every((item) => item.state === 'RUNNING'));
  await waitFor(() => observed.calls.waits.length === 2);

  // This host is configured with pollMs: 1, so the previous implementation would
  // have issued hundreds of result() reads across this window.
  const readsBefore = observed.calls.results.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(observed.calls.results.length, readsBefore, 'an active Worker turn must never be re-read on a timer');
  assert.equal(observed.calls.waits.length, 2, 'one wait per attempt, not one per scan');
  assert.deepEqual(
    [...observed.calls.waits].sort(),
    observed.calls.claims.map((claim) => claim.leaseId).sort(),
    'each attempt waits on exactly the lease it claimed',
  );
  assert.equal(host.status({ graphId: 'no-poll' }).activeCount, 2, 'both tasks are still running');

  // Independent settlement: finishing one turn must not settle the other.
  harness.finish('slowA', { status: 'completed', responseText: 'a done' });
  await waitFor(() => host.taskResult({ graphId: 'no-poll', taskId: 'slowA' }).state === 'SUCCEEDED');
  const stillRunning = host.taskResult({ graphId: 'no-poll', taskId: 'slowB' });
  assert.equal(stillRunning.state, 'RUNNING', 'one completion must not settle another task');
  assert.equal(stillRunning.finishedAt, null);

  // A terminal task transitions once: cancelling the graph afterwards must not
  // rewrite the result it already earned.
  const succeeded = host.taskResult({ graphId: 'no-poll', taskId: 'slowA' });
  host.cancel({ graphId: 'no-poll', reason: 'test-terminal-once' });
  const cancelled = await waitTerminal(host, 'no-poll');
  assert.equal(cancelled.state, 'CANCELLED');
  const afterCancel = host.taskResult({ graphId: 'no-poll', taskId: 'slowA' });
  assert.equal(afterCancel.state, 'SUCCEEDED', 'an already-terminal task must not transition twice');
  assert.equal(afterCancel.finishedAt, succeeded.finishedAt, 'its terminal timestamp is written once');
  assert.deepEqual(afterCancel.result, succeeded.result);
  assert.equal(host.taskResult({ graphId: 'no-poll', taskId: 'slowB' }).state, 'CANCELLED');
  assert.equal(pool.status().claimedCount, 0, 'cancellation still completes the lease cleanup transaction');

  host.close();
  pool.close();
}

/* CARD E: a deadline is something a caller asks for, not something every task
   silently inherits. A long model turn is not evidence of a stall, so an
   ordinary task simply waits. */
async function testDeadlineIsExplicitOrAbsent() {
  const harness = new WorkerHarness({ unbounded: { hang: true }, bounded: { hang: true } });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({
    graphId: 'deadlines',
    maxConcurrency: 2,
    tasks: [
      { id: 'unbounded', dependencies: [], instruction: 'unbounded', maxAttempts: 1 },
      { id: 'bounded', dependencies: [], instruction: 'bounded', maxAttempts: 1, timeoutMs: 20 },
    ],
  });

  // The bounded task proves the deadline mechanism still works in this very run,
  // so the unbounded task staying RUNNING is the absence of a deadline, not a
  // dead mechanism.
  await waitFor(() => host.taskResult({ graphId: 'deadlines', taskId: 'bounded' }).state === 'FAILED');
  assert.equal(host.taskResult({ graphId: 'deadlines', taskId: 'bounded' }).error.code, 'task-timeout');

  await new Promise((resolve) => setTimeout(resolve, 150));
  const unbounded = host.taskResult({ graphId: 'deadlines', taskId: 'unbounded' });
  assert.equal(unbounded.state, 'RUNNING', 'a task with no explicit deadline must not be timed out');
  assert.equal(unbounded.timeoutMs, null, 'no deadline is reported as null, not as a fabricated default');
  assert.equal(host.taskResult({ graphId: 'deadlines', taskId: 'bounded' }).timeoutMs, 20);

  harness.finish('unbounded', { status: 'completed', responseText: 'unbounded done' });
  await waitTerminal(host, 'deadlines');
  assert.equal(host.taskResult({ graphId: 'deadlines', taskId: 'unbounded' }).state, 'SUCCEEDED');
  host.close();
  pool.close();

  // An explicit deadline is still normalized and bounded by the same policy.
  const bounds = new WorkerHarness({ a: {} });
  const boundsPool = bounds.pool();
  const boundsHost = graphHost(boundsPool);
  await boundsHost.start({
    graphId: 'bounds',
    tasks: [{ id: 'a', dependencies: [], instruction: 'a', maxAttempts: 1, timeoutMs: 99 * 60 * 1000 }],
  });
  assert.equal(boundsHost.taskResult({ graphId: 'bounds', taskId: 'a' }).timeoutMs, 30 * 60 * 1000, 'an explicit deadline stays under the maximum');
  await waitTerminal(boundsHost, 'bounds');
  await assert.rejects(
    boundsHost.start({ graphId: 'bad', tasks: [{ id: 'a', dependencies: [], instruction: 'a', timeoutMs: 'soon' }] }),
    (error) => error instanceof TypeError,
    'a non-numeric deadline is rejected rather than silently defaulted',
  );
  boundsHost.close();
  boundsPool.close();
}

/* The cooperative half of the same contract: when the Worker does answer stop,
   quiescence is proven and the frame is released cleanly. Retiring a frame is
   the fail-closed branch, not the ordinary cost of a deadline. */
async function testDeadlineReleasesCleanlyWhenTheWorkerStops() {
  const harness = new WorkerHarness({ polite: { hang: true }, after: {} });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({
    graphId: 'polite-deadline',
    maxConcurrency: 1,
    tasks: [
      { id: 'polite', dependencies: [], instruction: 'polite', maxAttempts: 1, timeoutMs: 20 },
      { id: 'after', dependencies: [], instruction: 'after', maxAttempts: 1 },
    ],
  });
  const status = await waitTerminal(host, 'polite-deadline');
  assert.equal(status.state, 'FAILED');
  assert.equal(host.taskResult({ graphId: 'polite-deadline', taskId: 'polite' }).error.code, 'task-timeout');
  assert.equal(host.taskResult({ graphId: 'polite-deadline', taskId: 'after' }).state, 'SUCCEEDED');

  assert.equal(harness.events.includes('stop:polite'), true, 'the deadline asks the Worker to stop before releasing it');
  assert.ok(
    harness.events.indexOf('stop:polite') < harness.events.indexOf('start:after'),
    'the next task starts only after the previous turn is quiescent',
  );
  assert.equal(harness.frames.length, 1, 'a Worker that answers stop is released cleanly, not retired');
  assert.equal(harness.frames[0].removed, false);
  assert.equal(pool.status().claimedCount, 0);
  host.close();
  pool.close();
}

/* A deadline or a cancellation is a decision to stop waiting. It is not proof
   that the Worker stopped. Ownership must survive until the existing cleanup
   transaction proves quiescence, or the frame must be retired. */
async function testDeadlineDoesNotMakeAnActiveWorkerReusable() {
  // One frame, so any premature reuse would be immediately visible.
  const harness = new WorkerHarness({ stubborn: { hang: true, ignoresStop: true }, next: {} });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({
    graphId: 'quiescence',
    maxConcurrency: 1,
    tasks: [
      { id: 'stubborn', dependencies: [], instruction: 'stubborn', maxAttempts: 1, timeoutMs: 20 },
      { id: 'next', dependencies: [], instruction: 'next', maxAttempts: 1 },
    ],
  });
  const status = await waitTerminal(host, 'quiescence');
  assert.equal(status.state, 'FAILED', 'the stubborn task still fails');
  assert.equal(host.taskResult({ graphId: 'quiescence', taskId: 'stubborn' }).error.code, 'task-timeout');
  assert.equal(host.taskResult({ graphId: 'quiescence', taskId: 'next' }).state, 'SUCCEEDED');

  // The deadline asked the Worker to stop, it refused, and the frame was retired
  // rather than handed to the next task.
  assert.equal(harness.events.includes('stop:stubborn'), true, 'the deadline issues the existing stop request');
  assert.equal(harness.frames.length, 2, 'an ambiguously owned frame is replaced, never reused');
  assert.equal(harness.frames[0].removed, true, 'the ambiguous frame is physically retired');
  assert.equal(harness.frames[1].removed, false);
  assert.ok(
    harness.events.indexOf('stop:stubborn') < harness.events.indexOf('start:next'),
    'the next task starts only after the stop/cleanup transaction ran',
  );
  assert.equal(pool.status().claimedCount, 0);
  assert.equal(pool.status().readyCount, 1, 'the pool stays usable through fail-closed replacement');
  host.close();
  pool.close();
}

/* CARD F: enough of the critical path to answer "where did the time go" on a
   real iPad, and nothing more. No prompt, no response, no DOM, no global log. */
async function testBoundedCriticalPathTrace() {
  const harness = new WorkerHarness({ retried: { failTimes: 2, delay: 2 }, slow: { hang: true } });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({
    graphId: 'trace',
    maxConcurrency: 2,
    tasks: [
      { id: 'retried', dependencies: [], instruction: 'retried', maxAttempts: 3 },
      { id: 'slow', dependencies: [], instruction: 'slow', maxAttempts: 1, timeoutMs: 20 },
    ],
  });
  await waitTerminal(host, 'trace');

  const retried = host.taskResult({ graphId: 'trace', taskId: 'retried' });
  assert.equal(retried.state, 'SUCCEEDED');
  assert.equal(retried.attempts, 3);
  assert.equal(retried.trace.length, 3, 'one trace per attempt');
  assert.deepEqual(retried.trace.map((entry) => entry.attempt), [1, 2, 3], 'retries stay distinguishable');
  assert.deepEqual(retried.trace.map((entry) => entry.outcome), ['failed', 'failed', 'succeeded']);
  assert.equal(new Set(retried.trace.map((entry) => entry.leaseId)).size, 3, 'each attempt records its own lease');

  const success = retried.trace[2];
  assert.equal(success.graphId, 'trace');
  assert.equal(success.taskId, 'retried');
  assert.ok(success.leaseId && success.workerId, 'the successful attempt records its Worker identity');
  assert.equal(typeof success.slot, 'number');
  for (const field of ['readyAt', 'leaseClaimedAt', 'promptSubmitAt', 'completionDetectedAt', 'resultParsedAt', 'leaseReleasedAt']) {
    assert.ok(success[field], `a successful attempt records ${field}`);
  }
  const stamps = ['readyAt', 'leaseClaimedAt', 'promptSubmitAt', 'completionDetectedAt', 'resultParsedAt', 'leaseReleasedAt']
    .map((field) => Date.parse(success[field]));
  for (let index = 1; index < stamps.length; index++) {
    assert.ok(stamps[index] >= stamps[index - 1], 'critical-path timestamps must be monotonic in attempt order');
  }
  assert.equal(success.error, null);

  // Every phase cost is separable without any extra clock or poll.
  const durations = devAttemptTraceDurations(success);
  for (const [name, value] of Object.entries(durations)) {
    assert.equal(typeof value, 'number', `${name} is derivable for a completed attempt`);
    assert.ok(value >= 0, `${name} must not be negative`);
  }

  // A deadline kill really has no completion or parse cost. Reporting 0 there
  // would be an invented measurement.
  const slow = host.taskResult({ graphId: 'trace', taskId: 'slow' });
  assert.equal(slow.state, 'FAILED');
  assert.equal(slow.trace.length, 1);
  const timedOut = slow.trace[0];
  assert.equal(timedOut.outcome, 'failed');
  assert.equal(timedOut.error.code, 'task-timeout', 'a failed attempt carries its terminal reason');
  assert.ok(timedOut.promptSubmitAt, 'the turn was submitted');
  assert.equal(timedOut.completionDetectedAt, null, 'no completion was ever detected');
  assert.equal(timedOut.resultParsedAt, null);
  assert.ok(timedOut.leaseReleasedAt, 'the lease was still cleaned up');
  const timedOutDurations = devAttemptTraceDurations(timedOut);
  assert.equal(typeof timedOutDurations.leaseToSubmitMs, 'number');
  assert.equal(timedOutDurations.submitToCompletionDetectedMs, null, 'a missing endpoint stays null, never 0');
  assert.equal(timedOutDurations.completionToParseMs, null);
  assert.equal(timedOutDurations.parseToReleaseMs, null);

  // The trace is diagnosis-only: routine status must not carry it.
  const status = host.status({ graphId: 'trace' });
  assert.equal(status.tasks.every((item) => item.trace === undefined), true, 'graph status stays free of full traces');

  // No prompt body, no response body, no DOM.
  const serialized = JSON.stringify([retried.trace, slow.trace]);
  assert.equal(serialized.includes('ASSIGNED TASK'), false, 'the prompt body is never persisted');
  assert.equal(serialized.includes('done:retried'), false, 'the response body is never persisted');
  assert.equal(serialized.includes('responseText'), false);
  host.close();
  pool.close();
}

/* A cancelled attempt is recorded as cancelled, and the record stays bounded by
   the attempt limit rather than growing with the run. */
async function testCancelledAttemptTraceAndBounds() {
  const harness = new WorkerHarness({ hanging: { hang: true }, waiting: {} });
  const pool = harness.pool();
  const host = graphHost(pool);
  await host.start({ graphId: 'trace-cancel', maxConcurrency: 1, tasks: [task('hanging'), task('waiting', ['hanging'])] });
  await waitFor(() => host.status({ graphId: 'trace-cancel' }).tasks.some((item) => item.id === 'hanging' && item.state === 'RUNNING' && item.owner));
  host.cancel({ graphId: 'trace-cancel', reason: 'test-trace-cancel' });
  await waitTerminal(host, 'trace-cancel');

  const hanging = host.taskResult({ graphId: 'trace-cancel', taskId: 'hanging' });
  assert.equal(hanging.state, 'CANCELLED');
  assert.equal(hanging.trace.length, 1);
  assert.equal(hanging.trace[0].outcome, 'cancelled', 'a cancelled attempt carries its terminal outcome');
  assert.equal(hanging.trace[0].error.code, 'cancelled');
  assert.ok(hanging.trace[0].leaseReleasedAt, 'cancellation still records the completed cleanup');

  // A task that never started an attempt has nothing to report, not an empty guess.
  const waiting = host.taskResult({ graphId: 'trace-cancel', taskId: 'waiting' });
  assert.equal(waiting.state, 'CANCELLED');
  assert.deepEqual(waiting.trace, [], 'a task that never claimed a Worker records no attempt');
  host.close();
  pool.close();

  // maxAttempts is the bound: five failures produce five records, not more.
  const bounded = new WorkerHarness({ doomed: { failTimes: 9 } });
  const boundedPool = bounded.pool();
  const boundedHost = graphHost(boundedPool);
  await boundedHost.start({ graphId: 'trace-bounds', tasks: [{ id: 'doomed', dependencies: [], instruction: 'doomed', maxAttempts: 99 }] });
  assert.equal(boundedHost.taskResult({ graphId: 'trace-bounds', taskId: 'doomed' }).maxAttempts, 5, 'attempt policy clamps the request');
  await waitTerminal(boundedHost, 'trace-bounds');
  const doomed = boundedHost.taskResult({ graphId: 'trace-bounds', taskId: 'doomed' });
  assert.equal(doomed.state, 'FAILED');
  assert.equal(doomed.attempts, 5);
  assert.equal(doomed.trace.length, 5, 'trace storage is bounded by the clamped attempt limit, not by the request');
  assert.equal(doomed.trace.length, doomed.attempts, 'exactly one record per attempt, never an accumulating log');
  assert.deepEqual(doomed.trace.map((entry) => entry.outcome), ['failed', 'failed', 'failed', 'failed', 'failed']);
  boundedHost.close();
  boundedPool.close();
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
    this.pending = new Map();
  }

  /* Settles one hanging Worker turn, so a test can prove that completions are
     independent rather than batched behind a shared scan. */
  finish(taskId, value) {
    const settle = this.pending.get(taskId);
    assert.ok(settle, `task ${taskId} has no in-flight Worker turn`);
    settle(value);
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
        const owner = currentTask;
        harness.peak = Math.max(harness.peak, harness.active);
        return new Promise((resolve) => {
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            harness.pending.delete(owner);
            if (current?.timer) clearTimeout(current.timer);
            harness.active -= 1;
            last = value;
            harness.events.push(`complete:${currentTask}`);
            current = null;
            resolve(value);
          };
          current = { finish, timer: null };
          harness.pending.set(owner, finish);
          if (behavior.hang) return;
          current.timer = setTimeout(() => {
            if (attempt <= Number(behavior.failTimes || 0)) finish({ status: 'failed', error: { code: 'fixture-failure', message: `failed ${currentTask}` } });
            else finish({ status: 'completed', responseText: `done:${currentTask}`, chatgptConversationId: `c-${slot}-${attempt}` });
          }, Number(behavior.delay || 1));
        });
      },
      async stop(args) {
        verify(args);
        harness.events.push(`stop:${currentTask}`);
        // A Worker that does not answer stop leaves quiescence ambiguous, which
        // is exactly when the frame must be retired instead of reused.
        if (harness.behaviors[currentTask]?.ignoresStop) return { outcome: 'still-working' };
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
        const attempt = harness.attempts.get(currentTask) || 0;
        if (attempt <= Number(behavior.releaseFailsTimes || 0)) {
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
await testOneStartPerLeaseAttemptAndExecutionOnlySuccess();
await testLongTurnIsAwaitedNotPolled();
await testDeadlineIsExplicitOrAbsent();
await testDeadlineReleasesCleanlyWhenTheWorkerStops();
await testDeadlineDoesNotMakeAnActiveWorkerReusable();
await testBoundedCriticalPathTrace();
await testCancelledAttemptTraceAndBounds();
console.log('dynamic task graph: ok');
