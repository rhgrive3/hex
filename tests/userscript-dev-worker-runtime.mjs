import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { SingleConversationWorkerCoordinator } from '../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';
import { WorkerChatController } from '../js/userscript/dev/worker-host/worker-chat-controller.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../js/userscript/dev/parent-rpc.js';
import { startParentDevWorkerRuntime } from '../js/userscript/dev/parent-worker-runtime.js';
import { DEV_WORKER_NUDGE, DEV_WORKER_STATE } from '../js/ai/dev/workers/contracts.js';

await testRealControllerDefersBlankChatAndWaitsForSupervisorHydration();
await testClaimAdoptsVirtualizedSupervisorSurface();

class FakeController {
  constructor() {
    this.state = DEV_WORKER_STATE.STARTING;
    this.page = { id: 'supervisor-cid', url: 'https://chatgpt.com/c/supervisor-cid' };
    this.worker = null;
    this.text = '';
    this.listeners = new Set();
    this.lastSend = null;
    this.active = false;
    this.navigation = [];
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, data = {}) { for (const fn of this.listeners) fn({ kind, data, observedAt: new Date().toISOString() }); }
  currentConversation() { return this.page ? { ...this.page } : null; }
  currentUserAnchors() { return [{ id: 'supervisor-latest', text: 'latest supervisor request' }]; }
  workerConversation() { return this.worker ? { ...this.worker } : null; }
  isActive() { return this.active; }
  async navigateToConversation(conversation, options = {}) { this.navigation.push({ id: conversation.id, options }); this.page = { ...conversation }; return this.page; }
  async createChat() { this.page = null; this.worker = null; this.text = ''; this.state = DEV_WORKER_STATE.STARTING; return this.observe(); }
  async send(text, context) {
    this.lastSend = text;
    this.active = true;
    this.state = DEV_WORKER_STATE.WORKING;
    this.emit('started', context);
    queueMicrotask(() => {
      this.worker = { id: 'worker-cid', url: 'https://chatgpt.com/c/worker-cid' };
      this.page = { ...this.worker };
      this.text = 'one line';
      this.active = false;
      this.state = DEV_WORKER_STATE.COMPLETED;
      this.emit('completed', { ...context, responseText: this.text });
    });
    return { submitted: true, status: this.state, chatgptConversationId: null };
  }
  async followup(text, context) { return this.send(text, context); }
  async nudge(context) { return this.followup(DEV_WORKER_NUDGE, context); }
  async stop() {
    this.active = false;
    this.state = DEV_WORKER_STATE.CANCELLED;
    this.emit('cancelled', { reason: 'stop-requested' });
    return { outcome: 'cancel-requested', ownershipVerified: true, controlInvoked: true, controllerAborted: true, state: this.state, generatingObservedAfter: false };
  }
  observe() { return { state: this.state, chatgptConversationId: this.worker?.id || null, responseText: this.text, observedAt: new Date().toISOString(), generating: this.active, visibility: 'foreground', observability: 'live' }; }
  result() { return { status: this.state, responseText: this.text, chatgptConversationId: this.worker?.id || null, observedAt: new Date().toISOString() }; }
}

const controller = new FakeController();
const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'same-safari-tab' });
const discovered = await coordinator.discover();
assert.equal(discovered.length, 1);
assert.equal(discovered[0].tabNodeId, 'same-safari-tab');
assert.equal(discovered[0].role, 'available');

const claimed = await coordinator.claim({ runId: 'run-1', workerId: 'worker-1' });
assert.equal(claimed.supervisorChatgptConversationId, 'supervisor-cid');
await assert.rejects(() => coordinator.claim({ runId: 'run-2', workerId: 'worker-2' }), (error) => error.code === 'worker-busy');
await coordinator.createChat({ workerId: 'worker-1' });
assert.equal(controller.currentConversation().id, 'supervisor-cid', 'create_chat must return only after the single Safari tab is back on Supervisor');
assert.deepEqual(controller.navigation.map((item) => item.id), ['supervisor-cid'], 'create_chat recovery must restore Supervisor before the next Supervisor decision');
assert.equal(controller.navigation[0].options.continuityAnchor?.id, 'supervisor-latest');
const result = await coordinator.send({ workerId: 'worker-1', instruction: 'exact instruction' });
assert.equal(controller.lastSend, 'exact instruction');
assert.equal(result.responseText, 'one line');
assert.equal(result.chatgptConversationId, 'worker-cid');
assert.equal(controller.currentConversation().id, 'supervisor-cid', 'single-tab Worker must restore Supervisor before send resolves');
assert.deepEqual(controller.navigation.map((item) => item.id), ['supervisor-cid', 'supervisor-cid']);
const completed = await coordinator.waitEvent({ events: ['worker.completed'], runId: 'run-1' });
assert.equal(completed.type, 'worker.completed', 'terminal event remains available after synchronous single-tab send');

await coordinator.followup({ workerId: 'worker-1', text: 'follow-up' });
assert.equal(controller.navigation.at(-2).id, 'worker-cid', 'follow-up must return to the retained Worker conversation');
assert.equal(controller.navigation.at(-2).options.continuityAnchor, undefined, 'Worker return must retain the strict default hydration policy');
assert.equal(controller.navigation.at(-1).id, 'supervisor-cid', 'follow-up completion must restore Supervisor again');
assert.equal(controller.currentConversation().id, 'supervisor-cid');
const released = await coordinator.release({ workerId: 'worker-1' });
assert.equal(released.role, 'available');
assert.equal(released.claimed, false);

const runtimeController = new FakeController();
const runtime = await startParentDevWorkerRuntime({ controller: runtimeController, now: () => '2026-08-17T00:00:00.000Z' });
assert.equal(runtime.role, 'supervisor');
assert.equal(runtime.mode, 'multi-tab-capable');
assert.equal(runtime.enabled, true);
assert.equal((await runtime.discover()).length, 1);
runtime.close();

const { port1, port2 } = new MessageChannel();
const rpcRuntime = {
  ...Object.fromEntries(['discover', 'claim', 'createChat', 'send', 'observe', 'followup', 'nudge', 'stop', 'result', 'release']
    .map((name) => [name, async (args) => ({ op: name, args })])),
  waitEvent: async (args) => ({ type: args.events[0], data: { runId: args.runId }, observedAt: new Date().toISOString() }),
};
const server = createDevWorkerParentRpc({ port: port1, runtime: rpcRuntime });
const client = createDevWorkerParentRpcClient({ port: port2 });
assert.equal((await client.send({ instruction: 'rpc' })).op, 'send');
assert.equal((await client.waitEvent({ events: ['worker.completed'], runId: 'run-1' })).type, 'worker.completed');
client.close(); server.close();

const protectedSources = [
  'js/ai/dev/supervisor/dev-supervisor-v0.js',
  'js/ai/dev/supervisor/dev-supervisor-engine-v0.js',
  'js/ai/dev/workers/tool-surface.js',
  'js/ai/dev/events/dev-events.js',
].map((path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
assert.doesNotMatch(protectedSources, /querySelector|querySelectorAll|\.click\(|document\./, 'opaque Dev logic must not directly operate ChatGPT DOM');
const parentRuntimeSource = fs.readFileSync(new URL('../js/userscript/dev/parent-worker-runtime.js', import.meta.url), 'utf8');
assert.match(parentRuntimeSource, /MultiTabWorkerPool/, 'post-bootstrap parent runtime must expose the bounded multi-tab pool while retaining the single-tab compatibility lane');
assert.equal(fs.existsSync(new URL('../js/userscript/dev/tab-mesh/transport.js', import.meta.url)), false, 'obsolete cross-tab transport removed');

coordinator.close();
console.log('Round 2 single-tab parent Worker runtime tests passed');

async function testRealControllerDefersBlankChatAndWaitsForSupervisorHydration() {
  const supervisor = { id: 'supervisor-real', url: 'https://chatgpt.com/c/supervisor-real' };
  const worker = { id: 'worker-real', url: 'https://chatgpt.com/c/worker-real' };
  const supervisorUsers = [
    { id: 'supervisor-user-1', text: 'first supervisor request' },
    { id: 'supervisor-user-2', text: 'second supervisor request' },
  ];
  let page = { ...supervisor };
  let users = supervisorUsers.map((turn) => ({ ...turn }));
  let physicalNewChats = 0;
  let hydrated = true;
  const adapter = {
    document: { visibilityState: 'visible', body: null, documentElement: null },
    conversation: () => page ? { ...page } : null,
    userTurns: () => users.map((turn) => ({ ...turn })),
    conversationTurns: () => users.map((turn) => ({ ...turn })),
    assistantTurns: () => [],
    composer: () => ({}),
    isGenerating: () => false,
  };
  const router = {
    bind() {},
    async route(key) {
      if (String(key).startsWith('dev-worker:')) {
        physicalNewChats += 1;
        page = null;
        users = [];
        hydrated = true;
        return { conversation: null, isNew: true };
      }
      page = { ...supervisor };
      users = [];
      hydrated = false;
      setTimeout(() => {
        // Reproduce iPad partial hydration: the latest Supervisor turn returns,
        // while older virtualized history remains absent from the DOM.
        users = [supervisorUsers.at(-1)].map((turn) => ({ ...turn }));
        hydrated = true;
      }, 25);
      return { conversation: { ...supervisor }, isNew: false };
    },
  };
  const turns = {
    async run(prompt, options = {}) {
      setTimeout(() => {
        page = { ...worker };
        users = [{ id: 'worker-user-1', text: prompt }];
        options.onConversation?.({ ...worker });
      }, 10);
      await delay(140);
      return { text: '2', conversation: { ...worker }, turnId: 'worker-assistant-1' };
    },
    stopOwnedGeneration: () => false,
  };
  const real = new WorkerChatController({
    adapter,
    router,
    turns,
    hydrationSettleMs: 10,
    hydrationTimeoutMs: 1000,
  });

  assert.equal(real.currentConversation()?.id, supervisor.id, 'fixture must capture Supervisor history before leaving it');
  const created = await real.createChat({ runId: 'run-real', workerId: 'worker-real-id' });
  assert.equal(created.prepared, true);
  assert.equal(page.id, supervisor.id, 'create_chat must not navigate to an unbound blank ChatGPT surface');
  assert.equal(physicalNewChats, 0, 'physical New Chat is deferred until worker.send');

  const completed = new Promise((resolve) => {
    const off = real.on((event) => {
      if (event.kind !== 'completed') return;
      off();
      resolve(event);
    });
  });
  const submitted = await real.send('const x = 1 + 1; answer in one line', {
    runId: 'run-real',
    workerId: 'worker-real-id',
  });
  assert.equal(submitted.submitted, true);
  assert.equal(physicalNewChats, 1, 'worker.send must own the one physical New Chat transition');
  await completed;
  assert.equal(real.workerConversation()?.id, worker.id);

  const restored = await real.navigateToConversation(supervisor, {
    sessionKey: 'dev-supervisor-return:run-real',
    timeoutMs: 1000,
    continuityAnchor: supervisorUsers.at(-1),
  });
  assert.equal(hydrated, true, 'route equality must not return before the latest Supervisor continuity turn rehydrates');
  assert.equal(restored.id, supervisor.id);
  assert.equal(real.currentConversation()?.id, supervisor.id);
}

async function testClaimAdoptsVirtualizedSupervisorSurface() {
  const supervisor = { id: 'supervisor-virtualized', url: 'https://chatgpt.com/c/supervisor-virtualized' };
  let users = [
    { id: 'old-supervisor-a', text: 'old A' },
    { id: 'old-supervisor-b', text: 'old B' },
  ];
  const adapter = {
    document: { visibilityState: 'visible', body: null, documentElement: null },
    conversation: () => ({ ...supervisor }),
    userTurns: () => users.map((turn) => ({ ...turn })),
    conversationTurns: () => users.map((turn) => ({ ...turn })),
    assistantTurns: () => [],
    composer: () => ({}),
    isGenerating: () => false,
  };
  const controller = new WorkerChatController({ adapter, router: {}, turns: {} });
  assert.equal(controller.currentConversation()?.id, supervisor.id, 'fixture must first remember the fully hydrated Supervisor history');

  users = [{ id: 'latest-supervisor', text: 'latest Dev Supervisor request' }];
  assert.equal(controller.currentConversation(), null, 'strict passive hydration must reject a surface missing remembered historical turns');

  const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'virtualized-same-tab' });
  const claimed = await coordinator.claim({ runId: 'run-virtualized', workerId: 'worker-virtualized' });
  assert.equal(claimed.supervisorChatgptConversationId, supervisor.id, 'claim must adopt the settled current Supervisor surface despite virtualized old turns');
  assert.equal(controller.currentConversation()?.id, supervisor.id, 'adoption must replace stale historical continuity anchors with the live surface');

  const replayed = await coordinator.claim({ runId: 'run-virtualized', workerId: 'worker-virtualized' });
  assert.equal(replayed.replayed, true, 'an ambiguous/replayed identical claim must be idempotent');
  await assert.rejects(
    () => coordinator.claim({ runId: 'other-run', workerId: 'other-worker' }),
    (error) => error.code === 'worker-busy',
    'idempotency must never let another run steal a claimed Worker',
  );
  coordinator.close();
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
