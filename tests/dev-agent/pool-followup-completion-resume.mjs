import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { IframeWorkerPool } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { startParentDevWorkerRuntime } from '../../js/userscript/dev/parent-worker-runtime.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../../js/userscript/dev/parent-rpc.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevRunEventHost } from '../../js/ai/dev/events/dev-events.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

const NOW = '2026-08-22T08:30:00.000Z';
const RUN = 'run-followup-current';

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
  const begin = (kind, payload) => {
    const turn = { kind, ...payload, deferred: deferred() };
    turns.push(turn);
    return turn.deferred.promise;
  };
  return {
    turns,
    async claim({ runId, workerId }) { return { runId, workerId, claimed: true }; },
    send({ runId, workerId, instruction }) { return begin('send', { runId, workerId, instruction }); },
    followup({ runId, workerId, text }) { return begin('followup', { runId, workerId, text }); },
    async release() { return { released: true }; },
    result() { return { status: 'available' }; },
    async stop() { return { stopped: true }; },
  };
}

function addReadySlot(pool) {
  const client = fakeClient();
  pool.slots.set(1, {
    index: 1,
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
    createdAt: NOW,
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

async function runtimeWithSlot() {
  const pool = new IframeWorkerPool({ maxWorkers: 1, cryptoRef: cryptoSequence(), now: () => NOW });
  const client = addReadySlot(pool);
  const runtime = await startParentDevWorkerRuntime({
    controller: fakeController(),
    workerPool: pool,
    taskGraphHost: noOpTaskGraph(),
    pageInspector: noOpPageInspector(),
    skillRegistry: noOpSkillRegistry(),
    now: () => NOW,
  });
  assert.equal(runtime.enabled, true);
  return { runtime, client };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function claimAndCompleteInitial(runtime, client, { runId = RUN, taskId = 'task-followup' } = {}) {
  const claim = await runtime.poolClaim({ runId, taskId, wait: false });
  await runtime.poolStart({ leaseId: claim.leaseId, runId, instruction: 'initial' });
  client.turns[0].deferred.resolve({ status: 'completed', responseText: 'initial-result' });
  const event = await runtime.waitEvent({ events: ['worker.completed'], runId }, { runId });
  assert.equal(event.data.runId, runId);
  return claim;
}

async function testSupervisorOwnsFollowupRunId() {
  const captured = [];
  const adminTools = {
    toolNames: ['worker.pool.followup'],
    has(tool) { return this.toolNames.includes(tool); },
    async execute(tool, args) { captured.push({ tool, args }); return args; },
  };
  const supervisor = new DevSupervisorV0({
    adminTools,
    workerTools: { toolNames: [], has() { return false; } },
    idFactory: (kind) => `${kind}-id`,
    now: () => NOW,
  });
  const run = supervisor.activate(supervisor.createRun({ goal: 'followup ownership', runId: RUN }));
  await supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: 'worker.pool.followup',
    arguments: { leaseId: 'lease-owned', text: 'continue' },
    purpose: 'continue owned worker',
  });
  assert.equal(captured[0].args.runId, RUN);
  await assert.rejects(
    () => supervisor.executeToolDecision(run, {
      type: 'tool',
      tool: 'worker.pool.followup',
      arguments: { leaseId: 'lease-owned', text: 'continue', runId: 'stale-run' },
      purpose: 'attempt stale followup',
    }),
    /may not override runtime-owned runId/,
  );
}

async function testWaitRegisteredBeforeFollowupCompletion() {
  const { runtime, client } = await runtimeWithSlot();
  try {
    const claim = await claimAndCompleteInitial(runtime, client);
    const followup = runtime.poolFollowup({ leaseId: claim.leaseId, runId: RUN, text: 'continue-a' });
    assert.equal(runtime.poolStatus().slots[0].working, true);
    await assert.rejects(
      () => runtime.poolRelease({ leaseId: claim.leaseId, runId: RUN }),
      /Cannot release a Worker slot while its task is active/,
    );

    const supervisor = new DevSupervisorV0({ workerClient: runtime, now: () => NOW });
    let run = supervisor.activate(supervisor.createRun({ goal: 'resume followup', runId: RUN }));
    const eventHost = new DevRunEventHost({ supervisor });
    const waiting = eventHost.waitForWorkerDecision(run, {
      type: 'wait',
      events: ['worker.completed'],
      reason: 'wait for followup',
    });
    assert.equal(eventHost.waitingFor(RUN)?.kind, 'event');

    client.turns[1].deferred.resolve({ status: 'completed', responseText: 'followup-a' });
    await followup;
    const resumed = await waiting;
    run = resumed.run;
    assert.equal(resumed.resumed, true);
    assert.equal(run.status, DEV_RUN_STATUS.ACTIVE);
    assert.equal(resumed.event.data.runId, RUN);
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'followup-a');
    assert.equal(runtime.poolStatus().slots[0].working, false);
  } finally { runtime.close(); }
}

async function testCompletionImmediatelyBeforeWaitRegistration() {
  const { runtime, client } = await runtimeWithSlot();
  try {
    const claim = await claimAndCompleteInitial(runtime, client);
    const followup = runtime.poolFollowup({ leaseId: claim.leaseId, runId: RUN, text: 'continue-b' });
    client.turns[1].deferred.resolve({ status: 'completed', responseText: 'followup-b' });
    const waiting = runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    await followup;
    const event = await waiting;
    assert.equal(event.data.runId, RUN);
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'followup-b');
  } finally { runtime.close(); }
}

async function testCompletionRetainedBeforeWaitRegistration() {
  const { runtime, client } = await runtimeWithSlot();
  try {
    const claim = await claimAndCompleteInitial(runtime, client);
    const followup = runtime.poolFollowup({ leaseId: claim.leaseId, runId: RUN, text: 'continue-c' });
    client.turns[1].deferred.resolve({ status: 'completed', responseText: 'followup-c' });
    await followup;
    await settle();
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.runId, RUN);
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'followup-c');
  } finally { runtime.close(); }
}

async function testRpcTimeoutDoesNotLoseWorkerCompletion() {
  const { runtime, client } = await runtimeWithSlot();
  const channel = new MessageChannel();
  const server = createDevWorkerParentRpc({ port: channel.port1, runtime });
  const rpc = createDevWorkerParentRpcClient({ port: channel.port2, timeoutMs: 20 });
  try {
    const claim = await claimAndCompleteInitial(runtime, client);
    await assert.rejects(
      () => rpc.poolFollowup({ leaseId: claim.leaseId, runId: RUN, text: 'slow-followup' }),
      /Dev Worker RPC timed out: dev\.worker_pool\.followup/,
    );
    assert.equal(client.turns.length, 2, 'the Worker followup must have started before only the RPC caller timed out');
    assert.equal(runtime.poolStatus().slots[0].working, true, 'the parent must retain ownership of the still-running followup');

    const waiting = runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    client.turns[1].deferred.resolve({ status: 'completed', responseText: 'late-followup' });
    const event = await waiting;
    assert.equal(event.data.runId, RUN);
    assert.equal((await runtime.poolResult({ leaseId: claim.leaseId })).responseText, 'late-followup');
    assert.equal(runtime.poolStatus().slots[0].working, false);
  } finally {
    rpc.close();
    server.close();
    channel.port1.close();
    channel.port2.close();
    runtime.close();
  }
}

async function testOldRunLeaseCleanupDropsFollowupCompletion() {
  const { runtime, client } = await runtimeWithSlot();
  try {
    const oldRun = 'run-followup-old';
    const old = await claimAndCompleteInitial(runtime, client, { runId: oldRun, taskId: 'task-old' });
    const oldFollowup = runtime.poolFollowup({ leaseId: old.leaseId, runId: oldRun, text: 'old-followup' });
    client.turns[1].deferred.resolve({ status: 'completed', responseText: 'old-followup-result' });
    await oldFollowup;
    await settle();
    await runtime.poolRelease({ leaseId: old.leaseId, runId: oldRun });

    const fresh = await runtime.poolClaim({ runId: RUN, taskId: 'task-fresh', wait: false });
    await assert.rejects(
      () => runtime.poolFollowup({ leaseId: fresh.leaseId, runId: oldRun, text: 'stale-owner' }),
      /owned by Supervisor run run-followup-current/,
    );
    await runtime.poolStart({ leaseId: fresh.leaseId, runId: RUN, instruction: 'fresh' });
    client.turns[2].deferred.resolve({ status: 'completed', responseText: 'fresh-result' });
    const event = await runtime.waitEvent({ events: ['worker.completed'], runId: RUN }, { runId: RUN });
    assert.equal(event.data.taskId, 'task-fresh');
    assert.equal(event.data.runId, RUN);
  } finally { runtime.close(); }
}

await testSupervisorOwnsFollowupRunId();
await testWaitRegisteredBeforeFollowupCompletion();
await testCompletionImmediatelyBeforeWaitRegistration();
await testCompletionRetainedBeforeWaitRegistration();
await testRpcTimeoutDoesNotLoseWorkerCompletion();
await testOldRunLeaseCleanupDropsFollowupCompletion();
console.log('pool followup completion resume regression: ok');
