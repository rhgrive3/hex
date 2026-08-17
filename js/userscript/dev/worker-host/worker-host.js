import { DEV_WORKER_FAILURE, DEV_WORKER_STATE } from '../../../ai/dev/workers/contracts.js';
import { TAB_NODE_ROLE, updateTabNode } from '../tab-mesh/tab-node.js';
import { WorkerChatController } from './worker-chat-controller.js';

export class WorkerTabHost {
  constructor({ transport, tabNode, controller = new WorkerChatController(), now = () => new Date().toISOString() } = {}) {
    if (!transport || typeof transport.setRequestHandler !== 'function' || typeof transport.emit !== 'function') {
      throw new TypeError('WorkerTabHost requires a TabTransport.');
    }
    if (!tabNode?.tabNodeId) throw new TypeError('WorkerTabHost requires a TabNode.');
    this.transport = transport;
    this.node = updateTabNode(tabNode, { role: TAB_NODE_ROLE.AVAILABLE }, { now });
    this.controller = controller;
    this.now = now;
    this.claim = null;
    this.unsubscribeController = controller.on((event) => { void this.forwardControllerEvent(event); });
    transport.setRequestHandler((method, params, context) => this.handle(method, params, context));
  }

  async register() {
    const data = this.advertisement();
    await this.transport.emit('worker.registered', data, { to: '*' });
    return data;
  }

  advertisement() {
    this.node = updateTabNode(this.node, {}, { now: this.now });
    const state = this.claim ? this.controller.observe().state : DEV_WORKER_STATE.AVAILABLE;
    return Object.freeze({ ...this.node, state, claimed: !!this.claim });
  }

  async handle(method, params = {}, context = {}) {
    if (method === 'mesh.discover') return this.advertisement();
    if (method === 'worker.claim') return this.claimWorker(params, context);
    if (method === 'worker.create_chat') {
      this.assertOwner(params, context);
      const result = await this.controller.createChat(params);
      this.refreshNode();
      return this.withIdentity(result);
    }
    if (method === 'worker.send') {
      this.assertOwner(params, context);
      const result = await this.controller.send(params.instruction, params);
      this.refreshNode();
      return this.withIdentity(result);
    }
    if (method === 'worker.observe') {
      this.assertOwner(params, context);
      this.refreshNode();
      return this.withIdentity(this.controller.observe());
    }
    if (method === 'worker.followup') {
      this.assertOwner(params, context);
      const result = await this.controller.followup(params.text, params);
      this.refreshNode();
      return this.withIdentity(result);
    }
    if (method === 'worker.nudge') {
      this.assertOwner(params, context);
      const result = await this.controller.nudge(params);
      this.refreshNode();
      return this.withIdentity(result);
    }
    if (method === 'worker.stop') {
      this.assertOwner(params, context);
      const result = await this.controller.stop();
      this.refreshNode();
      return this.withIdentity(result);
    }
    if (method === 'worker.result') {
      this.assertOwner(params, context);
      return this.workerResult();
    }
    if (method === 'worker.release') return this.release(params, context);
    throw workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, `Unsupported Worker operation: ${method}`);
  }

  claimWorker(params, context) {
    const runId = required(params.runId, 'runId');
    const workerId = required(params.workerId, 'workerId');
    if (this.claim) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker Tab is already claimed.');
    this.claim = Object.freeze({
      runId,
      workerId,
      supervisorTabNodeId: required(context.from, 'supervisorTabNodeId'),
    });
    this.node = updateTabNode(this.node, { role: TAB_NODE_ROLE.WORKER, runId, workerId }, { now: this.now });
    return this.advertisement();
  }

  release(params, context) {
    this.assertOwner(params, context);
    const observed = this.controller.observe();
    if ([DEV_WORKER_STATE.WORKING, DEV_WORKER_STATE.QUIET, DEV_WORKER_STATE.OBSERVABILITY_DEGRADED].includes(observed.state)) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker must be stopped or completed before release.');
    }
    this.claim = null;
    this.node = updateTabNode(this.node, {
      role: TAB_NODE_ROLE.AVAILABLE,
      runId: null,
      workerId: null,
      chatgptConversationId: null,
    }, { now: this.now });
    return this.advertisement();
  }

  assertOwner(params = {}, context = {}) {
    if (!this.claim) throw workerError(DEV_WORKER_FAILURE.WORKER_UNAVAILABLE, 'Worker Tab is not claimed.');
    if (String(context.from || '') !== this.claim.supervisorTabNodeId) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker command came from a non-owner Supervisor tab.');
    }
    if (String(params.runId || '') !== this.claim.runId || String(params.workerId || '') !== this.claim.workerId) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker claim identity does not match this command.');
    }
  }

  workerResult() {
    const result = this.controller.result();
    return Object.freeze({
      workerId: this.claim?.workerId || this.node.workerId || null,
      tabNodeId: this.node.tabNodeId,
      chatgptConversationId: result.chatgptConversationId,
      status: result.status,
      responseText: result.responseText,
      observedAt: result.observedAt,
    });
  }

  withIdentity(value) {
    const result = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      ...result,
      workerId: this.claim?.workerId || null,
      tabNodeId: this.node.tabNodeId,
      runId: this.claim?.runId || null,
      chatgptProjectIdentity: this.node.chatgptProjectIdentity ?? null,
    });
  }

  refreshNode() {
    const conversationId = this.controller.observe().chatgptConversationId;
    this.node = updateTabNode(this.node, { chatgptConversationId: conversationId }, { now: this.now });
  }

  async forwardControllerEvent(event) {
    if (!this.claim) return;
    this.refreshNode();
    const type = `worker.${event.kind}`;
    const data = {
      runId: this.claim.runId,
      workerId: this.claim.workerId,
      tabNodeId: this.node.tabNodeId,
      chatgptConversationId: this.node.chatgptConversationId,
      status: this.controller.observe().state,
      observedAt: event.observedAt,
    };
    if (event.kind === 'progress') {
      data.generating = event.data.generating === true;
      data.responseLength = String(event.data.responseText || '').length;
    }
    if (event.kind === 'failed') data.code = String(event.data.code || DEV_WORKER_FAILURE.PROVIDER_ERROR);
    if (event.kind === 'cancelled') data.reason = String(event.data.reason || DEV_WORKER_FAILURE.CANCELLED);
    await this.transport.emit(type, data, { to: this.claim.supervisorTabNodeId }).catch(() => {});
  }

  close() {
    this.unsubscribeController?.();
    this.transport.setRequestHandler(null);
  }
}

function required(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
function workerError(code, message) { const error = new Error(message); error.code = code; return error; }
