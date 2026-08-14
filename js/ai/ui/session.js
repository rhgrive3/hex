/*
 * Conversation state for one binary.
 *
 * A chat transcript is not an analysis session: every turn keeps the mode,
 * style and scope it was asked under, the activity that produced it, and the
 * normalized response, so the panel can be rebuilt from state alone and an
 * answer stays readable after the user changes mode.
 *
 * Pure module — no DOM. The engine is injected, so tests drive real turns
 * without a browser or a network. Tested by tests/ai-ui-mode.mjs.
 */
import { normalizeResponse } from '../render/normalize.js';
import { resolveScope } from './modes.js';

let counter = 0;
const nextId = (prefix) => prefix + '-' + (++counter).toString(36);

export class AiSession {
  constructor({ engine, mode = 'chat', style = 'beginner', scope = 'auto', maxTurns = 200 } = {}) {
    this.engine = engine || null;
    this.mode = mode;
    this.style = style;
    this.scope = scope;
    this.maxTurns = maxTurns;
    this.turns = [];
    this.busy = false;
    this.listeners = new Set();
    this.controller = null;
    this.lastQuestion = null;
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event = {}) {
    for (const listener of Array.from(this.listeners)) {
      try { listener({ session: this, ...event }); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  setMode(mode) { if (mode !== this.mode) { this.mode = mode; this.emit({ type: 'mode' }); } }
  setStyle(style) { if (style !== this.style) { this.style = style; this.emit({ type: 'style' }); } }
  setScope(scope) { if (scope !== this.scope) { this.scope = scope; this.emit({ type: 'scope' }); } }

  clear() {
    this.cancel();
    this.turns = [];
    this.lastQuestion = null;
    this.emit({ type: 'clear' });
  }

  cancel() {
    if (!this.controller) return false;
    const controller = this.controller;
    this.controller = null;
    try { controller.abort(); } catch { /* already aborted */ }
    const pending = this.turns.find((turn) => turn.role === 'assistant' && turn.status === 'running');
    if (pending) { pending.status = 'cancelled'; }
    this.busy = false;
    this.emit({ type: 'cancel' });
    return true;
  }

  trim() {
    if (this.turns.length <= this.maxTurns) return;
    this.turns = this.turns.slice(this.turns.length - this.maxTurns);
  }

  /** Re-run the previous question with the current mode/style/scope. */
  retry(context) {
    if (!this.lastQuestion) return null;
    // Drop the failed assistant turn and its question; the retry re-adds both.
    while (this.turns.length && this.turns[this.turns.length - 1].role === 'assistant') this.turns.pop();
    if (this.turns.length && this.turns[this.turns.length - 1].role === 'user') this.turns.pop();
    return this.ask(this.lastQuestion, context);
  }

  /**
   * Ask one question. Resolves with the assistant turn (never rejects); a
   * failed engine call becomes a turn with `status: 'error'`.
   */
  async ask(question, options = {}) {
    const text = String(question || '').trim();
    if (!text || this.busy) return null;
    const mode = options.mode || this.mode;
    const style = options.style || this.style;
    const scope = options.scope || this.scope;
    const context = options.context || {};
    const effectiveScope = resolveScope(scope, context.state || {});

    this.lastQuestion = text;
    const userTurn = { id: nextId('u'), role: 'user', text, mode, style, scope, at: Date.now() };
    const turn = {
      id: nextId('a'), role: 'assistant', status: 'running', mode, style, scope,
      effectiveScope, activity: [], response: null, error: null, text: '', at: Date.now(),
    };
    this.turns.push(userTurn, turn);
    this.trim();
    this.busy = true;
    this.controller = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = this.controller ? this.controller.signal : null;
    this.emit({ type: 'turn', turn });

    const onActivity = (event) => {
      if (turn.status !== 'running') return;
      const item = typeof event === 'string' ? { label: event } : (event || {});
      turn.activity.push({ id: nextId('v'), label: String(item.label || ''), detail: item.detail == null ? '' : String(item.detail), state: item.state || 'done' });
      this.emit({ type: 'activity', turn });
    };
    const onText = (chunk) => {
      if (turn.status !== 'running') return;
      turn.text += String(chunk || '');
      this.emit({ type: 'stream', turn });
    };

    try {
      if (!this.engine || typeof this.engine.run !== 'function') throw new Error('engine-unavailable');
      const raw = await this.engine.run({
        question: text, mode, style, scope: effectiveScope, requestedScope: scope,
        context, signal, onActivity, onText, history: this.historyFor(),
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
      if (this.controller && this.controller.signal === signal) this.controller = null;
      this.busy = false;
      this.emit({ type: 'settled', turn });
    }
    return turn;
  }

  /** Compact history handed to the engine: text only, bounded. */
  historyFor(limit = 8) {
    return this.turns.slice(-limit * 2).map((turn) => ({
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
  visibleTurns() {
    return this.turns.filter((turn) => turn.role === 'user' || turn.status !== 'pending');
  }
}

export default AiSession;
