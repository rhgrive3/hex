import assert from 'node:assert/strict';
import {
  createPoolCompletionEventState,
  waitForDevWorkerEvent,
} from '../../js/userscript/dev/parent-worker-runtime.js';

const NOW = '2026-08-19T01:25:00.000Z';
const fastSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Number(ms) || 0, 1)));

await testCompletedBeforeWait();
await testCompletionWhileWaiting();
await testCompletionBetweenSupervisorRuns();
await testMultipleSimultaneousCompletions();
await testDuplicateCompletionIsNotDeliveredTwice();
await testReleasedLeaseCannotDeliverStaleCompletion();
await testDeliveryDoesNotConsumeRetainedResult();
await testSingleConversationCoordinatorStillWinsRace();

console.log('pool completion event resume: ok');

async function testCompletedBeforeWait() {
  const pool = new FakePool(1);
  const lease = pool.claim(1, 'before-wait');
  const retained = pool.complete(1, 'done-before-wait');
  const event = await waitCompleted(pool, createPoolCompletionEventState());
  assert.equal(event.type, 'worker.completed');
  assert.equal(event.data.leaseId, lease.leaseId);
  assert.equal(event.data.result.responseText, 'done-before-wait');
  assert.strictEqual(await pool.result({ leaseId: lease.leaseId }), retained, 'completion delivery must not consume the retained result');
}

async function testCompletionWhileWaiting() {
  const pool = new FakePool(1);
  const lease = pool.claim(1, 'while-waiting');
  const state = createPoolCompletionEventState();
  const pending = waitCompleted(pool, state);
  setTimeout(() => pool.complete(1, 'done-while-waiting'), 0);
  const event = await pending;
  assert.equal(event.data.leaseId, lease.leaseId);
  assert.equal(event.data.result.responseText, 'done-while-waiting');
}

async function testCompletionBetweenSupervisorRuns() {
  const pool = new FakePool(1);
  const lease = pool.claim(1, 'between-runs');
  const state = createPoolCompletionEventState();
  const firstRun = new AbortController();
  const waiting = waitCompleted(pool, state, firstRun.signal, 'supervisor-run-1');
  firstRun.abort('supervisor-run-switched');
  await assert.rejects(waiting, isCancelled, 'an interrupted Supervisor wait must remain cancellable');

  pool.complete(1, 'done-between-runs');
  const resumed = await waitCompleted(pool, state, null, 'supervisor-run-2');
  assert.equal(resumed.data.leaseId, lease.leaseId);
  assert.equal(resumed.data.result.responseText, 'done-between-runs', 'a retained completion must wake the next Supervisor run');
}

async function testMultipleSimultaneousCompletions() {
  const pool = new FakePool(2);
  const first = pool.claim(1, 'multi-a');
  const second = pool.claim(2, 'multi-b');
  pool.complete(1, 'first');
  pool.complete(2, 'second');
  const state = createPoolCompletionEventState();
  const eventA = await waitCompleted(pool, state);
  const eventB = await waitCompleted(pool, state);
  assert.deepEqual(
    new Set([eventA.data.leaseId, eventB.data.leaseId]),
    new Set([first.leaseId, second.leaseId]),
    'each independently completed Worker must be delivered exactly once',
  );
}

async function testDuplicateCompletionIsNotDeliveredTwice() {
  const pool = new FakePool(1);
  pool.claim(1, 'dedupe');
  pool.complete(1, 'only-once');
  const state = createPoolCompletionEventState();
  await waitCompleted(pool, state);

  const abort = new AbortController();
  setTimeout(() => abort.abort('no-second-delivery'), 5);
  await assert.rejects(
    waitCompleted(pool, state, abort.signal),
    isCancelled,
    'the same retained completion object must not be redelivered on a later wait',
  );
}

async function testReleasedLeaseCannotDeliverStaleCompletion() {
  const pool = new FakePool(1);
  pool.claim(1, 'stale');
  pool.complete(1, 'stale-result');
  pool.releaseButRetainTrap(1);

  const abort = new AbortController();
  setTimeout(() => abort.abort('stale-must-not-deliver'), 5);
  await assert.rejects(
    waitCompleted(pool, createPoolCompletionEventState(), abort.signal),
    isCancelled,
    'a released/stale lease must never wake a Supervisor even if a result object is still physically retained',
  );
}

async function testDeliveryDoesNotConsumeRetainedResult() {
  const pool = new FakePool(1);
  const lease = pool.claim(1, 'retain');
  const retained = pool.complete(1, 'retain-me');
  const state = createPoolCompletionEventState();
  const before = await pool.result({ leaseId: lease.leaseId });
  const event = await waitCompleted(pool, state);
  const after = await pool.result({ leaseId: lease.leaseId });
  assert.strictEqual(before, retained);
  assert.strictEqual(after, retained, 'event delivery is observational and must leave worker.pool.result intact');
  assert.equal(event.data.result.responseText, after.responseText);
}

async function testSingleConversationCoordinatorStillWinsRace() {
  const pool = new FakePool(1);
  const event = Object.freeze({ type: 'worker.completed', data: { runId: 'legacy-run', workerId: 'legacy-worker' }, observedAt: NOW });
  const coordinator = {
    waitEvent: async () => event,
  };
  const actual = await waitForDevWorkerEvent(
    coordinator,
    pool,
    { events: ['worker.completed'], runId: 'legacy-run' },
    {},
    createPoolCompletionEventState(),
    { now: () => NOW, sleep: fastSleep },
  );
  assert.strictEqual(actual, event, 'multiplexing pool completions must not regress the existing single-conversation event lane');
}

function waitCompleted(pool, state, signal = null, runId = 'supervisor-run') {
  return waitForDevWorkerEvent(
    pendingCoordinator(),
    pool,
    { events: ['worker.completed'], runId },
    signal ? { signal } : {},
    state,
    { now: () => NOW, sleep: fastSleep },
  );
}

function pendingCoordinator() {
  return {
    waitEvent(_args, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(cancelled(signal.reason));
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(cancelled(signal?.reason));
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
  };
}

class FakePool {
  constructor(count) {
    this.slots = new Map();
    for (let slot = 1; slot <= count; slot++) {
      this.slots.set(slot, {
        slot,
        claimed: false,
        leaseId: null,
        workerId: null,
        taskId: null,
        working: false,
        result: null,
      });
    }
  }

  claim(slotNumber, taskId) {
    const slot = this.slots.get(slotNumber);
    slot.claimed = true;
    slot.leaseId = `lease-${slotNumber}-${taskId}`;
    slot.workerId = `worker-${slotNumber}-${taskId}`;
    slot.taskId = taskId;
    slot.working = true;
    slot.result = null;
    return { leaseId: slot.leaseId, workerId: slot.workerId, taskId };
  }

  complete(slotNumber, responseText, status = 'completed') {
    const slot = this.slots.get(slotNumber);
    slot.working = false;
    slot.result = Object.freeze({
      status,
      responseText,
      chatgptConversationId: `conversation-${slotNumber}`,
    });
    return slot.result;
  }

  releaseButRetainTrap(slotNumber) {
    const slot = this.slots.get(slotNumber);
    slot.claimed = false;
    slot.working = false;
    slot.leaseId = null;
    slot.workerId = null;
    slot.taskId = null;
  }

  status() {
    return {
      slots: [...this.slots.values()].map((slot) => ({
        slot: slot.slot,
        claimed: slot.claimed,
        leaseId: slot.leaseId,
        workerId: slot.workerId,
        taskId: slot.taskId,
        working: slot.working,
      })),
    };
  }

  async result({ leaseId } = {}) {
    const slot = [...this.slots.values()].find((candidate) => candidate.claimed && candidate.leaseId === leaseId);
    if (!slot) {
      const error = new Error('lease missing');
      error.code = 'lease-missing';
      throw error;
    }
    if (slot.working) return { status: 'working' };
    return slot.result;
  }
}

function isCancelled(error) {
  return error?.name === 'AbortError' || error?.code === 'cancelled';
}
function cancelled(reason) {
  const error = new Error(String(reason || 'cancelled'));
  error.name = 'AbortError';
  error.code = 'cancelled';
  return error;
}
