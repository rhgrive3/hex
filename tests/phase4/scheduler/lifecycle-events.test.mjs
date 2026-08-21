import assert from "node:assert/strict";
import {
  AnalysisScheduler,
  createSchedulerEventBuffer,
  ANALYSIS_PRIORITY,
} from "../../../js/core/scheduler/index.js";
import {
  ArtifactStore,
  ArtifactHotCache,
  MemoryArtifactBackend,
  createArtifactDescriptor,
  encodeArtifactPayload,
  createArtifactRecord,
  ArtifactStorageError,
} from "../../../js/core/artifacts/index.js";
import { BudgetExceededError } from "../../../js/core/budgets/index.js";

console.log("Testing AnalysisScheduler lifecycle events...");

function makeStore() {
  return new ArtifactStore({
    backend: new MemoryArtifactBackend(),
    hotCache: new ArtifactHotCache({ maxBytes: 65536, maxEntries: 32 }),
  });
}

function makeDesc(num = 1, upstream = []) {
  return createArtifactDescriptor({
    binaryId: "bin_test_lifecycle",
    passId: "test-pass",
    artifactKind: "semantic-ir-v2",
    producerId: "test-prod",
    loaderVersion: "1.0.0",
    architectureSemanticVersion: "1.0.0",
    abiSemanticVersion: "1.0.0",
    semanticSchemaVersion: "1.0.0",
    config: { num },
    upstreamArtifactIds: upstream,
  });
}

// Case 1 — normal producer lifecycle
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const desc = makeDesc(1);
  await scheduler.request({
    descriptor: desc,
    priority: "foreground",
    produce: async () => ({ val: 123 }),
  });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "request.received",
    "queue.enqueued",
    "job.started",
    "job.completed",
  ]);
  assert.equal(events[0].details.priority, "foreground");
  assert.equal(events[3].details.published, true);
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1);
    assert.equal(events[i].artifactId, desc.artifactId);
    assert.ok(events[i].details.val === undefined);
  }
  console.log("  ok Case 1 normal producer lifecycle");
}

// Case 2 — cache hit
{
  const events = [];
  const store = makeStore();
  const scheduler = new AnalysisScheduler({
    store,
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const desc = makeDesc(2);
  await scheduler.request({
    descriptor: desc,
    produce: async () => ({ val: 456 }),
  });
  events.length = 0;

  await scheduler.request({
    descriptor: desc,
    produce: async () => ({ val: 999 }),
  });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["request.received", "cache.hit"]);
  assert.equal(events[1].details.source, "store");
  console.log("  ok Case 2 cache hit");
}

// Case 3 — coalescing
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const desc = makeDesc(3);
  let unblock;
  const blocker = new Promise((resolve) => { unblock = resolve; });
  let produceCount = 0;

  const reqs = Array.from({ length: 10 }, () => {
    return scheduler.request({
      descriptor: desc,
      produce: async () => {
        produceCount++;
        await blocker;
        return { val: 789 };
      },
    });
  });

  await new Promise((resolve) => setImmediate(resolve));
  unblock();
  await Promise.all(reqs);

  const coalesced = events.filter((e) => e.type === "request.coalesced");
  assert.equal(coalesced.length, 9);
  assert.equal(produceCount, 1);
  assert.equal(events.filter((e) => e.type === "job.started").length, 1);
  assert.equal(events.filter((e) => e.type === "job.completed").length, 1);
  console.log("  ok Case 3 coalescing");
}

// Case 4 — queued cancellation
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  let unblockBlocker;
  const blockerDesc = makeDesc(40);
  const blockerPromise = scheduler.request({
    descriptor: blockerDesc,
    produce: async () => {
      await new Promise((r) => { unblockBlocker = r; });
      return { val: "blocker" };
    },
  });

  const ac = new AbortController();
  const queuedDesc = makeDesc(41);
  const queuedPromise = scheduler.request({
    descriptor: queuedDesc,
    signal: ac.signal,
    produce: async () => ({ val: "queued" }),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  ac.abort();
  await assert.rejects(async () => queuedPromise, (err) => err.name === "AbortError");
  unblockBlocker();
  await blockerPromise;

  const queuedEvents = events.filter((e) => e.artifactId === queuedDesc.artifactId);
  const cancelEvt = queuedEvents.find((e) => e.type === "job.cancelled");
  assert.ok(cancelEvt);
  assert.equal(cancelEvt.details.phase, "queued");
  assert.equal(queuedEvents.some((e) => e.type === "job.started"), false);
  console.log("  ok Case 4 queued cancellation");
}

// Case 5 — running cancellation
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const ac = new AbortController();
  const desc = makeDesc(5);
  const p = scheduler.request({
    descriptor: desc,
    signal: ac.signal,
    produce: async ({ signal }) => {
      ac.abort();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { val: 5 };
    },
  });

  await assert.rejects(async () => p, (err) => err.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelEvt = events.find((e) => e.type === "job.cancelled");
  assert.ok(cancelEvt);
  assert.equal(cancelEvt.details.phase, "running");
  console.log("  ok Case 5 running cancellation");
}

// Case 6 — budget exhaustion
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const desc = makeDesc(6);
  const p = scheduler.request({
    descriptor: desc,
    produce: async ({ budget }) => {
      budget.consume("steps", 100);
      throw new BudgetExceededError("steps", 10, 100);
    },
  });

  await assert.rejects(async () => p, BudgetExceededError);
  const budgetEvt = events.find((e) => e.type === "budget.exhausted");
  assert.ok(budgetEvt);
  assert.equal(budgetEvt.details.resource, "steps");
  assert.equal(events.some((e) => e.type === "job.failed"), false);
  console.log("  ok Case 6 budget exhaustion");
}

// Case 7 — dependency failure
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 2,
    onEvent: (e) => events.push(e),
  });
  const childDesc = makeDesc(70);
  const parentDesc = makeDesc(71, [childDesc.artifactId]);
  const p = scheduler.request({
    descriptor: parentDesc,
    dependencies: [
      {
        descriptor: childDesc,
        produce: async () => { throw new Error("child-failed"); },
      },
    ],
    produce: async () => ({ val: 71 }),
  });

  await assert.rejects(async () => p, (err) => err.name === "SchedulerDependencyError");
  const depFail = events.find((e) => e.artifactId === parentDesc.artifactId && e.type === "dependency.failed");
  assert.ok(depFail);
  assert.equal(depFail.details.dependencyArtifactId, parentDesc.artifactId);
  console.log("  ok Case 7 dependency failure");
}

// Case 8 — storage failure
{
  const events = [];
  const failingStore = {
    async get() { return { status: "miss" }; },
    async publish() { throw new ArtifactStorageError("artifact-storage-write-failed"); },
  };
  const scheduler = new AnalysisScheduler({
    store: failingStore,
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const desc = makeDesc(8);
  await assert.rejects(async () => {
    await scheduler.request({
      descriptor: desc,
      produce: async () => ({ val: 8 }),
    });
  }, (err) => err.name === "ArtifactStorageError");

  const stFail = events.find((e) => e.type === "storage.failed");
  assert.ok(stFail);
  assert.equal(events.some((e) => e.type === "job.completed"), false);
  console.log("  ok Case 8 storage failure");
}

// Case 9 — producer failure
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const desc = makeDesc(9);
  await assert.rejects(async () => {
    await scheduler.request({
      descriptor: desc,
      produce: async () => { throw new Error("my-custom-error"); },
    });
  }, (err) => err.message === "my-custom-error");

  const failEvt = events.find((e) => e.type === "job.failed");
  assert.ok(failEvt);
  assert.equal(failEvt.details.name, "Error");
  console.log("  ok Case 9 producer failure");
}

// Case 10 — observer throws
{
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent: () => { throw new Error("bad-observer"); },
  });
  const desc = makeDesc(10);
  const res = await scheduler.request({
    descriptor: desc,
    produce: async () => ({ val: 10 }),
  });
  assert.equal(res.state, "completed");
  assert.ok(scheduler.stats().observerFailures > 0);
  console.log("  ok Case 10 observer throws");
}

// Case 11 — buffer bound
{
  const buf = createSchedulerEventBuffer({ capacity: 64 });
  for (let i = 1; i <= 10000; i++) {
    buf.onEvent({ seq: i, type: "test", artifactId: "art", details: {} });
  }
  assert.equal(buf.size, 64);
  assert.equal(buf.dropped, 9936);
  const snap = buf.snapshot();
  assert.equal(snap.length, 64);
  assert.equal(snap[0].seq, 9937);
  assert.equal(snap[63].seq, 10000);
  console.log("  ok Case 11 buffer bound");
}

// Case 12 — event immutability
{
  const buf = createSchedulerEventBuffer({ capacity: 10 });
  buf.onEvent({ seq: 1, type: "test", artifactId: "art", details: { foo: "bar" } });
  const snap = buf.snapshot();
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap[0]));
  assert.ok(Object.isFrozen(snap[0].details));
  assert.throws(() => { snap[0].seq = 99; });
  assert.throws(() => { snap[0].details.foo = "baz"; });
  console.log("  ok Case 12 event immutability");
}

console.log("All AnalysisScheduler lifecycle event tests PASS!");
