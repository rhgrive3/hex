import assert from 'node:assert/strict';
import { IframeWorkerPool } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { startParentDevWorkerRuntime } from '../../js/userscript/dev/parent-worker-runtime.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevRunEventHost } from '../../js/ai/dev/events/dev-events.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

const NOW = '2026-08-20T00:00:00.000Z';
const RUN = 'run-current';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function cryptoSequence() {
  let value = 1;
  return {
    getRandomValues(bytes) {
      bytes.fill(0);
      bytes[bytes.length - 1] = value++ & 0xff;
      return bytes;
    },
  };
}

function fakeClient() {
  const turns = [];
  return {
    turns,
    async claim({ runId, workerId }) { return { runId, workerId, claimed: true }; },
    send({ runId, workerId, instruction }) {
      const turn = { runId, workerId, instruction, deferred: deferred() };
      turns.push(turn);
      return turn.deferred.promise;
    },
    async release() { return { released: true }; },
    result() { return { status: 'available' }; },
    async stop() { return { stopped: true }; },
  };
}

function addReadySlot(pool, index) {
  const client = fakeClient();
  pool.slots.set(index, {
    index,
    href: 'https://chatgpt.com/',
    handle: null,
    runtime: null,
    runtimeDocument: null,
    client,
    ready: true,
    claimed: false,
    reserving: false,
    leaseId: null,
    workerId: null,
    runId: null,
    taskId: null,
    pending: null,
    lastResult: null,
    error: null,
    createdAt: `slot-${index}`,
  });
  return client;
}

function fakeController() {
  return {
    adapter: { document: null, location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' } },
    on() { return () => {}; },
    currentConversation() { return { id: 'supervisor-conversation' }; },
    observe() { return { state: 'available' }; },
    currentUserAnchors() { return []; },
    isActive() { return false; },
  };
}

function noOpTaskGraph() { return { close() {}, start() {}, status() {}, taskResult() {}, cancel() {} }; }
function noOpPageInspector() { return { snapshot() {}, scripts() {}, scriptSource() {} }; }
function noOpSkillRegistry() { return { list() { return []; }, describe() {}, installCandidate() {}, validateCandidate() {}, activate() {}, rollback() {}, run() {} }; }

async function runtimeWithSlots(count = 2) {
  const pool = new IframeWorkerPool({ maxWorkers: count, cryptoRef: cryptoSequence(), now: () => NOW });
  const clients = [];
  for (let index = 1; index <= count; index += 1) clients.push(addReadySlot(pool, index));
  const runtime = await startParentDevWorkerRuntime({
    controller: fakeController(),
    workerPool: pool,
    taskGraphHost: noOpTaskGraph(),
    pageInspector: noOpPageInspector(),
    skillRegistry: noOpSkillRegistry(),
    now: () => NOW,
  });
  assert.equal(runtime.enabled, true);
  return { runtime, pool, clients };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function claimAndStart(runtime, taskId, instruction = taskId, runId = RUN) {
  const claim = await runtime.poolClaim({ taskId, runId, wait: false });
  const started = await runtime.poolStart({ leaseId: claim.leaseId, instruction, runId });
  return { claim, started };
}

async function testSupervisorInjectsCurrentRunId() {
  const captured = [];
  const adminTools = {
    toolNames: ['worker.pool.claim', 'worker.pool.start', 'worker.pool.release'],
    has(tool) { return this.toolNames.includes(tool); },
    async execute(tool, args) { captured.push({ tool, args }); return args; },
  };
  const workerTools = { toolNames: [], has() { return false; } };
  const supervisor = new DevSupervisorV0({
    adminTools,
    workerTools,
    idFactory: (kind) => `${kind}-id`,
    now: () => NOW,
  });
  let run = supervisor.createRun({ goal: 'pool completion regression', runId: RUN });

  let executed = await supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: 'worker.pool.claim',
    arguments: { taskId: 'task-injected' },
    purpose: 'claim worker',
  });
  run = executed.run;
  executed = await supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: 'worker.pool.start',
    arguments: { leaseId: 'lease-injected', instruction: 'work' },
    purpose: 'start worker',
  });
  run = executed.run;
  await supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: 'worker.pool.release',
    arguments: { leaseId: 'lease-injected' },
    purpose: 'release worker',
  });

  assert.deepEqual(captured.map((entry) => entry.args.runId), [RUN, RUN, RUN]);
  await assert.rejects(
    () => supervisor.executeToolDecision(run, {
      type: 'tool',
      tool: 'worker.pool.start',
      arguments: { leaseId: 'lease-injected', instruction: 'work', runId: 'stale-run' },
      purpose: 'attempt stale run',
    }),
    /may not override runtime-owned runId/,
  );
}

async function testWaitBeforeCompletionAndRetainedResult() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    const { claim } = await claimAndStart(runtime, 'task-a');
    const eventPromise = runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'A' });
    const event = await eventPromise;
    assert.equal(event.type, 'worker.completed');
    assert.equal(event.data.runId, RUN);
    assert.equal(event.data.taskId, 'task-a');
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'A');
  } finally { runtime.close(); }
}

async function testCompletionBeforeWait() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    await claimAndStart(runtime, 'task-b');
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'B' });
    await settle();
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.taskId, 'task-b');
  } finally { runtime.close(); }
}

async function testRetainedCompletionSurvivesCoordinatorQueueEviction() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    await claimAndStart(runtime, 'task-evicted');
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'retained' });
    await settle();

    for (let index = 0; index < 129; index += 1) {
      runtime.coordinator.enqueue(Object.freeze({
        type: 'worker.progress',
        data: Object.freeze({ runId: RUN, index }),
        observedAt: NOW,
      }));
    }
    assert.equal(
      runtime.coordinator.events.some((event) => event.type === 'worker.completed' && event.data?.taskId === 'task-evicted'),
      false,
      'bounded coordinator queue must have evicted the original completion event for this regression',
    );

    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.taskId, 'task-evicted');
    assert.equal(event.data.runId, RUN);
  } finally { runtime.close(); }
}

async function testMultipleCompletions() {
  const { runtime, clients } = await runtimeWithSlots(2);
  try {
    await claimAndStart(runtime, 'task-c1');
    await claimAndStart(runtime, 'task-c2');
    const first = runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    const second = runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    clients[1].turns[0].deferred.resolve({ status: 'completed', responseText: 'C2' });
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'C1' });
    const events = await Promise.all([first, second]);
    assert.deepEqual(new Set(events.map((event) => event.data.taskId)), new Set(['task-c1', 'task-c2']));
    assert.equal(new Set(events.map((event) => event.data.completionId)).size, 2);
  } finally { runtime.close(); }
}

async function testRejectedDuplicateStartPreservesActiveCompletion() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    const { claim } = await claimAndStart(runtime, 'task-busy', 'first');
    await assert.rejects(
      () => runtime.poolStart({ leaseId: claim.leaseId, instruction: 'duplicate', runId: RUN }),
      /already has an active task/,
    );
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'first-result' });
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.taskId, 'task-busy');
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'first-result');
  } finally { runtime.close(); }
}

async function testDuplicateObservationAndSameLeaseRestart() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    const { claim } = await claimAndStart(runtime, 'task-d', 'first');
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'D1' });
    await settle();
    const first = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    runtime.coordinator.enqueue(first);
    await runtime.poolStart({ leaseId: claim.leaseId, instruction: 'second', runId: RUN });
    clients[0].turns[1].deferred.resolve({ status: 'completed', responseText: 'D2' });
    await settle();
    runtime.coordinator.enqueue(first);
    const second = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.notEqual(second.data.completionId, first.data.completionId);
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'D2');
  } finally { runtime.close(); }
}

async function testStaleRunCannotUseOwnedLease() {
  const { runtime, clients } = await runtimeWithSlots(1);
  const ownerRun = 'run-owner';
  try {
    const claim = await runtime.poolClaim({ taskId: 'task-owned', runId: ownerRun, wait: false });
    await assert.rejects(
      () => runtime.poolStart({ leaseId: claim.leaseId, instruction: 'wrong-owner', runId: RUN }),
      /owned by Supervisor run run-owner/,
    );
    await runtime.poolStart({ leaseId: claim.leaseId, instruction: 'correct-owner', runId: ownerRun });
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'owned' });
    await settle();
    await assert.rejects(
      () => runtime.poolRelease({ leaseId: claim.leaseId, runId: RUN }),
      /owned by Supervisor run run-owner/,
    );
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: ownerRun }, { runId: ownerRun });
    assert.equal(event.data.runId, ownerRun);
    await runtime.poolRelease({ leaseId: claim.leaseId, runId: ownerRun });
  } finally { runtime.close(); }
}

async function testReleasedLeaseStaleEventDoesNotResume() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    const old = await claimAndStart(runtime, 'task-old');
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'old' });
    await settle();
    await runtime.poolRelease({ leaseId: old.claim.leaseId, runId: RUN });
    await claimAndStart(runtime, 'task-new');
    clients[0].turns[1].deferred.resolve({ status: 'completed', responseText: 'new' });
    await settle();
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.taskId, 'task-new');
  } finally { runtime.close(); }
}

async function testRunTransitionIgnoresPreviousRun() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    const old = await claimAndStart(runtime, 'task-prev', 'prev', 'run-prev');
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'prev' });
    await settle();
    await runtime.poolRelease({ leaseId: old.claim.leaseId, runId: 'run-prev' });
    await claimAndStart(runtime, 'task-current', 'current', RUN);
    clients[0].turns[1].deferred.resolve({ status: 'completed', responseText: 'current' });
    await settle();
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.runId, RUN);
    assert.equal(event.data.taskId, 'task-current');
  } finally { runtime.close(); }
}

async function testDevRunEventHostResumesSameRunExactlyOnce() {
  const { runtime, clients } = await runtimeWithSlots(1);
  try {
    const supervisor = new DevSupervisorV0({
      workerClient: runtime,
      idFactory: (kind) => `${kind}-integration`,
      now: () => NOW,
    });
    let run = supervisor.createRun({ goal: 'resume pool completion', runId: RUN });
    run = supervisor.activate(run);

    let executed = await supervisor.executeToolDecision(run, {
      type: 'tool',
      tool: 'worker.pool.claim',
      arguments: { taskId: 'task-host' },
      purpose: 'claim iframe worker',
    });
    run = executed.run;
    const leaseId = executed.result.leaseId;

    executed = await supervisor.executeToolDecision(run, {
      type: 'tool',
      tool: 'worker.pool.start',
      arguments: { leaseId, instruction: 'host integration' },
      purpose: 'start iframe worker',
    });
    run = executed.run;

    const eventHost = new DevRunEventHost({ supervisor });
    const waiting = eventHost.waitForWorkerDecision(run, {
      type: 'wait',
      events: ['worker.completed'],
      reason: 'wait for iframe worker completion',
    });
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'host-result' });

    const resumed = await waiting;
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.run.runId, RUN);
    assert.equal(resumed.run.status, DEV_RUN_STATUS.ACTIVE);
    assert.equal(resumed.event.data.taskId, 'task-host');
    assert.equal(eventHost.waitingFor(RUN), null);

    const duplicate = eventHost.acceptEvent(resumed.run, resumed.event);
    assert.equal(duplicate.resumed, false, 'the same completion must not resume the DevRun twice');
  } finally { runtime.close(); }
}

await testSupervisorInjectsCurrentRunId();
await testWaitBeforeCompletionAndRetainedResult();
await testCompletionBeforeWait();
await testRetainedCompletionSurvivesCoordinatorQueueEviction();
await testMultipleCompletions();
await testRejectedDuplicateStartPreservesActiveCompletion();
await testDuplicateObservationAndSameLeaseRestart();
await testStaleRunCannotUseOwnedLease();
await testReleasedLeaseStaleEventDoesNotResume();
await testRunTransitionIgnoresPreviousRun();
await testDevRunEventHostResumesSameRunExactlyOnce();
console.log('pool completion event resume regression: ok');
