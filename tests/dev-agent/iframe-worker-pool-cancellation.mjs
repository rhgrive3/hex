import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IframeWorkerPool } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';

async function preAbortedFreeSlotNeverClaims() {
  const harness = await createHarness();
  const controller = new AbortController();
  controller.abort('cancel-before-claim');
  await assert.rejects(
    harness.pool.claim({ taskId: 'pre-aborted', signal: controller.signal }),
    isCancelled,
  );
  assert.equal(harness.coordinator.claimCount, 0, 'a pre-aborted caller must never claim a free Worker frame');
  assert.equal(harness.pool.status().claimedCount, 0);
  harness.close();
}

async function queuedCancellationRollsBackEstablishedClaim() {
  const harness = await createHarness({ holdSecondClaim: true });
  const first = await harness.pool.claim({ taskId: 'first' });
  const controller = new AbortController();
  const started = harness.coordinator.waitForClaim(2);
  const second = harness.pool.claim({ taskId: 'cancel-during-handoff', signal: controller.signal });

  await harness.pool.release({ leaseId: first.leaseId });
  await started;
  assert.ok(harness.coordinator.claimed, 'Worker frame ownership must be established before cancellation');
  controller.abort('cancel-during-claim');
  harness.coordinator.resolveHeldClaim();
  await assert.rejects(second, isCancelled);
  assert.equal(harness.coordinator.claimed, null, 'cancelled ownership must be released in the Worker frame');
  assert.equal(harness.pool.status().claimedCount, 0, 'cancelled claim must not fabricate a local lease');
  assert.equal(harness.pool.status().slots[0].error, null, 'successful rollback keeps the frame reusable');

  const replacement = await harness.pool.claim({ taskId: 'replacement', wait: false });
  assert.equal(replacement.slot, 1, 'a cleanly rolled-back frame must remain reusable');
  await harness.pool.release({ leaseId: replacement.leaseId });
  harness.close();
}

async function failedRollbackQuarantinesFrame() {
  const harness = await createHarness({ holdSecondClaim: true, failSecondRelease: true });
  const first = await harness.pool.claim({ taskId: 'first' });
  const controller = new AbortController();
  const started = harness.coordinator.waitForClaim(2);
  const second = harness.pool.claim({ taskId: 'cancel-cleanup-failure', signal: controller.signal });

  await harness.pool.release({ leaseId: first.leaseId });
  await started;
  controller.abort('cancel-with-cleanup-failure');
  harness.coordinator.resolveHeldClaim();
  await assert.rejects(second, isCancelled);

  const status = harness.pool.status();
  assert.equal(status.claimedCount, 0, 'failed rollback must not create a local lease');
  assert.equal(status.slots[0].error?.code, 'worker-claim-cancel-cleanup-failed');
  await assert.rejects(
    harness.pool.claim({ taskId: 'must-not-reuse', wait: false }),
    (error) => error?.code === 'worker-pool-full',
    'ambiguous frame ownership must quarantine the slot from reuse',
  );
  harness.close();
}

/* Aborting a wait cancels the wait and nothing else. The Worker keeps
   generating and the lease keeps owning it, because stop/release/discard is the
   caller's ownership transaction, not a side effect hidden inside the wait. */
async function abortedWaitCancelsOnlyTheWait() {
  const harness = await createTurnHarness();
  const lease = await harness.pool.claim({ taskId: 'abort-wait' });
  await harness.pool.createChat({ leaseId: lease.leaseId });
  await harness.pool.start({ leaseId: lease.leaseId, instruction: 'long turn' });

  const controller = new AbortController();
  const waiting = harness.pool.waitResult({ leaseId: lease.leaseId }, { signal: controller.signal });
  controller.abort('supervisor-cancelled');
  await assert.rejects(waiting, isCancelled);

  const status = harness.pool.status();
  assert.equal(status.claimedCount, 1, 'an aborted wait must not release the lease');
  assert.equal(status.slots[0].leaseId, lease.leaseId, 'ownership is unchanged');
  assert.equal(status.slots[0].working, true, 'the Worker is still generating');
  assert.equal(harness.turns.stopCount, 0, 'an aborted wait must not stop the Worker');
  assert.equal(harness.turns.releaseCount, 0, 'an aborted wait must not release the Worker');

  // The same lease can still be awaited, and the turn settles normally.
  const resumed = harness.pool.waitResult({ leaseId: lease.leaseId });
  harness.turns.complete({ status: 'completed', responseText: 'long done' });
  assert.equal((await resumed).responseText, 'long done', 'the abandoned wait did not consume the turn');

  await assert.rejects(
    harness.pool.waitResult({ leaseId: lease.leaseId }, { signal: controller.signal }),
    isCancelled,
    'an already-aborted signal rejects before touching ownership',
  );
  assert.equal(harness.pool.status().claimedCount, 1);

  await harness.pool.release({ leaseId: lease.leaseId });
  harness.close();
}

/* A wait captured under one lease must never become authority for the next
   owner of the same slot, however the ownership changed. */
async function staleWaitCannotSpeakForTheNextOwner() {
  const harness = await createTurnHarness();
  const first = await harness.pool.claim({ taskId: 'stale-first' });
  await harness.pool.createChat({ leaseId: first.leaseId });
  await harness.pool.start({ leaseId: first.leaseId, instruction: 'first turn' });
  const stale = harness.pool.waitResult({ leaseId: first.leaseId });

  // Release requires a settled turn, so settle it, then hand the slot on.
  harness.turns.complete({ status: 'completed', responseText: 'first done' });
  assert.equal((await stale).responseText, 'first done');
  await harness.pool.release({ leaseId: first.leaseId });

  const second = await harness.pool.claim({ taskId: 'stale-second' });
  assert.equal(second.slot, first.slot, 'the same frame is reused');
  assert.notEqual(second.leaseId, first.leaseId);
  await assert.rejects(
    harness.pool.waitResult({ leaseId: first.leaseId }),
    (error) => error?.code === 'lease-missing',
    'the old lease cannot wait on the new owner',
  );

  // A wait that was already in flight when ownership moved fails closed instead
  // of returning the next owner's result.
  await harness.pool.createChat({ leaseId: second.leaseId });
  await harness.pool.start({ leaseId: second.leaseId, instruction: 'second turn' });
  const inFlight = harness.pool.waitResult({ leaseId: second.leaseId });
  harness.pool.forceReclaim(second.slot);
  harness.turns.complete({ status: 'completed', responseText: 'second done' });
  await assert.rejects(
    inFlight,
    (error) => error?.code === 'worker-lease-superseded',
    'a settlement that arrives after reclaim must not satisfy the old wait',
  );
  harness.close();

  // The same guard must hold when the lease id itself is reused but the
  // run/worker identity behind it has moved on.
  const drifted = await createTurnHarness();
  const owner = await drifted.pool.claim({ taskId: 'identity-drift' });
  await drifted.pool.createChat({ leaseId: owner.leaseId });
  await drifted.pool.start({ leaseId: owner.leaseId, instruction: 'drifting turn' });
  const driftWait = drifted.pool.waitResult({ leaseId: owner.leaseId });
  drifted.pool.forceIdentityDrift(owner.slot);
  drifted.turns.complete({ status: 'completed', responseText: 'drifted done' });
  await assert.rejects(
    driftWait,
    (error) => error?.code === 'worker-lease-superseded',
    'a lease whose run/worker identity moved must not collect the result',
  );
  drifted.close();
}

/* Closing the pool retires the whole ownership domain. A turn that settles
   afterwards belongs to nothing. */
async function closedPoolCannotSatisfyAnOldWait() {
  const harness = await createTurnHarness();
  const lease = await harness.pool.claim({ taskId: 'closed-domain' });
  await harness.pool.createChat({ leaseId: lease.leaseId });
  await harness.pool.start({ leaseId: lease.leaseId, instruction: 'orphaned turn' });
  const waiting = harness.pool.waitResult({ leaseId: lease.leaseId });

  harness.pool.close();
  await assert.rejects(
    waiting,
    (error) => error?.code === 'worker-lease-superseded',
    'closing the pool retires the wait instead of stranding it on a turn that can no longer settle',
  );

  // The abandoned turn can still settle late. It must reach nothing.
  harness.turns.complete({ status: 'completed', responseText: 'orphaned done' });
  await tick();
  await assert.rejects(
    harness.pool.result({ leaseId: lease.leaseId }),
    (error) => error?.code === 'lease-missing',
    'a settlement after pool close must not become authority for anything',
  );

  // Reinitialising the pool mints a new domain; the old lease stays dead.
  const reprovisioned = await harness.pool.provision({ size: 1, timeoutMs: 2000 });
  assert.equal(reprovisioned.readyCount, 1);
  await assert.rejects(
    harness.pool.waitResult({ leaseId: lease.leaseId }),
    (error) => error?.code === 'lease-missing',
    'the old lease has no place in the reinitialised pool',
  );
  const fresh = await harness.pool.claim({ taskId: 'new-domain' });
  assert.notEqual(fresh.leaseId, lease.leaseId);
  assert.equal(fresh.workerId !== lease.workerId, true);
  harness.close();
}

/* Discarding a lease physically retires its frame, so its in-flight turn can
   never settle. The wait must be told, not stranded. */
async function discardedLeaseWakesItsWait() {
  const harness = await createTurnHarness();
  const lease = await harness.pool.claim({ taskId: 'discarded' });
  await harness.pool.createChat({ leaseId: lease.leaseId });
  await harness.pool.start({ leaseId: lease.leaseId, instruction: 'abandoned turn' });
  const waiting = harness.pool.waitResult({ leaseId: lease.leaseId });

  const replacement = await harness.pool.discard({ leaseId: lease.leaseId, reason: 'test-discard' });
  await assert.rejects(
    waiting,
    (error) => error?.code === 'worker-lease-superseded',
    'discard must wake the wait rather than leave it on a turn that can no longer settle',
  );
  assert.equal(replacement.ready, true, 'discard still reprovisions the slot');
  assert.equal(harness.pool.status().claimedCount, 0, 'discard still clears ownership');
  harness.close();
}

/* One Worker frame whose turn settles only when the test says so. */
async function createTurnHarness() {
  const turns = turnCoordinator();
  const pool = new IframeWorkerPool({
    maxWorkers: 1,
    createFrame: ({ slot }) => {
      const frame = { slot, src: null, contentDocument: null };
      return {
        frame,
        async navigate(href) { frame.src = href; frame.contentDocument = { readyState: 'complete' }; },
        close() { frame.contentDocument = null; },
      };
    },
    createWorkerRuntime: () => ({ coordinator: turns.coordinator, ready: () => true, close() { turns.coordinator.close(); } }),
    documentRef: {},
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    sleep: async () => tick(),
  });
  // Simulates a concurrent reclaim of a slot this test still holds a wait on.
  // Fail-closed guard check: the lease id survives but the run/worker identity
  // behind it does not. Unreachable through the public API today, which is
  // exactly why the guard needs its own regression.
  pool.forceIdentityDrift = (index) => {
    const slot = [...pool.slots.values()].find((item) => item.index === index);
    assert.ok(slot, `slot ${index} must exist`);
    slot.runId = `poolrun-drifted-${index}`;
    slot.workerId = `worker-drifted-${index}`;
  };
  pool.forceReclaim = (index) => {
    const slot = [...pool.slots.values()].find((item) => item.index === index);
    assert.ok(slot, `slot ${index} must exist`);
    pool.leases.delete(slot.leaseId);
    slot.leaseId = `lease-reclaimed-${index}`;
    slot.runId = `poolrun-reclaimed-${index}`;
    slot.workerId = `worker-reclaimed-${index}`;
    pool.leases.set(slot.leaseId, index);
  };
  const provisioned = await pool.provision({ size: 1, timeoutMs: 2000 });
  assert.equal(provisioned.readyCount, 1);
  return { pool, turns, close() { pool.close(); } };
}

function turnCoordinator() {
  let claim = null;
  let pending = null;
  const state = { stopCount: 0, releaseCount: 0, resultCalls: 0 };
  const verify = (args) => { assert.equal(String(args.runId), claim?.runId); assert.equal(String(args.workerId), claim?.workerId); };
  state.coordinator = {
    async claim(args) { claim = { runId: String(args.runId), workerId: String(args.workerId) }; return { ...claim, claimed: true, dedicatedFrame: true }; },
    async createChat(args) { verify(args); return { prepared: true }; },
    async send(args) { verify(args); return new Promise((resolve, reject) => { pending = { resolve, reject }; }); },
    async stop(args) { verify(args); state.stopCount += 1; return { outcome: pending ? 'stopped' : 'not-running' }; },
    async observe(args) { verify(args); return { status: pending ? 'working' : 'available' }; },
    async result(args) { verify(args); state.resultCalls += 1; return { status: pending ? 'working' : 'available' }; },
    async release(args) { verify(args); state.releaseCount += 1; claim = null; return { claimed: false }; },
    // The real coordinator does not settle an in-flight turn when it closes,
    // so the abandoned turn stays capable of a late settlement.
    close() { claim = null; },
  };
  state.complete = (value) => { const turn = pending; pending = null; turn.resolve(value); };
  state.fail = (error) => { const turn = pending; pending = null; turn.reject(error); };
  return state;
}

async function createHarness(options = {}) {
  const coordinator = controlledCoordinator(options);
  const frames = [];
  const pool = new IframeWorkerPool({
    maxWorkers: 1,
    createFrame: ({ slot }) => {
      const frame = { slot, src: null, contentDocument: null };
      frames.push(frame);
      return {
        frame,
        async navigate(href) { frame.src = href; frame.contentDocument = { readyState: 'complete' }; },
        close() { frame.contentDocument = null; },
      };
    },
    createWorkerRuntime: () => ({ coordinator, ready: () => true, close() {} }),
    documentRef: {},
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    sleep: async () => tick(),
  });
  const provisioned = await pool.provision({ size: 1, timeoutMs: 2000 });
  assert.equal(provisioned.readyCount, 1);
  return { pool, coordinator, frames, close() { pool.close(); } };
}

function controlledCoordinator({ holdSecondClaim = false, failSecondRelease = false } = {}) {
  let claimed = null;
  let claimCount = 0;
  let releaseCount = 0;
  let heldResolve = null;
  let heldPromise = null;
  const waiters = new Map();
  if (holdSecondClaim) heldPromise = new Promise((resolve) => { heldResolve = resolve; });
  return {
    get claimed() { return claimed; },
    get claimCount() { return claimCount; },
    async claim(args) {
      claimCount += 1;
      claimed = { runId: String(args.runId), workerId: String(args.workerId) };
      waiters.get(claimCount)?.();
      waiters.delete(claimCount);
      if (claimCount === 2 && heldPromise) await heldPromise;
      return { ...claimed, claimed: true, dedicatedFrame: true };
    },
    async release(args) {
      releaseCount += 1;
      assert.ok(claimed, 'release requires an active claim');
      assert.equal(String(args.runId), claimed.runId);
      assert.equal(String(args.workerId), claimed.workerId);
      if (failSecondRelease && releaseCount >= 2) {
        const error = new Error('simulated rollback failure');
        error.code = 'transport-failure';
        throw error;
      }
      claimed = null;
      return { claimed: false, dedicatedFrame: true };
    },
    waitForClaim(number) {
      if (claimCount >= number) return Promise.resolve();
      return new Promise((resolve) => waiters.set(number, resolve));
    },
    resolveHeldClaim() { heldResolve?.(); heldResolve = null; },
    close() {},
  };
}

function isCancelled(error) { return error?.name === 'AbortError' && error?.code === 'cancelled'; }
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

await preAbortedFreeSlotNeverClaims();
await queuedCancellationRollsBackEstablishedClaim();
await failedRollbackQuarantinesFrame();
await abortedWaitCancelsOnlyTheWait();
await staleWaitCannotSpeakForTheNextOwner();
await closedPoolCannotSatisfyAnOldWait();
await discardedLeaseWakesItsWait();
console.log('iframe worker pool cancellation: ok');
