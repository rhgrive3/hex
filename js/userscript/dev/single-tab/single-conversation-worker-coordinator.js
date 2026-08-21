import { DEV_WORKER_FAILURE, DEV_WORKER_STATE } from '../../../ai/dev/workers/contracts.js';
import { waitFor } from '../../chatgpt-adapter.js';

const EVENT_QUEUE_LIMIT = 128;
const SUPERVISOR_CLAIM_TIMEOUT_MS = 30000;
const SUPERVISOR_RESTORE_TIMEOUT_MS = 30000;
const SUPERVISOR_RESTORE_SETTLE_MS = 240;
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
    this.closed = false;
    this.generation = 0;
    this.claiming = null;
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
    if (this.closed) throw workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, 'Single-tab Worker coordinator is closed.');
    if (this.claiming) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The single-tab Worker slot is already being claimed.');
    if (this.claimed) {
      if (this.claimed.runId === normalizedRun && this.claimed.workerId === normalizedWorker) {
        return this.withIdentity({
          state: this.controller.observe().state,
          claimed: true,
          replayed: true,
        });
      }
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The single-tab Worker slot is already claimed.');
    }
    const generation = this.generation;
    this.claiming = Object.freeze({ runId: normalizedRun, workerId: normalizedWorker, generation });
    try {
      const supervisorConversation = await waitFor(() => {
        if (typeof this.controller.adoptCurrentConversation === 'function') {
          return this.controller.adoptCurrentConversation() || null;
        }
        return this.controller.currentConversation() || null;
      }, SUPERVISOR_CLAIM_TIMEOUT_MS);
      if (this.closed || generation !== this.generation) {
        throw workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, 'Single-tab Worker coordinator closed while a claim was settling.');
      }
      if (!supervisorConversation?.id) {
        throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Supervisor ChatGPT conversation identity is unavailable.');
      }
      this.claimed = {
        runId: normalizedRun,
        workerId: normalizedWorker,
        supervisorConversation,
        supervisorAnchor: null,
        workerConversation: null,
      };
      this.refreshSupervisorAnchor();
      this.lastResult = null;
      return this.withIdentity({ state: DEV_WORKER_STATE.STARTING, claimed: true });
    } finally {
      if (this.claiming?.generation === generation) this.claiming = null;
    }
  }

  async createChat(args = {}) {
    const claim = this.assertClaim(args);
    try {
      const result = await this.controller.createChat({ runId: claim.runId, workerId: claim.workerId });
      await this.restoreSupervisor();
      return this.withIdentity(result);
    } catch (error) {
      await this.safeRestoreSupervisor();
      throw error;
    }
  }

  async send(args = {}) {
    const claim = this.assertClaim(args);
    this.refreshSupervisorAnchor();
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
    this.refreshSupervisorAnchor();
    await this.ensureWorkerConversation();
    const text = args.text ?? args.instruction;
    return this.runWorkerTurn(() => this.controller.followup(required(text, 'text'), {
      runId: claim.runId,
      workerId: claim.workerId,
    }));
  }

  async nudge(args = {}) {
    const claim = this.assertClaim(args);
    this.refreshSupervisorAnchor();
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
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.claiming = null;
    this.unsubscribe?.();
    for (const waiter of this.waiters) {
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      waiter.reject(workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, 'Single-tab Worker coordinator closed.'));
    }
    this.waiters.clear();
    this.events.length = 0;
    const error = workerError(DEV_WORKER_FAILURE.CANCELLED, 'Single-tab Worker coordinator closed.');
    this.pendingTerminal?.closeReject?.(error);
    this.pendingTerminal?.reject(error);
    this.pendingTerminal = null;
    this.claimed = null;
  }

  async runWorkerTurn(operation, { allowImmediate = false } = {}) {
    const pending = this.armTerminal();
    try {
      const initial = await Promise.race([Promise.resolve().then(operation), pending.closePromise]);
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
    let closeReject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const closePromise = new Promise((_, rej) => { closeReject = rej; });
    promise.catch(() => {});
    closePromise.catch(() => {});
    this.pendingTerminal = { promise, resolve, reject, closePromise, closeReject };
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
    const generation = this.generation;
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
    if (this.closed || generation !== this.generation || this.claimed !== claim) return;
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

  refreshSupervisorAnchor() {
    const claim = this.claimed;
    if (!claim?.supervisorConversation?.id) return null;
    const current = this.controller.currentConversation();
    if (current?.id !== claim.supervisorConversation.id) return claim.supervisorAnchor;
    const anchors = this.controller.currentUserAnchors?.() || [];
    const latest = anchors.length ? anchors[anchors.length - 1] : null;
    if (latest) claim.supervisorAnchor = Object.freeze({ ...latest });
    return claim.supervisorAnchor;
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

    const canAdoptSettledSurface = typeof this.controller.adoptCurrentConversation === 'function'
      && typeof this.controller.adapter?.conversation === 'function'
      && typeof this.controller.adapter?.composer === 'function';
    if (!canAdoptSettledSurface) {
      return this.controller.navigateToConversation(claim.supervisorConversation, {
        sessionKey: `dev-supervisor-return:${claim.runId}`,
        continuityAnchor: claim.supervisorAnchor,
      });
    }

    // `currentConversation()` intentionally rejects a route whose complete
    // remembered history has not rehydrated. That is too strict for returning to
    // a Supervisor on iPad: old turns may remain permanently virtualized even
    // though the correct route, composer and current Supervisor turns are live.
    // Route first without a historical-turn requirement, then adopt only a
    // settled target surface. If we came from the Worker route, reject its stale
    // user-turn surface until React has actually swapped the conversation DOM.
    const rawBefore = this.controller.adapter.conversation?.() || null;
    const sourceAnchors = rawBefore?.id && rawBefore.id !== claim.supervisorConversation.id
      ? (this.controller.currentUserAnchors?.() || [])
      : [];
    if (rawBefore?.id !== claim.supervisorConversation.id) {
      await this.controller.navigateToConversation(claim.supervisorConversation, {
        sessionKey: `dev-supervisor-return:${claim.runId}`,
        continuityAnchor: null,
      });
    }
    return this.waitForSettledSupervisorSurface(claim, sourceAnchors);
  }

  async waitForSettledSupervisorSurface(claim, sourceAnchors = []) {
    const wanted = String(claim?.supervisorConversation?.id || '');
    if (!wanted) return null;
    let stableSignature = null;
    let stableSince = null;
    const restored = await waitFor(() => {
      const visible = this.controller.adapter?.conversation?.() || null;
      const composer = this.controller.adapter?.composer?.() || null;
      const generating = !!this.controller.adapter?.isGenerating?.();
      const anchors = this.controller.currentUserAnchors?.() || [];
      if (String(visible?.id || '') !== wanted || !composer || generating || !anchors.length) {
        stableSignature = null;
        stableSince = null;
        return null;
      }
      if (sourceAnchors.length && anchorsOverlap(sourceAnchors, anchors)) {
        stableSignature = null;
        stableSince = null;
        return null;
      }

      const signature = anchorSignature(anchors);
      if (signature !== stableSignature) {
        stableSignature = signature;
        stableSince = Date.now();
        return null;
      }
      if (stableSince === null || Date.now() - stableSince < SUPERVISOR_RESTORE_SETTLE_MS) return null;

      const adopted = this.controller.adoptCurrentConversation?.() || null;
      return adopted?.id === wanted ? adopted : null;
    }, SUPERVISOR_RESTORE_TIMEOUT_MS);
    if (!restored) {
      throw workerError(
        DEV_WORKER_FAILURE.CONVERSATION_MISMATCH,
        'Supervisor route was reached, but its usable conversation surface did not settle.',
      );
    }
    return restored;
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

function anchorsOverlap(left, right) {
  return (left || []).some((anchor) => (right || []).some((turn) => sameAnchor(anchor, turn)));
}
function sameAnchor(left, right) {
  const leftId = String(left?.id || '');
  const rightId = String(right?.id || '');
  if (leftId && rightId && leftId === rightId) return true;
  const leftText = String(left?.text || '').replace(/\s+/g, ' ').trim();
  const rightText = String(right?.text || '').replace(/\s+/g, ' ').trim();
  return !!leftText && leftText === rightText;
}
function anchorSignature(anchors) {
  return (anchors || []).map((anchor) => `${String(anchor?.id || '')}\u0000${String(anchor?.text || '').replace(/\s+/g, ' ').trim()}`).join('\u0001');
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
