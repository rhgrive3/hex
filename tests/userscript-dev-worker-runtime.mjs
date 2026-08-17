import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { SingleWorkerCoordinator } from '../js/userscript/dev/tab-mesh/single-worker-coordinator.js';
import { createTabNode, isManualWorkerTab, TAB_NODE_ROLE } from '../js/userscript/dev/tab-mesh/tab-node.js';
import { WorkerTabHost } from '../js/userscript/dev/worker-host/worker-host.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../js/userscript/dev/parent-rpc.js';
import { DEV_WORKER_NUDGE, DEV_WORKER_STATE } from '../js/ai/dev/workers/contracts.js';

class MemoryBus {
  constructor() { this.endpoints = new Map(); }
  endpoint(id) {
    const bus = this;
    let handler = null;
    const listeners = new Set();
    const endpoint = {
      nodeId: id,
      request: async (to, method, params) => {
        const target = bus.endpoints.get(to)
          || [...bus.endpoints.values()].find((item) => to === '*' && item !== endpoint);
        if (!target?.handler) throw Object.assign(new Error('no target'), { code: 'transport-failure' });
        return target.handler(method, structuredClone(params), { from: id, requestId: 'memory' });
      },
      emit: async (type, data, { to = '*' } = {}) => {
        for (const target of bus.endpoints.values()) {
          if (target === endpoint) continue;
          if (to !== '*' && target.nodeId !== to) continue;
          for (const listener of target.listeners) {
            listener({ type, data: structuredClone(data), from: id, observedAt: new Date().toISOString() });
          }
        }
      },
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      setRequestHandler: (fn) => { handler = fn; endpoint.handler = fn; },
      close() { bus.endpoints.delete(id); },
      listeners,
      handler,
    };
    this.endpoints.set(id, endpoint);
    return endpoint;
  }
}

class FakeController {
  constructor() {
    this.state = DEV_WORKER_STATE.STARTING;
    this.conversation = null;
    this.text = '';
    this.listeners = new Set();
    this.lastSend = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, data = {}) {
    for (const fn of this.listeners) fn({ kind, data, observedAt: new Date().toISOString() });
  }
  async createChat() {
    this.state = DEV_WORKER_STATE.STARTING;
    this.conversation = null;
    this.text = '';
    return this.observe();
  }
  async send(text, context) {
    this.lastSend = text;
    this.state = DEV_WORKER_STATE.WORKING;
    this.emit('started', context);
    queueMicrotask(() => {
      this.conversation = { id: 'cid-1' };
      this.state = DEV_WORKER_STATE.COMPLETED;
      this.text = 'one line';
      this.emit('completed', context);
    });
    return { submitted: true, status: this.state, chatgptConversationId: null };
  }
  async followup(text, context) { this.lastSend = text; return this.send(text, context); }
  async nudge(context) { return this.followup(DEV_WORKER_NUDGE, context); }
  async stop() {
    this.state = DEV_WORKER_STATE.CANCELLED;
    this.emit('cancelled', { reason: 'stop-requested' });
    return {
      outcome: 'cancel-requested',
      ownershipVerified: true,
      controlInvoked: true,
      controllerAborted: true,
      state: this.state,
      generatingObservedAfter: false,
    };
  }
  observe() {
    return {
      state: this.state,
      chatgptConversationId: this.conversation?.id || null,
      responseText: this.text,
      observedAt: new Date().toISOString(),
      generating: this.state === DEV_WORKER_STATE.WORKING,
      visibility: 'foreground',
      observability: 'live',
    };
  }
  result() {
    return {
      status: this.state,
      responseText: this.text,
      chatgptConversationId: this.conversation?.id || null,
      observedAt: new Date().toISOString(),
    };
  }
}

const markerWindow = { name: '' };
assert.equal(isManualWorkerTab({
  location: { href: 'https://chatgpt.com/?hex-worker=1' },
  window: markerWindow,
}), true);
assert.equal(markerWindow.name, 'hex-dev-worker-v1');

const bus = new MemoryBus();
const supervisorTransport = bus.endpoint('supervisor-tab');
const workerTransport = bus.endpoint('worker-tab');
const controller = new FakeController();
const node = createTabNode({ role: TAB_NODE_ROLE.AVAILABLE, idFactory: () => 'worker-tab' });
const host = new WorkerTabHost({ transport: workerTransport, tabNode: node, controller });
const coordinator = new SingleWorkerCoordinator({ transport: supervisorTransport });
await host.register();

// Round 2 intentionally keeps one reusable slot. A second registration must
// not turn the coordinator into a pool or scheduler.
const extraTransport = bus.endpoint('worker-tab-extra');
const extraHost = new WorkerTabHost({
  transport: extraTransport,
  tabNode: createTabNode({ role: TAB_NODE_ROLE.AVAILABLE, idFactory: () => 'worker-tab-extra' }),
  controller: new FakeController(),
});
await extraHost.register();

const discovered = await coordinator.discover();
assert.equal(discovered.length, 1, 'dev-worker-tab-register');
assert.equal(discovered[0].tabNodeId, 'worker-tab', 'dev-worker-single-slot-only');
assert.equal(discovered[0].role, 'available');

const claimed = await coordinator.claim({ runId: 'run-1', workerId: 'worker-1' });
assert.equal(claimed.workerId, 'worker-1', 'dev-worker-tab-claim-release');
await assert.rejects(
  () => coordinator.claim({ runId: 'run-2', workerId: 'worker-2' }),
  (error) => error.code === 'worker-busy',
  'dev-worker-single-slot-only',
);

const created = await coordinator.createChat({ workerId: 'worker-1' });
assert.equal(created.tabNodeId, 'worker-tab', 'dev-worker-create-chat');
await coordinator.send({ workerId: 'worker-1', instruction: 'exact instruction' });
assert.equal(controller.lastSend, 'exact instruction', 'dev-worker-send');
const completed = await coordinator.waitEvent({ events: ['worker.completed'], runId: 'run-1' });
assert.equal(completed.type, 'worker.completed');
const observed = await coordinator.observe({ workerId: 'worker-1' });
assert.equal(observed.status ?? observed.state, 'COMPLETED', 'dev-worker-observe');
const result = await coordinator.result({ workerId: 'worker-1' });
assert.equal(result.responseText, 'one line', 'dev-worker-result');
assert.equal(result.chatgptConversationId, 'cid-1');

await coordinator.followup({ workerId: 'worker-1', text: 'same chat follow-up' });
assert.equal(controller.lastSend, 'same chat follow-up', 'dev-worker-followup');
await new Promise((resolve) => setTimeout(resolve, 0));
await coordinator.nudge({ workerId: 'worker-1' });
assert.equal(controller.lastSend, DEV_WORKER_NUDGE, 'dev-worker-nudge');
await new Promise((resolve) => setTimeout(resolve, 0));
const stopped = await coordinator.stop({ workerId: 'worker-1' });
assert.equal(stopped.controlInvoked, true, 'dev-worker-stop');
const released = await coordinator.release({ workerId: 'worker-1' });
assert.equal(released.role, 'available');
assert.equal(released.claimed, false);

const reused = await coordinator.claim({ runId: 'run-2', workerId: 'worker-2' });
assert.equal(reused.tabNodeId, 'worker-tab', 'released Worker slot is reusable');
assert.equal(reused.workerId, 'worker-2');
await coordinator.release({ workerId: 'worker-2' });

const { port1, port2 } = new MessageChannel();
const rpcRuntime = {
  ...Object.fromEntries(['discover', 'claim', 'createChat', 'send', 'observe', 'followup', 'nudge', 'stop', 'result', 'release']
    .map((name) => [name, async (args) => ({ op: name, args })])),
  waitEvent: async (args, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ type: args.events[0], data: { runId: args.runId } }), 10);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    }, { once: true });
  }),
};
const server = createDevWorkerParentRpc({ port: port1, runtime: rpcRuntime });
const client = createDevWorkerParentRpcClient({ port: port2 });
const rpcResult = await client.send({ instruction: 'rpc' });
assert.equal(rpcResult.op, 'send');
const rpcEvent = await client.waitEvent({ events: ['worker.completed'], runId: 'run-1' });
assert.equal(rpcEvent.type, 'worker.completed');
client.close();
server.close();

const protectedSources = [
  'js/ai/dev/supervisor/dev-supervisor-v0.js',
  'js/ai/dev/workers/tool-surface.js',
  'js/ai/dev/events/dev-events.js',
].map((path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
assert.doesNotMatch(protectedSources, /querySelector|querySelectorAll|\.click\(|document\./, 'dev-parent-realm-worker-control');
const parentSource = fs.readFileSync(new URL('../js/userscript/dev/worker-host/worker-chat-controller.js', import.meta.url), 'utf8');
assert.match(parentSource, /ChatGPTDOMAdapter/);
assert.match(parentSource, /ChatGPTTurnController/);

coordinator.close();
host.close();
extraHost.close();
supervisorTransport.close();
workerTransport.close();
extraTransport.close();

console.log('Round 2 parent Worker runtime tests passed');

if (process.env.GITHUB_ACTIONS === 'true') {
  const { gzipSync } = await import('node:zlib');
  const generated = fs.readFileSync(new URL('../userscript/hex.user.template.js', import.meta.url));
  console.log(`::notice file=userscript/hex.user.template.js,title=HEX_GENERATED_TEMPLATE::${gzipSync(generated).toString('base64url')}`);
}
