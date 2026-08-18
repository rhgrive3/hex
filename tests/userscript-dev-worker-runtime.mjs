import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { SingleConversationWorkerCoordinator } from '../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';
import { startParentDevWorkerRuntime } from '../js/userscript/dev/parent-worker-runtime.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../js/userscript/dev/parent-rpc.js';

class FakeController {
  constructor() {
    this.listeners = new Set();
    this.supervisor = { id: 'supervisor-cid', url: 'https://chatgpt.com/c/supervisor-cid' };
    this.worker = { id: 'worker-cid', url: 'https://chatgpt.com/c/worker-cid' };
    this.current = this.supervisor;
    this.navigation = [];
    this.stopped = false;
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(kind, data = {}) { for (const listener of this.listeners) listener({ kind, data, observedAt: new Date().toISOString() }); }
  captureCurrentSupervisorConversation() { return this.supervisor; }
  currentConversation() { return this.current; }
  workerConversation() { return this.worker; }
  async createChat() { this.current = this.worker; return { chatgptConversationId: this.worker.id, conversation: this.worker }; }
  async send(text) { this.current = this.worker; this.emit('completed', { responseText: `done:${text}` }); return { status: 'completed', responseText: `done:${text}`, chatgptConversationId: this.worker.id }; }
  async followup(text) { this.current = this.worker; this.emit('completed', { responseText: `follow:${text}` }); return { status: 'completed', responseText: `follow:${text}`, chatgptConversationId: this.worker.id }; }
  async nudge() { return { outcome: 'still-working' }; }
  observe() { return { state: 'available' }; }
  async stop() { this.stopped = true; this.emit('cancelled', {}); return { outcome: 'stopped' }; }
  result() { return { status: 'completed', responseText: 'done' }; }
  isActive() { return false; }
  async navigateTo(conversation, options = {}) { this.current = conversation; this.navigation.push({ ...conversation, options }); }
}

const controller = new FakeController();
const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'tab-node-1', now: () => '2026-08-17T00:00:00.000Z' });
const discovered = await coordinator.discover();
assert.equal(discovered.length, 1);
assert.equal(discovered[0].role, 'available');
await coordinator.claim({ runId: 'run-1', workerId: 'worker-1' });
await coordinator.createChat({ workerId: 'worker-1' });
const sent = await coordinator.send({ workerId: 'worker-1', instruction: 'task' });
assert.equal(sent.responseText, 'done:task');
assert.equal(controller.navigation.at(-1).id, 'supervisor-cid', 'single-tab completion must restore Supervisor immediately');
assert.equal(controller.currentConversation().id, 'supervisor-cid');
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
assert.equal(runtime.workerPool.maxWorkers, 6);
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
];
for (const path of protectedSources) {
  const source = fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /querySelector\(|getElementById\(|document\.|window\.open\(/, `${path} must not own ChatGPT DOM/tab automation`);
}

console.log('userscript Dev Worker runtime: ok');
