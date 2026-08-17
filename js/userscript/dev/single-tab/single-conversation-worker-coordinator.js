import { DEV_WORKER_FAILURE, DEV_WORKER_STATE } from '../../../ai/dev/workers/contracts.js';
import { waitFor } from '../../chatgpt-adapter.js';

const EVENT_QUEUE_LIMIT = 128;
const TERMINAL_KINDS = new Set(['completed', 'failed', 'cancelled']);

export class SingleConversationWorkerCoordinator {
  constructor({ controller, tabNodeId, now = () => new Date().toISOString() } = {}) {
    if (!controller || typeof controller.on !== 'function' || typeof controller.currentConversation !== 'function') {
      throw new TypeError('SingleConversationWorkerCoordinator requires a WorkerChatController.');
    }
    if (!tabNodeId) throw new TypeError('SingleConversationWorkerCoordinator requires the current tabNodeId.');
    this.controller = controller;
    this.tabNodeId = String(tabNodeId);
    this.now = now;
    this.claimed = null;
    this.lastResult = null;
    this.events = [];
    this.waiters = new Set();
    this.pendingTerminal = null;
    this.unsubscribe = controller.on((event) => this.onControllerEvent(event));
  }

  advertisement() {
    return Object.freeze({
      tabNodeId: this.tabNodeId,
      role: this.claimed ? 'worker' : 'available',
      state: this.claimed ? this.controller.observe().state : DEV_WORKER_STATE.AVAILABLE,
      claimed: !!this.claimed,
      runId: this.claimed?.runId || null,
      workerId: this.claimed?.workerId || null,
      chatgptConversationId: this.claimed?.workerConversation?.id || null,
      supervisorChatgptConversationId: this.claimed?.supervisorConversation?.id || null,
      lastHeartbeat: this.now(),
    });
  }

  async discover() { return Object.freeze([this.advertisement()]); }

  async claim({ runId, workerId } = {}) {
    const normalizedRun = required(runId, 'runId');
    const normalizedWorker = required(workerId, 'workerId');
    if (this.claimed) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The single-tab Worker slot is already claimed.');
    const supervisorConversation = await waitFor(() => this.controller.currentConversation() || null, 3000);
    if (!supervisorConversation?.id) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Supervisor ChatGPT conversation identity is unavailable.');
    }
    const supervisorAnchors = this.controller.currentUserAnchors?.() || [];
    this.claimed = {
      runId: normalizedRun,
      workerId: normalizedWorker,
      supervisorConversation,
      // iOS ChatGPT may virtualize older turns when returning to a conversation.
      // The most recent Supervisor user turn is enough to prove that the target
      // conversation body, not only its /c/<id> route, has rehydrated. Requiring
      // every historical user turn creates false failures on partially hydrated
      // but already-usable conversations.
      supervisorAnchor: supervisorAnchors.length ? Object.freeze({ ...supervisorAnchors[supervisorAnchors.length - 1] }) : null,
      workerConversation: null,
    };
    this.lastResult = null;
    return this.withIdentity({ state: DEV_WORKER_STATE.STARTING, claimed: true });
  }

  async createChat(args = {}) {
    const claim = this.assertClaim(args);
    try {
      const result = await this.controller.createChat({ runId: claim.runId, workerId: claim.workerId });
      // worker.create_chat is a Supervisor tool call. It must finish with the
      // single Safari tab back on the Supervisor surface; otherwise the very
      // next Supervisor decision races ChatGPT's New Chat SPA hydration. The
      // real Worker controller prepares the logical Worker here and performs
      // the physical New Chat transition atomically with worker.send.
      await this.restoreSupervisor();
      return this.withIdentity(result);
    } catch (error) {
      await this.safeRestoreSupervisor();
      throw error;
    }
  }

  async send(args = {}) {
    const claim = this.assertClaim(args);
    return this.runWorkerTurn(() => this.controller.send(required(args.instruction, 'instruction'), {
      runId: claim.runId,
      workerId: claim.workerId,
    }));
  }

  async observe(args = {}) {
    this.assertClaim(args);
    return this.withIdentity(this.controller.observe());
  }

  async followup(args = {}) {
    const claim = this.assertClaim(args);
    await this.ensureWorkerConversation();
    const text = args.text ?? args.instruction;
    return this.runWorkerTurn(() => this.controller.followup(required(text, 'text'), {
      runId: claim.runId,
      workerId: claim.workerId,
    }));
  }

  async nudge(args = {}) {
    const claim = this.assertClaim(args);
    if (!this.controller.isActive()) await this.ensureWorkerConversation();
    return this.runWorkerTurn(() => this.controller.nudge({ runId: claim.runId, workerId: claim.workerId }), {
      allowImmediate: true,
    });
  }

  async stop(args = {}) {
    this.assertClaim(args);
    const result = await this.controller.stop();
    if (this.pendingTerminal) await this.pendingTerminal.promise.catch(() => null);
    else await this.restoreSupervisor();
    return this.withIdentity(result);
  }

  async result(args = {}) {
    this.assertClaim(args);
    return this.lastResult || this.withIdentity(this.controller.result());
  }

  async release(args = {}) {
    this.assertClaim(args);
    if (this.controller.isActive()) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Cannot release the single-tab Worker while it is generating.');
    }
    await this.restoreSupervisor();
    this.claimed = null;
    this.lastResult = null;
    return this.advertisement();
  }

  waitEvent({ events, runId = null } = {}, { signal } = {}) {
    const wanted = normalizeEvents(events);
    const normalizedRun = runId == null ? null : String(runId);
    const queuedIndex = this.events.findIndex((event) => matches(event, wanted, normalizedRun));
    if (queuedIndex >= 0) return Promise.resolve(this.events.splice(queuedIndex, 1)[0]);
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolve, reject) => {
      const waiter = { wanted, runId: normalizedRun, resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        this.waiters.delete(waiter);
        reject(abortError(signal?.reason));
      };
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  close() {
    this.unsubscribe?.();
    for (const waiter of this.waiters) {
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      waiter.reject(workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, 'Single-tab Worker coordinator closed.'));
    }
    this.waiters.clear();
    this.events.length = 0;
    this.pendingTerminal?.reject(workerError(DEV_WORKER_FAILURE.CANCELLED, 'Single-tab Worker coordinator closed.'));
    this.pendingTerminal = null;
    this.claimed = null;
  }

  async runWorkerTurn(operation, { allowImmediate = false } = {}) {
    const pending = this.armTerminal();
    try {
      const initial = await operation();
      if (allowImmediate && initial?.outcome === 'still-working') return this.withIdentity(initial);
      await pending.promise;
      return this.lastResult || this.withIdentity(this.controller.result());
    } catch (error) {
      if (this.pendingTerminal === pending) this.pendingTerminal = null;
      pending.reject(error);
      await this.safeRestoreSupervisor();
      throw error;
    }
  }

  armTerminal() {
    if (this.pendingTerminal) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'A Worker completion is already pending.');
    }
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // A synchronous submission failure can reject this completion before the
    // caller reaches `await pending.promise`. Attach a handler immediately so
    // recovery never creates an unhandled rejection in WebKit.
    promise.catch(() => {});
    this.pendingTerminal = { promise, resolve, reject };
    return this.pendingTerminal;
  }

  onControllerEvent(event) {
    if (!event?.kind || !this.claimed) return;
    if (TERMINAL_KINDS.has(event.kind)) {
      void this.finishTerminal(event);
      return;
    }
    this.enqueue(this.normalizeControllerEvent(event));
  }

  async finishTerminal(event) {
    const claim = this.claimed;
    if (!claim) return;
    const workerConversation = this.controller.workerConversation();
    if (workerConversation?.id) claim.workerConversation = workerConversation;
    this.lastResult = this.withIdentity(this.controller.result());
    let normalized = this.normalizeControllerEvent(event);
    try {
      await this.restoreSupervisor();
    } catch (error) {
      normalized = Object.freeze({
        type: 'worker.failed',
        data: Object.freeze({
          runId: claim.runId,
          workerId: claim.workerId,
          code: DEV_WORKER_FAILURE.CONVERSATION_MISMATCH,
          message: String(error?.message || 'Supervisor conversation restore failed.').slice(0, 512),
          workerResponseCaptured: !!this.lastResult?.responseText,
        }),
        observedAt: this.now(),
      });
      this.lastResult = Object.freeze({
        ...this.lastResult,
        status: DEV_WORKER_STATE.FAILED,
        restoreError: DEV_WORKER_FAILURE.CONVERSATION_MISMATCH,
      });
    }
    this.enqueue(normalized);
    const pending = this.pendingTerminal;
    this.pendingTerminal = null;
    pending?.resolve(normalized);
  }

  normalizeControllerEvent(event) {
    return Object.freeze({
      type: `worker.${event.kind}`,
      data: Object.freeze({
        runId: this.claimed?.runId || null,
        workerId: this.claimed?.workerId || null,
        ...(event.data || {}),
      }),
      observedAt: String(event.observedAt || this.now()),
    });
  }

  enqueue(event) {
    for (const waiter of [...this.waiters]) {
      if (!matches(event, waiter.wanted, waiter.runId)) continue;
      this.waiters.delete(waiter);
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      waiter.resolve(event);
      return;
    }
    this.events.push(event);
    while (this.events.length > EVENT_QUEUE_LIMIT) this.events.shift();
  }

  async ensureWorkerConversation() {
    const claim = this.claimed;
    const conversation = claim?.workerConversation || this.controller.workerConversation();
    if (!conversation?.id) throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Worker Chat identity is unavailable.');
    claim.workerConversation = conversation;
    const current = this.controller.currentConversation();
    if (current?.id === conversation.id) return current;
    return this.controller.navigateToConversation(conversation, {
      sessionKey: `dev-worker-return:${claim.runId}:${claim.workerId}`,
    });
  }

  async restoreSupervisor() {
    const claim = this.claimed;
    if (!claim?.supervisorConversation?.id) return null;
    const current = this.controller.currentConversation();
    if (current?.id === claim.supervisorConversation.id) return current;

    // Worker navigation needs the controller's full remembered-history guard,
    // but returning to the Supervisor only needs one strong continuity anchor:
    // the latest user turn that existed immediately before delegation. ChatGPT
    // on iPad can virtualize older history indefinitely even though the route,
    // composer, latest turn and conversation context are already usable.
    const expected = claim.supervisorConversation;
    const key = `dev-supervisor-return:${claim.runId}`;
    this.controller.router.bind(key, expected);
    const routed = await this.controller.router.route(key, {});
    if (!routed?.conversation || routed.conversation.id !== expected.id) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'ChatGPT did not reach the requested Supervisor conversation.');
    }
    if (!claim.supervisorAnchor) return routed.conversation;

    const hydrated = await this.controller.waitForConversationHydration(expected, [claim.supervisorAnchor], {});
    if (!hydrated) {
      throw workerError(
        DEV_WORKER_FAILURE.CONVERSATION_MISMATCH,
        'ChatGPT reached the requested Supervisor conversation route before its latest continuity turn finished rehydrating.',
      );
    }
    return hydrated;
  }

  async safeRestoreSupervisor() {
    try { return await this.restoreSupervisor(); } catch { return null; }
  }

  assertClaim(args = {}) {
    if (!this.claimed) throw workerError(DEV_WORKER_FAILURE.WORKER_UNAVAILABLE, 'No logical Worker is currently claimed.');
    if (args.workerId != null && String(args.workerId) !== this.claimed.workerId) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The requested workerId does not own the single-tab Worker slot.');
    }
    if (args.runId != null && String(args.runId) !== this.claimed.runId) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The requested runId does not own the single-tab Worker slot.');
    }
    return this.claimed;
  }

  withIdentity(value = {}) {
    return Object.freeze({
      ...(value || {}),
      runId: this.claimed?.runId || null,
      workerId: this.claimed?.workerId || null,
      tabNodeId: this.tabNodeId,
      supervisorChatgptConversationId: this.claimed?.supervisorConversation?.id || null,
      chatgptConversationId: value?.chatgptConversationId || this.claimed?.workerConversation?.id || null,
    });
  }
}

function matches(event, wanted, runId) {
  return wanted.has(event.type) && (runId == null || String(event.data?.runId || '') === runId);
}
function normalizeEvents(events) {
  if (!Array.isArray(events) || !events.length) throw new TypeError('waitEvent.events must be a non-empty array.');
  const out = new Set();
  for (const event of events) {
    const value = String(event || '').trim();
    if (!value) throw new TypeError('waitEvent event names must be non-empty.');
    out.add(value);
  }
  return out;
}
function required(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
function workerError(code, message) { const error = new Error(message); error.code = code; return error; }
function abortError(reason) { const error = workerError(DEV_WORKER_FAILURE.CANCELLED, String(reason || 'cancelled')); error.name = 'AbortError'; return error; }
