import assert from 'node:assert/strict';
import { SingleConversationWorkerCoordinator } from '../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';
import { DEV_WORKER_STATE } from '../js/ai/dev/workers/contracts.js';

class DeferredController {
  constructor() {
    this.state = DEV_WORKER_STATE.STARTING;
    this.page = { id: 'supervisor-cid', url: 'https://chatgpt.com/c/supervisor-cid' };
    this.worker = null;
    this.responseText = '';
    this.active = false;
    this.listeners = new Set();
    this.navigation = [];
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(kind, data = {}) {
    for (const listener of this.listeners) {
      listener({ kind, data, observedAt: '2026-08-17T00:00:00.000Z' });
    }
  }

  currentConversation() { return this.page ? { ...this.page } : null; }
  currentUserAnchors() { return [{ id: 'supervisor-latest', text: 'latest supervisor request' }]; }
  workerConversation() { return this.worker ? { ...this.worker } : null; }
  isActive() { return this.active; }

  async navigateToConversation(conversation, options = {}) {
    this.navigation.push({ id: conversation.id, options });
    this.page = { ...conversation };
    return this.page;
  }

  async send(_instruction, context = {}) {
    this.worker = { id: 'worker-cid', url: 'https://chatgpt.com/c/worker-cid' };
    this.page = { ...this.worker };
    this.active = true;
    this.state = DEV_WORKER_STATE.WORKING;
    this.emit('started', context);
    return {
      submitted: true,
      status: this.state,
      chatgptConversationId: this.worker.id,
    };
  }

  complete(text = 'done') {
    this.responseText = text;
    this.active = false;
    this.state = DEV_WORKER_STATE.COMPLETED;
    this.emit('completed', { responseText: text });
  }

  observe() {
    return {
      state: this.state,
      chatgptConversationId: this.worker?.id || null,
      responseText: this.responseText,
      observedAt: '2026-08-17T00:00:00.000Z',
      generating: this.active,
      visibility: 'foreground',
      observability: 'live',
    };
  }

  result() {
    return {
      status: this.state,
      responseText: this.responseText,
      chatgptConversationId: this.worker?.id || null,
      observedAt: '2026-08-17T00:00:00.000Z',
    };
  }
}

const controller = new DeferredController();
const coordinator = new SingleConversationWorkerCoordinator({
  controller,
  tabNodeId: 'same-safari-tab',
  now: () => '2026-08-17T00:00:00.000Z',
});

await coordinator.claim({ runId: 'run-ack', workerId: 'worker-ack' });

const ack = await Promise.race([
  coordinator.send({ workerId: 'worker-ack', instruction: 'long-running task' }),
  delay(100).then(() => { throw new Error('dev.worker.send waited for Worker completion instead of returning its submission ACK'); }),
]);

assert.equal(ack.submitted, true);
assert.equal(ack.status, DEV_WORKER_STATE.WORKING);
assert.equal(ack.responseText, undefined);
assert.equal(ack.chatgptConversationId, 'worker-cid');
assert.equal(controller.currentConversation().id, 'worker-cid', 'send ACK must not pretend Supervisor restoration already completed');

let terminalSettled = false;
const terminal = coordinator.waitEvent({ events: ['worker.completed'], runId: 'run-ack' }).then((event) => {
  terminalSettled = true;
  return event;
});
await Promise.resolve();
assert.equal(terminalSettled, false, 'completion must remain pending after the send ACK');

controller.complete('final response');
const completed = await terminal;
assert.equal(completed.type, 'worker.completed');
assert.equal(controller.currentConversation().id, 'supervisor-cid', 'terminal settlement must still restore Supervisor');
assert.equal(controller.navigation.at(-1)?.id, 'supervisor-cid');

const result = await coordinator.result({ workerId: 'worker-ack' });
assert.equal(result.status, DEV_WORKER_STATE.COMPLETED);
assert.equal(result.responseText, 'final response');
assert.equal(result.chatgptConversationId, 'worker-cid');

coordinator.close();
console.log('Dev Worker send ACK regression test passed');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
