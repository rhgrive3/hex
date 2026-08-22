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

const CONVERSATION_ANCHOR_LIMIT = 64;
const DEFAULT_HYDRATION_SETTLE_MS = 240;
const DEFAULT_HYDRATION_TIMEOUT_MS = 6000;

export class WorkerChatController {
  constructor({
    adapter,
    router,
    turns,
    now = () => new Date().toISOString(),
    document = globalThis.document,
    hydrationSettleMs = DEFAULT_HYDRATION_SETTLE_MS,
    hydrationTimeoutMs = DEFAULT_HYDRATION_TIMEOUT_MS,
  } = {}) {
    this.adapter = adapter || new ChatGPTDOMAdapter({ document });
    this.router = router || new ChatGPTConversationRouter(this.adapter, { storage: null });
    this.turns = turns || new ChatGPTTurnController(this.adapter);
    this.now = now;
    this.hydrationSettleMs = positiveMs(hydrationSettleMs, DEFAULT_HYDRATION_SETTLE_MS);
    this.hydrationTimeoutMs = positiveMs(hydrationTimeoutMs, DEFAULT_HYDRATION_TIMEOUT_MS);
    this.state = DEV_WORKER_STATE.STARTING;
    this.conversation = this.adapter.conversation?.() || null;
    this.responseText = '';
    this.active = null;
    this.lastProgress = null;
    this.listeners = new Set();
    this.conversationAnchors = new Map();
    this.prepared = false;
  }

  on(listener) {
    if (typeof listener !== 'function') throw new TypeError('Worker listener must be a function.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  currentConversation() {
    const value = this.adapter.conversation?.() || null;
    if (!value?.id || !value?.url) return null;
    const conversation = { id: String(value.id), url: String(value.url) };
    const currentAnchors = this.currentUserAnchors();
    const expectedAnchors = this.conversationAnchors.get(conversation.id) || [];

    // A route match is not enough on iOS/WebKit. ChatGPT can expose the old
    // /c/<id> hundreds of milliseconds before React has rehydrated that
    // conversation's turns. During that window an empty user-turn baseline would
    // make historical turns look like manual interference. Treat the route as
    // unavailable until the user-turn anchors captured before navigation return.
    if (expectedAnchors.length && !conversationAnchorsPresent(expectedAnchors, currentAnchors)) return null;
    if (currentAnchors.length) this.rememberConversationAnchors(conversation, currentAnchors);
    return conversation;
  }

  adoptCurrentConversation() {
    const value = this.adapter.conversation?.() || null;
    if (!value?.id || !value?.url) return null;
    if (this.adapter.isGenerating?.()) return null;
    if (!this.adapter.composer?.()) return null;
    const currentAnchors = this.currentUserAnchors();
    if (!currentAnchors.length) return null;

    // worker.claim runs only after the owned Supervisor model turn has settled.
    // On iPad/WebKit, older remembered user turns may already be virtualized by
    // then even though the current route, composer and latest Supervisor turn
    // are live. Re-adopt only this settled visible surface and replace stale
    // historical hydration requirements with the anchors that are authoritative
    // now. Ordinary navigation keeps the stricter currentConversation() policy.
    const conversation = { id: String(value.id), url: String(value.url) };
    this.rememberConversationAnchors(conversation, currentAnchors);
    return conversation;
  }

  workerConversation() {
    return this.conversation ? { id: String(this.conversation.id), url: String(this.conversation.url) } : null;
  }

  isActive() { return !!this.active; }

  async navigateToConversation(conversation, {
    sessionKey = null,
    signal,
    timeoutMs,
    continuityAnchor = undefined,
  } = {}) {
    if (!conversation?.id || !conversation?.url) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'A concrete ChatGPT conversation is required for Worker navigation.');
    }
    const expected = { id: String(conversation.id), url: String(conversation.url) };
    const rememberedAnchors = this.conversationAnchors.get(expected.id) || [];
    // Default navigation remains strict and requires every remembered user-turn
    // anchor. A caller may provide one explicit continuity anchor when that is
    // the strongest stable proof available (the single-tab Supervisor restore
    // path on iPad, where older turns may stay virtualized after the chat is
    // already usable). `null` explicitly means route/composer stability only.
    const anchors = continuityAnchor === undefined
      ? rememberedAnchors
      : normalizeContinuityAnchors(continuityAnchor);
    const key = String(sessionKey || `dev-worker-navigation:${expected.id}`);
    this.router.bind(key, expected);
    const routed = await this.router.route(key, { signal, ...(timeoutMs == null ? {} : { timeoutMs }) });
    if (!routed?.conversation || routed.conversation.id !== expected.id) {
      throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH, 'ChatGPT did not reach the requested conversation.');
    }
    if (!anchors.length) return routed.conversation;

    const hydrated = await this.waitForConversationHydration(expected, anchors, { signal, timeoutMs });
    if (!hydrated) {
      throw workerError(
        DEV_WORKER_FAILURE.CONVERSATION_MISMATCH,
        'ChatGPT reached the requested conversation route before its required continuity turns finished rehydrating.',
      );
    }
    return hydrated;
  }

  currentUserAnchors() {
    let turns = [];
    try { turns = this.adapter.userTurns?.() || []; } catch { turns = []; }
    return turns
      .map((turn) => ({ id: String(turn?.id || ''), text: normalizeText(turn?.text || '') }))
      .filter((turn) => turn.id || turn.text)
      .slice(-CONVERSATION_ANCHOR_LIMIT);
  }

  rememberConversationAnchors(conversation, anchors = this.currentUserAnchors()) {
    const id = String(conversation?.id || '');
    if (!id || !anchors.length) return;
    this.conversationAnchors.set(id, Object.freeze(anchors.slice(-CONVERSATION_ANCHOR_LIMIT).map((anchor) => Object.freeze({ ...anchor }))));
  }

  async waitForConversationHydration(conversation, anchors, { signal, timeoutMs } = {}) {
    const wanted = String(conversation?.id || '');
    if (!wanted || !anchors?.length) return conversation || null;
    const waitMs = positiveMs(timeoutMs, this.hydrationTimeoutMs);
    let stableSignature = null;
    let stableSince = null;
    const ready = await waitFor(() => {
      const visible = this.adapter.conversation?.() || null;
      const current = this.currentUserAnchors();
      const composer = this.adapter.composer?.() || null;
      if (String(visible?.id || '') !== wanted
        || !composer
        || this.adapter.isGenerating?.()
        || !conversationAnchorsPresent(anchors, current)) {
        stableSignature = null;
        stableSince = null;
        return null;
      }

      const signature = conversationAnchorSignature(current);
      if (signature !== stableSignature) {
        stableSignature = signature;
        stableSince = Date.now();
        return null;
      }
      if (stableSince === null || Date.now() - stableSince < this.hydrationSettleMs) return null;

      const hydrated = { id: String(visible.id), url: String(visible.url || conversation.url) };
      this.rememberConversationAnchors(hydrated, current);
      return hydrated;
    }, waitMs, signal);
    return ready || null;
  }

  async createChat() {
    if (this.active) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'Worker is already handling a ChatGPT turn.');
    // In one Safari tab, a blank ChatGPT New Chat has no durable conversation
    // identity. Navigating there during worker.create_chat and then asking the
    // Supervisor for its next decision creates a race: the Supervisor must steal
    // the same tab back while the blank route is still hydrating. Prepare the
    // logical Worker here and perform the physical New Chat transition atomically
    // with worker.send instead.
    this.state = DEV_WORKER_STATE.STARTING;
    this.responseText = '';
    this.conversation = null;
    this.prepared = true;
    return Object.freeze({ ...this.snapshot(), prepared: true });
  }

  async send(instruction, context = {}) {
    if (this.prepared && !this.conversation?.id) {
      const sessionKey = `dev-worker:${String(context.runId || '')}:${String(context.workerId || '')}:${Date.now().toString(36)}`;
      try {
        const routed = await this.router.route(sessionKey, {});
        this.conversation = routed.conversation || null;
        this.prepared = false;
      } catch (error) {
        this.state = DEV_WORKER_STATE.FAILED;
        throw mapCreateChatError(error, 'Worker Chat could not be created safely before message submission.');
      }
    }
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
    const pageConversation = this.adapter.conversation?.() || null;
    // Only an active Worker turn may adopt the currently visible ChatGPT route.
    // After completion the single tab is deliberately restored to Supervisor;
    // that route must never overwrite the retained Worker conversation identity.
    if (this.active && pageConversation) this.conversation = pageConversation;
    let state = this.state;
    const hidden = this.adapter.document?.visibilityState === 'hidden';
    if (this.active && hidden) state = DEV_WORKER_STATE.OBSERVABILITY_DEGRADED;
    else if (this.active && !this.adapter.isGenerating?.()) state = DEV_WORKER_STATE.QUIET;
    else if (this.active) state = DEV_WORKER_STATE.WORKING;
    return Object.freeze({
      ...this.snapshot(),
      state,
      pageChatgptConversationId: pageConversation?.id || null,
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
        // ChatGPTTurnController already proves the exact composer contents before
        // its owned Send click and rejects positive manual interference. At this
        // outer Worker boundary, renderer text is not authoritative: iPad/WebKit
        // may hydrate a long user turn late or incorrectly. One fresh explicit
        // user-turn identity is therefore the submission evidence, matching the
        // canonical ChatGPT turn ownership rule instead of re-verifying its text.
        const fresh = (this.adapter.userTurns?.() || []).filter((turn) => (
          !baseline.has(String(turn.id || ''))
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

function conversationAnchorsPresent(expected, current) {
  return (expected || []).every((anchor) => (current || []).some((turn) => {
    if (anchor.id && turn.id === anchor.id) return true;
    return !!anchor.text && turn.text === anchor.text;
  }));
}
function conversationAnchorSignature(anchors) {
  return (anchors || []).map((anchor) => `${anchor.id}\u0000${anchor.text}`).join('\u0001');
}
function normalizeContinuityAnchors(value) {
  if (value == null) return [];
  const id = String(value?.id || '');
  const text = normalizeText(value?.text || '');
  return id || text ? [Object.freeze({ id, text })] : [];
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

function positiveMs(value, fallback) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
function workerError(code, message) { const error = new Error(message); error.code = code; return error; }
function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }