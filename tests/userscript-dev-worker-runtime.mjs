import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { SingleConversationWorkerCoordinator } from '../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../js/userscript/dev/parent-rpc.js';
import { startParentDevWorkerRuntime } from '../js/userscript/dev/parent-worker-runtime.js';
import { DEV_WORKER_NUDGE, DEV_WORKER_STATE } from '../js/ai/dev/workers/contracts.js';

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
  workerConversation() { return this.worker ? { ...this.worker } : null; }
  isActive() { return this.active; }
  async navigateToConversation(conversation) { this.navigation.push(conversation.id); this.page = { ...conversation }; return this.page; }
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
const result = await coordinator.send({ workerId: 'worker-1', instruction: 'exact instruction' });
assert.equal(controller.lastSend, 'exact instruction');
assert.equal(result.responseText, 'one line');
assert.equal(result.chatgptConversationId, 'worker-cid');
assert.equal(controller.currentConversation().id, 'supervisor-cid', 'single-tab Worker must restore Supervisor before send resolves');
assert.deepEqual(controller.navigation, ['supervisor-cid']);
const completed = await coordinator.waitEvent({ events: ['worker.completed'], runId: 'run-1' });
assert.equal(completed.type, 'worker.completed', 'terminal event remains available after synchronous single-tab send');

await coordinator.followup({ workerId: 'worker-1', text: 'follow-up' });
assert.equal(controller.navigation.at(-2), 'worker-cid', 'follow-up must return to the retained Worker conversation');
assert.equal(controller.navigation.at(-1), 'supervisor-cid', 'follow-up completion must restore Supervisor again');
assert.equal(controller.currentConversation().id, 'supervisor-cid');
const released = await coordinator.release({ workerId: 'worker-1' });
assert.equal(released.role, 'available');
assert.equal(released.claimed, false);

const runtimeController = new FakeController();
const runtime = await startParentDevWorkerRuntime({ controller: runtimeController, now: () => '2026-08-17T00:00:00.000Z' });
assert.equal(runtime.role, 'supervisor');
assert.equal(runtime.mode, 'single-tab-conversation-worker');
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
assert.doesNotMatch(parentRuntimeSource, /BroadcastChannel|hex-worker=1|isManualWorkerTab/, 'active Round 2 runtime must not require another Safari tab');
assert.equal(fs.existsSync(new URL('../js/userscript/dev/tab-mesh/transport.js', import.meta.url)), false, 'obsolete cross-tab transport removed');

coordinator.close();
console.log('Round 2 single-tab parent Worker runtime tests passed');
