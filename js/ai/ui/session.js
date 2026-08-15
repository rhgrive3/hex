/*
 * Conversation state for one binary.
 *
 * A chat transcript is not an analysis session: every turn keeps the mode,
 * style and scope it was asked under, the activity that produced it, and the
 * normalized response, so the panel can be rebuilt from state alone and an
 * answer stays readable after the user changes mode.
 *
 * A session holds several conversations and points at one of them. Everything
 * the old single-chat API exposed (`turns`, `mode`, `style`, `scope`, `busy`)
 * now reads through to the current conversation, so existing callers keep
 * working while New chat, switching and history are possible above them. A
 * running turn writes to the conversation it started in, never to whichever
 * chat happens to be on screen when it finishes.
 *
 * Pure module — no DOM. The engine is injected, so tests drive real turns
 * without a browser or a network. Tested by tests/ai-ui-mode.mjs and
 * tests/ai-ui-conversations.mjs.
 */
import { normalizeResponse } from '../render/normalize.js';
import { resolveScope } from './modes.js';
import { createConversation, createConversationStore, deriveTitle } from './conversations.js';

let counter = 0;
const nextId = (prefix) => prefix + '-' + (++counter).toString(36);

export class AiSession {
  constructor({ engine, mode = 'chat', style = 'beginner', scope = 'auto', maxTurns = 200, storage } = {}) {
    this.engine = engine || null;
    this.maxTurns = maxTurns;
    this.listeners = new Set();
    this.storage = storage === null ? null : (storage || defaultStore(engine));
    this.selection = { provider: null, model: null, reasoning: null };
    this.namespace = this.storage ? this.storage.namespace() : null;
    this.conversations = this.restore(mode, style, scope);
    this.current = this.conversations[this.conversations.length - 1];
    this.saveTimer = null;
  }

  /* ── the current conversation, seen as the old flat session ─ */
  get turns() { return this.current.turns; }
  set turns(value) { this.current.turns = value; }
  get mode() { return this.current.mode; }
  set mode(value) { this.current.mode = value; }
  get style() { return this.current.style; }
  set style(value) { this.current.style = value; }
  get scope() { return this.current.scope; }
  set scope(value) { this.current.scope = value; }
  get busy() { return !!this.current.busy; }
  set busy(value) { this.current.busy = !!value; }
  get controller() { return this.current.controller; }
  set controller(value) { this.current.controller = value; }
  get lastQuestion() { return this.current.lastQuestion; }
  set lastQuestion(value) { this.current.lastQuestion = value; }
  get provider() { return this.current.provider; }
  get model() { return this.current.model; }
  get reasoning() { return this.current.reasoning; }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event = {}) {
    for (const listener of Array.from(this.listeners)) {
      try { listener({ session: this, ...event }); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  setMode(mode) { if (mode !== this.mode) { this.mode = mode; this.touch(); this.emit({ type: 'mode' }); } }
  setStyle(style) { if (style !== this.style) { this.style = style; this.touch(); this.emit({ type: 'style' }); } }
  setScope(scope) { if (scope !== this.scope) { this.scope = scope; this.touch(); this.emit({ type: 'scope' }); } }

  /** Provider / model / reasoning for the current conversation. */
  setSelection(selection = {}) {
    const conversation = this.current;
    let changed = false;
    for (const field of ['provider', 'model', 'reasoning']) {
      if (!(field in selection)) continue;
      const value = selection[field] == null ? null : String(selection[field]);
      if (conversation[field] === value) continue;
      conversation[field] = value;
      this.selection[field] = value; // the default a later New chat inherits
      changed = true;
    }
    if (!changed) return false;
    this.touch();
    this.emit({ type: 'selection' });
    return true;
  }

  selectionOf(conversation = this.current) {
    return { provider: conversation.provider, model: conversation.model, reasoning: conversation.reasoning };
  }

  clear() {
    this.cancel();
    this.current.turns = [];
    this.current.lastQuestion = null;
    this.touch();
    this.emit({ type: 'clear' });
  }

  cancel() {
    const conversation = this.current;
    if (!conversation.controller) return false;
    const controller = conversation.controller;
    conversation.controller = null;
    try { controller.abort(); } catch { /* already aborted */ }
    const pending = conversation.turns.find((turn) => turn.role === 'assistant' && turn.status === 'running');
    if (pending) { pending.status = 'cancelled'; }
    conversation.busy = false;
    this.emit({ type: 'cancel' });
    return true;
  }

  trim() {
    const conversation = this.current;
    if (conversation.turns.length <= this.maxTurns) return;
    conversation.turns = conversation.turns.slice(conversation.turns.length - this.maxTurns);
  }

  /* ── conversations ──────────────────────────────────────── */

  /** Newest first, for a history list. */
  list() {
    return this.conversations.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    return this.conversations.find((item) => item.id === String(id)) || null;
  }

  /**
   * Start a new chat.
   *
   * The previous chat is kept, not cleared. Mode, style, scope and the model
   * selection carry over, because they describe how this user works rather
   * than what the last question was about.
   */
  newConversation({ inherit = true, silent = false } = {}) {
    if (this.busy) return null;
    const from = inherit ? this.current : null;
    /* An untouched blank chat is not worth a second blank chat. */
    if (from && !from.turns.length) { if (!silent) this.emit({ type: 'conversation', conversation: from }); return from; }
    const conversation = createConversation({
      mode: from ? from.mode : 'chat',
      style: from ? from.style : 'beginner',
      scope: from ? from.scope : 'auto',
      provider: from ? from.provider : this.selection.provider,
      model: from ? from.model : this.selection.model,
      reasoning: from ? from.reasoning : this.selection.reasoning,
      namespace: this.namespace,
    });
    this.conversations.push(conversation);
    this.dropOverflow();
    this.current = conversation;
    if (!silent) this.emit({ type: 'conversation', conversation });
    return conversation;
  }

  /** Open an existing chat. Refused while a turn is running. */
  switchTo(id) {
    const conversation = this.get(id);
    if (!conversation || conversation === this.current) return false;
    if (this.busy) return false;
    this.current = conversation;
    this.emit({ type: 'conversation', conversation });
    return true;
  }

  renameConversation(id, title) {
    const conversation = this.get(id);
    if (!conversation) return false;
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (conversation.title === clean) return false;
    conversation.title = clean;
    conversation.updatedAt = Date.now();
    this.scheduleSave();
    this.emit({ type: 'conversations' });
    return true;
  }

  /**
   * Delete a chat.
   *
   * A running chat is never deleted from under its own turn, and the session
   * always has one conversation: deleting the last one leaves a blank chat
   * rather than a session with nothing to type into.
   */
  deleteConversation(id) {
    const conversation = this.get(id);
    if (!conversation || conversation.busy) return false;
    const index = this.conversations.indexOf(conversation);
    this.conversations.splice(index, 1);
    if (this.current === conversation) {
      const next = this.conversations[index] || this.conversations[index - 1] || null;
      this.current = next || createConversation({
        mode: conversation.mode, style: conversation.style, scope: conversation.scope,
        provider: conversation.provider, model: conversation.model, reasoning: conversation.reasoning,
        namespace: this.namespace,
      });
      if (!next) this.conversations.push(this.current);
    }
    this.scheduleSave();
    this.emit({ type: 'conversation', conversation: this.current });
    return true;
  }

  /**
   * Re-read history when the binary under the panel changed.
   *
   * Cheap enough to call from every panel update: it compares one string and
   * only does work when the bucket actually moved.
   */
  syncNamespace() {
    if (!this.storage || this.busy) return false;
    const next = this.storage.namespace();
    if (next === this.namespace) return false;
    this.flushSave(this.namespace);
    this.namespace = next;
    this.conversations = this.restore(this.current.mode, this.current.style, this.current.scope);
    this.current = this.conversations[this.conversations.length - 1];
    this.emit({ type: 'conversation', conversation: this.current });
    return true;
  }

  /* ── asking ─────────────────────────────────────────────── */

  /** Re-run the previous question with the current mode/style/scope. */
  retry(context) {
    if (!this.lastQuestion) return null;
    // Drop the failed assistant turn and its question; the retry re-adds both.
    const turns = this.current.turns;
    while (turns.length && turns[turns.length - 1].role === 'assistant') turns.pop();
    if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
    return this.ask(this.lastQuestion, context);
  }

  /**
   * Ask one question. Resolves with the assistant turn (never rejects); a
   * failed engine call becomes a turn with `status: 'error'`.
   */
  async ask(question, options = {}) {
    const text = String(question || '').trim();
    if (!text || this.busy) return null;
    /* Bound to the conversation, not to `this.current`: an answer must land in
       the chat it was asked in even if the user moves on. */
    const conversation = this.current;
    const mode = options.mode || conversation.mode;
    const style = options.style || conversation.style;
    const scope = options.scope || conversation.scope;
    const context = options.context || {};
    const effectiveScope = resolveScope(scope, context.state || {});

    conversation.lastQuestion = text;
    if (!conversation.title) conversation.title = deriveTitle(text);
    const userTurn = { id: nextId('u'), role: 'user', text, mode, style, scope, at: Date.now() };
    const turn = {
      id: nextId('a'), role: 'assistant', status: 'running', mode, style, scope,
      effectiveScope, activity: [], response: null, error: null, text: '', at: Date.now(),
    };
    conversation.turns.push(userTurn, turn);
    this.trim();
    conversation.busy = true;
    conversation.updatedAt = Date.now();
    conversation.controller = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = conversation.controller ? conversation.controller.signal : null;
    this.emit({ type: 'turn', turn, conversation });

    const onActivity = (event) => {
      if (turn.status !== 'running') return;
      const item = typeof event === 'string' ? { label: event } : (event || {});
      turn.activity.push({ id: nextId('v'), label: String(item.label || ''), detail: item.detail == null ? '' : String(item.detail), state: item.state || 'done' });
      this.emit({ type: 'activity', turn, conversation });
    };
    const onText = (chunk) => {
      if (turn.status !== 'running') return;
      turn.text += String(chunk || '');
      this.emit({ type: 'stream', turn, conversation });
    };

    try {
      if (!this.engine || typeof this.engine.run !== 'function') throw new Error('engine-unavailable');
      const raw = await this.engine.run({
        question: text, mode, style, scope: effectiveScope, requestedScope: scope,
        context, signal, onActivity, onText, history: this.historyFor(8, conversation),
        conversationId: conversation.id,
        provider: conversation.provider, model: conversation.model, reasoning: conversation.reasoning,
      });
      if (turn.status === 'cancelled') return turn;
      turn.response = normalizeResponse(raw, { mode, style });
      if (!turn.response.answerText && turn.text) {
        turn.response = normalizeResponse({ ...(raw && typeof raw === 'object' ? raw : {}), answer: turn.text }, { mode, style });
      }
      turn.status = turn.response.error ? 'error' : 'done';
      turn.error = turn.response.error || null;
    } catch (error) {
      if (turn.status !== 'cancelled') {
        turn.status = 'error';
        turn.error = String((error && error.message) || error || 'unknown-error');
      }
    } finally {
      if (conversation.controller && conversation.controller.signal === signal) conversation.controller = null;
      conversation.busy = false;
      conversation.updatedAt = Date.now();
      this.scheduleSave();
      this.emit({ type: 'settled', turn, conversation });
    }
    return turn;
  }

  /** Compact history handed to the engine: text only, bounded. */
  historyFor(limit = 8, conversation = this.current) {
    return conversation.turns.slice(-limit * 2).map((turn) => ({
      role: turn.role,
      text: turn.role === 'user' ? turn.text : (turn.response ? turn.response.answerText : turn.text),
    })).filter((item) => item.text);
  }

  /**
   * Turns to render.
   *
   * A stopped turn stays in the transcript: hiding it left the question
   * hanging with no reply, which reads as a lost answer rather than a
   * deliberate stop. Only the initial empty assistant shell of a turn that was
   * never started is skipped.
   */
  visibleTurns(conversation = this.current) {
    return conversation.turns.filter((turn) => turn.role === 'user' || turn.status !== 'pending');
  }

  /* ── storage ────────────────────────────────────────────── */

  restore(mode, style, scope) {
    let restored = [];
    if (this.storage) {
      try { restored = this.storage.load(this.namespace); } catch { restored = []; }
    }
    restored = restored.slice(-MAX_RESTORED);
    restored.push(createConversation({ mode, style, scope, namespace: this.namespace, ...this.selection }));
    return restored;
  }

  touch() {
    this.current.updatedAt = Date.now();
    this.scheduleSave();
  }

  dropOverflow() {
    if (this.conversations.length <= MAX_RESTORED + 1) return;
    const oldest = this.conversations
      .filter((item) => item !== this.current)
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))[0];
    if (oldest) this.conversations.splice(this.conversations.indexOf(oldest), 1);
  }

  scheduleSave() {
    if (!this.storage || this.saveTimer) return;
    const later = typeof setTimeout === 'function' ? setTimeout : null;
    if (!later) { this.flushSave(); return; }
    this.saveTimer = later(() => { this.saveTimer = null; this.flushSave(); }, 300);
    if (this.saveTimer && typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  flushSave(space) {
    if (!this.storage) return false;
    try { return this.storage.save(this.conversations, space || this.namespace); } catch { return false; }
  }
}

const MAX_RESTORED = 19;

function defaultStore(engine) {
  try {
    if (typeof localStorage === 'undefined') return null;
  } catch { return null; }
  return createConversationStore({
    namespace: () => {
      const context = engine && engine.localContext;
      if (!context) return 'default';
      try { return context.binaryHash || context.projectId || 'default'; } catch { return 'default'; }
    },
  });
}

export default AiSession;
