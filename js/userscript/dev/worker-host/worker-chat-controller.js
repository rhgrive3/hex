import {
  ChatGPTConversationRouter,
  ChatGPTDOMAdapter,
  ChatGPTTurnController,
  waitFor,
} from '../../chatgpt-adapter.js';
import {
  DEV_WORKER_FAILURE,
  DEV_WORKER_NUDGE,
  DEV_WORKER_STATE,
} from '../../../ai/dev/workers/contracts.js';

export class WorkerChatController {
  constructor({ adapter, router, turns, now = () => new Date().toISOString(), document = globalThis.document } = {}) {
    this.adapter = adapter || new ChatGPTDOMAdapter({ document });
    this.router = router || new ChatGPTConversationRouter(this.adapter, { storage: null });
    this.turns = turns || new ChatGPTTurnController(this.adapter);
    this.now = now;
    this.state = DEV_WORKER_STATE.STARTING;
    this.conversation = this.adapter.conversation?.() || null;
    this.responseText = '';
    this.active = null;
    this.lastProgress = null;
    this.listeners = new Set();
  }

  on(listener) {
    if (typeof listener !== 'function') throw new TypeError('Worker listener must be a function.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createChat({ runId, workerId } = {}) {
    if (this.active) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker is already handling a ChatGPT turn.');
    this.state = DEV_WORKER_STATE.STARTING;
    this.responseText = '';
    this.conversation = null;
    const sessionKey = `dev-worker:${String(runId || '')}:${String(workerId || '')}:${Date.now().toString(36)}`;
    try {
      const routed = await this.router.route(sessionKey, {});
      this.conversation = routed.conversation || null;
      return this.snapshot();
    } catch (error) {
      this.state = DEV_WORKER_STATE.FAILED;
      throw mapCreateChatError(error, 'Worker Chat could not be created safely.');
    }
  }

  async send(instruction, context = {}) {
    return this.startTurn(instruction, { ...context, requireConversation: false });
  }

  async followup(text, context = {}) {
    if (!this.conversation?.id) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Worker follow-up requires a settled Worker conversation identity.');
    }
    const current = this.adapter.conversation?.();
    if (!current || current.id !== this.conversation.id) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Worker Chat identity changed before follow-up.');
    }
    return this.startTurn(text, { ...context, requireConversation: true });
  }

  async nudge(context = {}) {
    if (this.active) {
      if (this.adapter.isGenerating?.()) {
        return Object.freeze({
          outcome: 'still-working',
          status: DEV_WORKER_STATE.WORKING,
          chatgptConversationId: this.conversation?.id || null,
          observedAt: this.now(),
        });
      }
      // A quiet local waiter is not proof that ChatGPT is dead. Cancel only
      // Hex's local observation before sending the conservative follow-up.
      this.active.recovery = true;
      this.active.controller.abort('nudge-recovery');
      await waitFor(() => this.active === null ? true : null, 1000);
    }
    return this.followup(DEV_WORKER_NUDGE, context);
  }

  observe() {
    const currentConversation = this.adapter.conversation?.() || this.conversation || null;
    if (currentConversation) this.conversation = currentConversation;
    let state = this.state;
    const hidden = this.adapter.document?.visibilityState === 'hidden';
    if (this.active && hidden) state = DEV_WORKER_STATE.OBSERVABILITY_DEGRADED;
    else if (this.active && !this.adapter.isGenerating?.()) state = DEV_WORKER_STATE.QUIET;
    else if (this.active) state = DEV_WORKER_STATE.WORKING;
    return Object.freeze({
      ...this.snapshot(),
      state,
      generating: !!this.adapter.isGenerating?.(),
      visibility: hidden ? 'background' : 'foreground',
      observability: hidden ? 'degraded' : 'live',
    });
  }

  async stop() {
    const active = this.active;
    if (!active) {
      return Object.freeze({
        outcome: 'not-running',
        ownershipVerified: false,
        controlInvoked: false,
        controllerAborted: false,
        state: this.state,
        generatingObservedAfter: !!this.adapter.isGenerating?.(),
      });
    }
    const current = this.adapter.conversation?.() || null;
    const mismatch = active.observedConversation && current && current.id !== active.observedConversation.id;
    if (mismatch) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Worker Stop refused after Worker Chat identity changed.');
    }
    let clicked = false;
    try {
      clicked = this.turns.stopOwnedGeneration({
        requestUserTurn: active.requestUserTurn,
        normalizedPrompt: normalizeText(active.prompt),
        observedConversation: active.observedConversation,
      }) === true;
    } catch {}
    active.stopRequested = true;
    active.controller.abort('cancelled');
    this.state = DEV_WORKER_STATE.CANCELLED;
    this.emit('cancelled', { reason: 'stop-requested' });
    return Object.freeze({
      outcome: clicked ? 'cancel-requested' : 'cancelled-locally',
      ownershipVerified: !!active.requestUserTurn,
      controlInvoked: clicked,
      controllerAborted: true,
      state: this.state,
      generatingObservedAfter: !!this.adapter.isGenerating?.(),
    });
  }

  result() {
    return Object.freeze({
      status: this.state,
      responseText: this.responseText,
      chatgptConversationId: this.conversation?.id || null,
      observedAt: this.now(),
    });
  }

  async startTurn(raw, { runId = null, workerId = null, requireConversation = false } = {}) {
    if (this.active) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker is already handling a ChatGPT turn.');
    const prompt = String(raw || '');
    if (!prompt.trim()) throw new TypeError('Worker message text is required.');
    const expected = requireConversation ? this.conversation : (this.conversation || null);
    if (requireConversation && (!expected?.id || this.adapter.conversation?.()?.id !== expected.id)) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'Worker Chat identity changed before message submission.');
    }

    const baseline = new Set((this.adapter.userTurns?.() || []).map((turn) => String(turn.id || '')));
    const controller = new AbortController();
    const active = {
      controller,
      prompt,
      requestUserTurn: null,
      observedConversation: expected,
      stopRequested: false,
      recovery: false,
      runId,
      workerId,
      cleanup: null,
      completionError: null,
    };
    this.active = active;
    this.state = DEV_WORKER_STATE.WORKING;
    this.responseText = '';
    this.emit('started', { runId, workerId });

    const completion = this.turns.run(prompt, {
      signal: controller.signal,
      timeoutMs: Infinity,
      expectedConversation: expected,
      newConversation: expected == null,
      onConversation: (conversation) => {
        active.observedConversation = conversation;
        this.conversation = conversation;
        this.progress(active);
      },
    });
    active.cleanup = this.watchProgress(active);
    completion.then(
      (result) => this.completeTurn(active, result),
      (error) => {
        active.completionError = error;
        this.failTurn(active, error);
      },
    );

    let submitted;
    try {
      submitted = await waitFor(() => {
        if (active.completionError) throw active.completionError;
        const fresh = (this.adapter.userTurns?.() || []).filter((turn) => (
          !baseline.has(String(turn.id || '')) && normalizeText(turn.text) === normalizeText(prompt)
        ));
        return fresh.length === 1 ? fresh[0] : null;
      }, 12000, controller.signal);
    } catch (error) {
      if (this.active === active && !controller.signal.aborted) controller.abort('submission-failed');
      throw normalizeTurnError(error, { submitted: !!active.requestUserTurn });
    }

    if (!submitted) {
      if (this.active === active && !controller.signal.aborted) controller.abort('submission-unverified');
      throw workerError(DEV_WORKER_FAILURE.SUBMISSION_FAILURE, 'Worker message submission could not be verified.');
    }
    active.requestUserTurn = submitted;
    active.observedConversation = this.adapter.conversation?.() || active.observedConversation;
    if (active.observedConversation) this.conversation = active.observedConversation;

    return Object.freeze({
      submitted: true,
      status: this.state,
      chatgptConversationId: this.conversation?.id || null,
      observedAt: this.now(),
    });
  }

  completeTurn(active, result) {
    if (this.active !== active) return;
    active.cleanup?.();
    this.active = null;
    this.conversation = result.conversation || this.conversation;
    this.responseText = String(result.text || '');
    this.state = DEV_WORKER_STATE.COMPLETED;
    this.emit('completed', {
      runId: active.runId,
      workerId: active.workerId,
      responseText: this.responseText,
    });
  }

  failTurn(active, error) {
    if (this.active !== active) return;
    active.cleanup?.();
    this.active = null;
    if (active.recovery) {
      this.state = DEV_WORKER_STATE.QUIET;
      return;
    }
    if (active.stopRequested || error?.name === 'AbortError') {
      this.state = DEV_WORKER_STATE.CANCELLED;
      if (!active.stopRequested) {
        this.emit('cancelled', { runId: active.runId, workerId: active.workerId, reason: 'cancelled' });
      }
      return;
    }
    this.state = DEV_WORKER_STATE.FAILED;
    this.emit('failed', {
      runId: active.runId,
      workerId: active.workerId,
      code: mapFailureCode(error, { submitted: !!active.requestUserTurn }),
    });
  }

  watchProgress(active) {
    const root = this.adapter.document?.body || this.adapter.document?.documentElement || null;
    if (!root) return () => {};
    let queued = false;
    const stop = this.adapter.observeMutations?.(root, () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        if (this.active === active) this.progress(active);
      }, 250);
    }) || (() => {});
    return stop;
  }

  progress(active) {
    const assistants = this.adapter.assistantTurns?.() || [];
    const latest = assistants.length ? assistants[assistants.length - 1] : null;
    const conversation = this.adapter.conversation?.() || active.observedConversation || null;
    if (conversation) {
      active.observedConversation = conversation;
      this.conversation = conversation;
    }
    const signature = `${conversation?.id || ''}\u0000${this.adapter.isGenerating?.() ? '1' : '0'}\u0000${String(latest?.text || '')}`;
    if (signature === this.lastProgress) return;
    this.lastProgress = signature;
    this.emit('progress', {
      runId: active.runId,
      workerId: active.workerId,
      generating: !!this.adapter.isGenerating?.(),
      responseText: String(latest?.text || ''),
      chatgptConversationId: conversation?.id || null,
    });
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      chatgptConversationId: this.conversation?.id || null,
      responseText: this.responseText,
      observedAt: this.now(),
    });
  }

  emit(kind, data) {
    const event = Object.freeze({ kind, data: Object.freeze({ ...data }), observedAt: this.now() });
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch {}
    }
  }
}

function mapCreateChatError(error, fallback) {
  const code = String(error?.code || '');
  if (/new-chat|composer|send|dom/i.test(code)) return workerError(DEV_WORKER_FAILURE.DOM_CHANGED, fallback);
  if (/conversation/i.test(code)) {
    return workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, String(error?.message || fallback));
  }
  return workerError(DEV_WORKER_FAILURE.PROVIDER_ERROR, String(error?.message || fallback));
}

function normalizeTurnError(error, { submitted = false } = {}) {
  if (error?.code && Object.values(DEV_WORKER_FAILURE).includes(error.code)) return error;
  const code = mapFailureCode(error, { submitted });
  return workerError(code, String(error?.message || 'Worker Chat turn failed.'));
}

function mapFailureCode(error, { submitted = false } = {}) {
  const code = String(error?.code || '');
  if (/conversation/.test(code)) return DEV_WORKER_FAILURE.CONVERSATION_MISMATCH;
  if (/composer|send-unavailable|new-chat|dom/.test(code)) return DEV_WORKER_FAILURE.DOM_CHANGED;
  if (/submission-unverified|manual-interference/.test(code)) return DEV_WORKER_FAILURE.SUBMISSION_FAILURE;
  if (/response-error|stale-response|timeout/.test(code)) return DEV_WORKER_FAILURE.RESPONSE_FAILURE;
  if (/page-error/.test(code)) return submitted ? DEV_WORKER_FAILURE.RESPONSE_FAILURE : DEV_WORKER_FAILURE.SUBMISSION_FAILURE;
  if (error?.name === 'AbortError') return DEV_WORKER_FAILURE.CANCELLED;
  return submitted ? DEV_WORKER_FAILURE.RESPONSE_FAILURE : DEV_WORKER_FAILURE.PROVIDER_ERROR;
}

function workerError(code, message) { const error = new Error(message); error.code = code; return error; }
function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
