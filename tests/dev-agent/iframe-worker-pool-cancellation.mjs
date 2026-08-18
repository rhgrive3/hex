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
console.log('iframe worker pool cancellation: ok');
