import { ChatGPTBridgeError, waitFor } from './chatgpt-adapter.js';

/*
 * ChatGPT changes its conversation DOM independently from Hex. Prefer the
 * semantic role markers when present, but keep one tightly-scoped fallback on
 * conversation-turn test ids so a UI markup migration cannot turn a visible
 * completed response into a provider timeout.
 */
export class ResilientChatGPTTurnController {
  constructor(adapter, {
    quietMs = 1500,
    pollMs = 120,
    startTimeoutMs = 10000,
    conversationGraceMs = 3000,
  } = {}) {
    this.adapter = adapter;
    this.quietMs = quietMs;
    this.pollMs = pollMs;
    this.startTimeoutMs = startTimeoutMs;
    this.conversationGraceMs = conversationGraceMs;
  }

  async run(prompt, { signal, timeoutMs = 110000, expectedConversation = null, onConversation } = {}) {
    const started = Date.now();
    const normalizedPrompt = normalizeText(prompt);
    const composer = await waitFor(() => this.adapter.composer(), Math.min(timeoutMs, this.startTimeoutMs), signal);
    if (!composer) throw new ChatGPTBridgeError('composer-not-found', 'ChatGPT composer was not found.');
    if (this.adapter.isGenerating()) throw new ChatGPTBridgeError('already-generating', 'ChatGPT is already generating a response.');

    const baselineAssistant = new Set(this.assistantTurns().map((turn) => turn.id));
    const baselineUsers = new Set(this.userTurns().map((turn) => turn.id));
    const baselineConversation = new Set(this.conversationTurns().map((turn) => turn.id));

    this.adapter.setComposerText(composer, prompt);
    const send = await waitFor(() => {
      const node = this.adapter.sendButton();
      return node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' ? node : null;
    }, Math.min(this.startTimeoutMs, remaining(started, timeoutMs)), signal);
    if (!send) throw new ChatGPTBridgeError('send-unavailable', 'ChatGPT send button did not become available.');
    send.click();

    let requestUserTurn = null;
    const submitted = await waitFor(() => {
      const explicit = this.userTurns().filter((turn) => !baselineUsers.has(turn.id));
      if (explicit.length > 1) throw new ChatGPTBridgeError('manual-interference', 'Another user turn appeared while Hex was submitting its request.');
      if (explicit.length === 1) {
        if (normalizeText(explicit[0].text) !== normalizedPrompt) throw new ChatGPTBridgeError('manual-interference', 'The submitted ChatGPT turn does not match the Hex request.');
        requestUserTurn = explicit[0];
        return true;
      }

      // New ChatGPT builds can temporarily omit data-message-author-role while
      // retaining the stable conversation-turn test id. Match only the exact
      // prompt, never an arbitrary new turn.
      const generic = this.conversationTurns().filter((turn) =>
        !baselineConversation.has(turn.id) && normalizeText(turn.text) === normalizedPrompt
      );
      if (generic.length > 1) throw new ChatGPTBridgeError('manual-interference', 'Multiple matching user turns appeared while Hex was submitting its request.');
      if (generic.length === 1) {
        requestUserTurn = generic[0];
        return true;
      }
      return false;
    }, Math.min(this.startTimeoutMs, remaining(started, timeoutMs)), signal);
    if (!submitted || !requestUserTurn) throw new ChatGPTBridgeError('submission-unverified', 'The ChatGPT user turn could not be matched to the Hex request.');

    let latest = '';
    let latestId = null;
    let lastChangedAt = Date.now();
    let sawGenerating = this.adapter.isGenerating();
    let observedConversation = expectedConversation;
    let stopObserving = NOOP;

    try {
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) throw abortError(signal.reason);
        const error = this.adapter.errorState();
        if (error) throw new ChatGPTBridgeError('response-error', 'ChatGPT reported an error while generating the Hex turn.', { error });

        const conversation = this.adapter.conversation();
        if (!observedConversation && conversation) {
          observedConversation = conversation;
          onConversation?.(conversation);
        }
        if (observedConversation && conversation?.id !== observedConversation.id) {
          throw new ChatGPTBridgeError('conversation-switched', 'ChatGPT conversation changed while a Hex request was in flight.', { expected: observedConversation, actual: conversation });
        }
        if (this.adapter.isGenerating()) sawGenerating = true;

        const explicit = this.assistantTurns().filter((turn) => !baselineAssistant.has(turn.id));
        if (explicit.length > 1) throw new ChatGPTBridgeError('manual-interference', 'Multiple assistant turns appeared while one Hex request was in flight.');
        const turn = explicit[0] || this.fallbackResponseTurn({
          baselineConversation,
          baselineUsers,
          requestUserTurn,
          normalizedPrompt,
        });

        if (turn) {
          if (latestId && turn.id !== latestId) throw new ChatGPTBridgeError('stale-response', 'The assistant turn identity changed before the Hex response settled.');
          latestId = turn.id;
          if (turn.node && stopObserving === NOOP) {
            stopObserving = this.adapter.observeMutations?.(turn.node, () => { lastChangedAt = Date.now(); }) || NOOP;
          }
          if (turn.text !== latest) {
            latest = turn.text;
            lastChangedAt = Date.now();
          }

          const settledFor = Date.now() - lastChangedAt;
          const responseSettled = latest.trim() && !this.adapter.isGenerating() && settledFor >= this.quietMs && (sawGenerating || requestUserTurn);
          if (responseSettled) {
            const identity = conversation || observedConversation;
            if (identity || settledFor >= Math.max(this.quietMs, this.conversationGraceMs)) {
              return { text: latest.trim(), conversation: identity || null, turnId: turn.id };
            }
          }
        }
        await delay(this.pollMs, signal);
      }
      throw new ChatGPTBridgeError('timeout', 'ChatGPT response capture timed out.', {
        sawResponseText: !!latest.trim(),
        responseTurnId: latestId,
        sawGenerating,
        conversation: observedConversation || null,
      });
    } finally {
      stopObserving();
    }
  }

  fallbackResponseTurn({ baselineConversation, baselineUsers, requestUserTurn, normalizedPrompt }) {
    const freshUsers = new Set(this.userTurns().filter((turn) => !baselineUsers.has(turn.id)).map((turn) => turn.id));
    const candidates = this.conversationTurns().filter((turn) => {
      if (baselineConversation.has(turn.id)) return false;
      if (turn.id === requestUserTurn?.id || freshUsers.has(turn.id)) return false;
      const text = normalizeText(turn.text);
      return !!text && text !== normalizedPrompt;
    });
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  assistantTurns() {
    return canonicalTurns(this.adapter, this.adapter.assistantTurns?.() || []);
  }

  userTurns() {
    return canonicalTurns(this.adapter, this.adapter.userTurns?.() || []);
  }

  conversationTurns() {
    if (typeof this.adapter.conversationTurns === 'function') return canonicalTurns(this.adapter, this.adapter.conversationTurns() || []);
    if (typeof this.adapter.all !== 'function') return [];
    const nodes = this.adapter.all('conversationTurn') || [];
    return canonicalTurns(this.adapter, nodes.map((node) => ({
      node,
      id: this.adapter.identity?.(node),
      text: this.adapter.text?.(node) || '',
    })));
  }
}

function canonicalTurns(adapter, turns) {
  const out = [];
  const seen = new Set();
  for (const source of turns || []) {
    if (!source) continue;
    const root = source.node?.closest?.('[data-testid^="conversation-turn-"]') || source.node || null;
    const id = root && root !== source.node ? (adapter.identity?.(root) || source.id) : source.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = root && root !== source.node ? (adapter.text?.(root) || source.text || '') : (source.text || '');
    out.push({ ...source, node: root || source.node || null, id: String(id), text: String(text || '').trim() });
  }
  return out;
}

function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function remaining(started, timeoutMs) { return Math.max(1, timeoutMs - (Date.now() - started)); }
const NOOP = () => {};

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal.reason)); return; }
    const timer = setTimeout(done, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); reject(abortError(signal?.reason)); };
    function done() { signal?.removeEventListener?.('abort', onAbort); resolve(); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function abortError(reason) { return new DOMException(String(reason || 'cancelled'), 'AbortError'); }

export default ResilientChatGPTTurnController;
