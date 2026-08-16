import { CHATGPT_SELECTORS } from './chatgpt-selectors.js';

const CONVERSATION_PATH = /^\/c\/([^/?#]+)/;
const MODEL_PATTERNS = Object.freeze([
  { id: 'chatgpt-web/sol', pattern: /(?:gpt[- ]?5\.6\s*)?sol/i, label: 'GPT-5.6 Sol' },
  { id: 'chatgpt-web/terra', pattern: /(?:gpt[- ]?5\.6\s*)?terra/i, label: 'GPT-5.6 Terra' },
  { id: 'chatgpt-web/luna', pattern: /(?:gpt[- ]?5\.6\s*)?luna/i, label: 'GPT-5.6 Luna' },
]);
const REASONING_PATTERNS = Object.freeze([
  { id: 'auto', pattern: /\bauto(?:matic)?\b/i, label: 'Auto' },
  { id: 'fast', pattern: /\b(?:fast|instant)\b/i, label: 'Fast' },
  { id: 'standard', pattern: /\b(?:standard|medium)\b/i, label: 'Standard' },
  { id: 'high', pattern: /\bhigh\b/i, reject: /extra|xhigh/i, label: 'High' },
  { id: 'xhigh', pattern: /\b(?:extra high|xhigh)\b/i, label: 'Extra High' },
  { id: 'pro', pattern: /\bpro\b/i, label: 'Pro' },
]);

export class ChatGPTBridgeError extends Error {
  /*
   * `stage` names the bridge component that refused the turn. It is the only
   * structured diagnostic that is allowed to cross the parent RPC boundary
   * alongside `code`, so a production `provider_error` can always be traced
   * back to the exact guard that fired without exposing DOM or prompt text.
   */
  constructor(code, message, details = null, stage = null) {
    super(message);
    this.name = 'ChatGPTBridgeError';
    this.code = code;
    this.details = details;
    this.stage = stage ? String(stage) : null;
  }
}

export class ChatGPTDOMAdapter {
  constructor({ document = globalThis.document, location = globalThis.location, history = globalThis.history, selectors = CHATGPT_SELECTORS } = {}) {
    this.document = document;
    this.location = location;
    this.history = history;
    this.selectors = selectors;
    this.nodeIds = new WeakMap();
    this.nodeSequence = 1;
  }

  first(kind) {
    for (const selector of this.selectors[kind] || []) {
      let node = null;
      try { node = this.document?.querySelector?.(selector); } catch { node = null; }
      if (node) return node;
    }
    return null;
  }

  all(kind) {
    const seen = new Set(), out = [];
    for (const selector of this.selectors[kind] || []) {
      let values = [];
      try { values = this.document?.querySelectorAll?.(selector) || []; } catch { values = []; }
      for (const raw of values) {
        // A ChatGPT turn can match both its role node and its conversation-turn
        // wrapper. Canonicalize both to one logical turn before deduplication so
        // Hex never mistakes one DOM turn for concurrent user/model activity.
        const node = raw.closest?.('[data-testid^="conversation-turn-"]') || raw.closest?.('[data-message-author-role]') || raw;
        if (!seen.has(node)) { seen.add(node); out.push(node); }
      }
    }
    return out;
  }

  composer() { return this.first('composer'); }
  sendButton() { return this.first('send'); }
  stopButton() { return this.first('stop'); }
  newChatButton() { return this.first('newChat'); }
  modelPicker() { return this.first('modelPicker'); }
  reasoningControl() { return this.first('reasoningControl'); }
  isGenerating() { return !!this.stopButton(); }
  stop() { try { this.stopButton()?.click?.(); return true; } catch { return false; } }

  identity(node) {
    if (!node) return null;
    // Production traces show that ChatGPT can rewrite both the renderer's
    // conversation-turn test id and data-message-id while one logical response
    // is still alive. data-turn-id survives those re-hydrations, so it is the
    // strongest DOM-provided identity when a conversation wrapper exposes it.
    const explicit = node.getAttribute?.('data-turn-id')
      || node.getAttribute?.('data-message-id')
      || node.getAttribute?.('data-testid')
      || node.id;
    if (explicit) return String(explicit);
    if (!this.nodeIds.has(node)) this.nodeIds.set(node, `dom-turn-${this.nodeSequence++}`);
    return this.nodeIds.get(node);
  }

  text(node) {
    if (!node) return '';
    // Canonical turns are conversation wrappers, while the semantic message is
    // nested below data-message-author-role. Never read wrapper/UI chrome when a
    // message-specific content node exists: long user prompts are rendered in a
    // collapsible container whose sibling toggle contributes localized labels
    // (for example "表示を増やす" / "表示を減らす") to role.innerText.
    const role = node.getAttribute?.('data-message-author-role')
      ? node
      : node.querySelector?.('[data-message-author-role="assistant"], [data-message-author-role="user"], [data-message-author-role]');
    const scope = role || node;
    const roleName = String(role?.getAttribute?.('data-message-author-role') || '');
    const body = roleName === 'user'
      ? scope.querySelector?.('[data-testid="collapsible-user-message-content"], [data-message-content-part="user"], [data-message-content]')
      : scope.querySelector?.('.markdown, [data-testid="markdown"], [data-message-content-part="assistant"], [data-message-content]');
    const semanticBody = body || scope;
    return String(semanticBody.innerText || semanticBody.textContent || '').trim();
  }

  assistantTurns() { return this.all('assistantTurn').map((node) => ({ node, id: this.identity(node), text: this.text(node) })); }
  userTurns() { return this.all('userTurn').map((node) => ({ node, id: this.identity(node), text: this.text(node) })); }
  conversationTurns() { return this.all('conversationTurn').map((node) => ({ node, id: this.identity(node), text: this.text(node) })); }

  conversation() {
    const href = String(this.location?.href || '');
    let url = null;
    try { url = new URL(href || '/', 'https://chatgpt.com'); } catch { return null; }
    const match = CONVERSATION_PATH.exec(url.pathname);
    if (!match) return null;
    return { id: match[1], url: `${url.origin}/c/${match[1]}` };
  }

  /*
   * A conversation keeps every historical turn in the DOM, including turns that
   * failed long before the current Hex request. Reading a document-wide error
   * marker therefore lets a stale failure abort an unrelated, healthy turn. When
   * the caller knows which turns belong to the in-flight request it passes them
   * here, and only markers inside those turns are authoritative.
   */
  errorState(scopeNodes = null) {
    for (const node of scopeNodes ? this.errorNodesWithin(scopeNodes) : this.all('error')) {
      const text = this.text(node);
      if (text && /error|failed|try again|something went wrong|エラー|失敗|再試行/i.test(text)) return text.slice(0, 1000);
    }
    return null;
  }

  errorNodesWithin(scopeNodes) {
    const seen = new Set(), out = [];
    for (const root of scopeNodes || []) {
      if (!root) continue;
      for (const selector of this.selectors.error || []) {
        let values = [];
        try { values = root.querySelectorAll?.(selector) || []; } catch { values = []; }
        for (const node of values) if (!seen.has(node)) { seen.add(node); out.push(node); }
        try { if (root.matches?.(selector) && !seen.has(root)) { seen.add(root); out.push(root); } } catch { /* selector unsupported */ }
      }
    }
    return out;
  }

  currentSelection() {
    const texts = [];
    for (const kind of ['currentModel', 'reasoningControl', 'selectedOption']) {
      for (const node of this.all(kind)) {
        const value = this.text(node) || node.getAttribute?.('aria-label') || '';
        if (value) texts.push(value);
      }
    }
    const combined = texts.join(' · ');
    return {
      model: normalizeModel(combined)?.id || null,
      reasoning: normalizeReasoning(combined)?.id || null,
      observedText: combined,
    };
  }

  async visibleOptions() {
    const nodes = this.all('modelOption').filter((node) => isVisible(node));
    return nodes.map((node) => {
      const label = this.text(node) || node.getAttribute?.('aria-label') || '';
      return { node, label, model: normalizeModel(label)?.id || null, reasoning: normalizeReasoning(label)?.id || null };
    }).filter((item) => item.label);
  }

  setComposerText(node, value) {
    if (!node) throw bridgeError('dom-adapter', 'composer-not-found', 'ChatGPT composer was not found.');
    node.focus?.();
    if ('value' in node && typeof node.value === 'string') {
      const proto = node.tagName === 'TEXTAREA' ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      if (setter) setter.call(node, value); else node.value = value;
    } else {
      let inserted = false;
      try {
        const selection = globalThis.getSelection?.();
        const range = this.document?.createRange?.();
        range?.selectNodeContents?.(node); selection?.removeAllRanges?.(); if (range) selection?.addRange?.(range);
        inserted = !!this.document?.execCommand?.('insertText', false, value);
        selection?.removeAllRanges?.();
      } catch { inserted = false; }
      if (!inserted) node.textContent = value;
    }
    const InputEventCtor = globalThis.InputEvent || globalThis.Event;
    node.dispatchEvent?.(new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: value }));
    node.dispatchEvent?.(new Event('change', { bubbles: true }));
  }

  composerText(node) { return String(node?.value ?? node?.innerText ?? node?.textContent ?? ''); }

  observeMutations(node, callback) {
    const Observer = globalThis.MutationObserver;
    if (!node || typeof Observer !== 'function') return () => {};
    const observer = new Observer(() => callback?.());
    observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }
}

export class ChatGPTConversationRouter {
  constructor(adapter, { storage = globalThis.localStorage, storageKey = 'hex.chatgpt.conversations.v1', navigationTimeoutMs = 12000 } = {}) {
    this.adapter = adapter;
    this.storage = storage || null;
    this.storageKey = storageKey;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.bindings = new Map();
    this.load();
  }

  load() {
    try {
      const values = JSON.parse(this.storage?.getItem?.(this.storageKey) || '{}');
      for (const [key, value] of Object.entries(values || {})) if (validConversation(value)) this.bindings.set(key, value);
    } catch { /* corrupt local routing state is ignored */ }
  }

  persist() {
    try { this.storage?.setItem?.(this.storageKey, JSON.stringify(Object.fromEntries(this.bindings))); } catch { /* optional */ }
  }

  binding(sessionKey) { return this.bindings.get(String(sessionKey || '')) || null; }

  bind(sessionKey, conversation) {
    if (!sessionKey || !validConversation(conversation)) return null;
    const value = { id: String(conversation.id), url: String(conversation.url) };
    this.bindings.set(String(sessionKey), value); this.persist(); return value;
  }

  async route(sessionKey, { signal, timeoutMs = this.navigationTimeoutMs } = {}) {
    const key = String(sessionKey || '').trim();
    if (!key) throw bridgeError('conversation-router', 'session-required', 'A Hex/AIRuntime session key is required.');
    const known = this.binding(key);
    const current = this.adapter.conversation();
    if (known && current?.id === known.id) return { conversation: current, isNew: false };
    if (known) {
      const link = this.findConversationLink(known);
      if (link) link.click();
      else throw bridgeError('conversation-router', 'conversation-unreachable', 'The bound ChatGPT conversation is not present in the visible ChatGPT history.', { sessionKey: key, conversation: known });
      const reached = await waitFor(() => {
        const value = this.adapter.conversation();
        return value?.id === known.id ? value : null;
      }, timeoutMs, signal);
      if (!reached) throw bridgeError('conversation-router', 'conversation-mismatch', 'ChatGPT did not switch to the conversation bound to this Hex session.', { expected: known });
      return { conversation: reached, isNew: false };
    }

    // ChatGPT changes /c/<id> -> / before it removes the old turn DOM.
    // If Hex starts the next request in that gap, the old conversation becomes
    // the new request's baseline. Wait until every previously visible logical
    // turn is gone; an already-empty home page still resolves immediately.
    const priorTurns = conversationTurnIds(this.adapter);
    const fresh = this.adapter.newChatButton();
    if (fresh) fresh.click();
    else throw bridgeError('conversation-router', 'new-chat-unavailable', 'ChatGPT New Chat control was not found.');
    const ready = await waitFor(() => {
      if (this.adapter.conversation()) return null;
      const composer = this.adapter.composer();
      if (!composer) return null;
      return priorTurnsCleared(this.adapter, priorTurns) ? composer : null;
    }, timeoutMs, signal);
    if (!ready) throw bridgeError('conversation-router', 'new-chat-timeout', 'ChatGPT did not open a new conversation.');
    return { conversation: null, isNew: true };
  }

  findConversationLink(conversation) {
    for (const node of this.adapter.all('conversationLink')) {
      const href = String(node.getAttribute?.('href') || '');
      if (href === `/c/${conversation.id}` || href.includes(`/c/${conversation.id}`)) return node;
    }
    return null;
  }
}

export class ChatGPTModelController {
  constructor(adapter, { settleMs = 350 } = {}) { this.adapter = adapter; this.settleMs = settleMs; }

  async capabilities({ signal } = {}) {
    const current = this.adapter.currentSelection();
    const modelOptions = await this.discoverOptions({ signal, close: true, kind: 'model' });
    const reasoningOptions = await this.discoverOptions({ signal, close: true, kind: 'reasoning' });
    const options = [...modelOptions, ...reasoningOptions];
    const models = uniqueOptions(options.filter((item) => item.model).map((item) => ({ id: item.model, displayName: normalizeModel(item.label)?.label || item.label })));
    const reasoning = uniqueOptions(options.filter((item) => item.reasoning).map((item) => ({ id: item.reasoning, displayName: normalizeReasoning(item.label)?.label || item.label })));
    if (current.model && !models.some((item) => item.id === current.model)) models.push({ id: current.model, displayName: normalizeModel(current.observedText)?.label || current.observedText, current: true });
    if (current.reasoning && !reasoning.some((item) => item.id === current.reasoning)) reasoning.push({ id: current.reasoning, displayName: normalizeReasoning(current.observedText)?.label || current.observedText, current: true });
    return { models, reasoning, current };
  }

  async select({ model = null, reasoning = null } = {}, { signal } = {}) {
    if (!model && !reasoning) return this.adapter.currentSelection();
    if (model) await this.selectOne('model', model, signal);
    if (reasoning) await this.selectOne('reasoning', reasoning, signal);
    await delay(this.settleMs, signal);
    const observed = this.adapter.currentSelection();
    if (model && observed.model !== model) throw bridgeError('model-controller', 'model-mismatch', `Requested model ${model} could not be verified in the ChatGPT UI.`, { requested: model, observed });
    if (reasoning && observed.reasoning !== reasoning) throw bridgeError('model-controller', 'reasoning-mismatch', `Requested reasoning ${reasoning} could not be verified in the ChatGPT UI.`, { requested: reasoning, observed });
    return observed;
  }

  async selectOne(kind, requested, signal) {
    const current = this.adapter.currentSelection();
    if (current[kind] === requested) return;
    const options = await this.discoverOptions({ signal, close: false, kind });
    const target = options.find((item) => item[kind] === requested);
    if (!target) throw bridgeError('model-controller', `${kind}-unavailable`, `Requested ${kind} ${requested} is not present in the visible ChatGPT picker.`, { available: uniqueOptions(options.filter((item) => item[kind]).map((item) => ({ id: item[kind], displayName: item.label }))) });
    target.node.click();
    await delay(this.settleMs, signal);
  }

  async discoverOptions({ signal, close = false, kind = 'model' } = {}) {
    let options = await this.adapter.visibleOptions();
    if (!options.length) {
      const opener = kind === 'reasoning'
        ? (this.adapter.reasoningControl() || this.adapter.modelPicker())
        : (this.adapter.modelPicker() || this.adapter.reasoningControl());
      if (!opener) return [];
      opener.click();
      options = await waitFor(async () => {
        const values = await this.adapter.visibleOptions();
        return values.length ? values : null;
      }, 3000, signal) || [];
    }
    if (close && options.length) {
      try { this.adapter.document?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch { /* optional */ }
    }
    return options;
  }
}

export class ChatGPTTurnController {
  constructor(adapter, { quietMs = 1500, pollMs = 120, startTimeoutMs = 10000, conversationGraceMs = 3000 } = {}) {
    this.adapter = adapter;
    this.quietMs = quietMs;
    this.pollMs = pollMs;
    this.startTimeoutMs = startTimeoutMs;
    this.conversationGraceMs = conversationGraceMs;
  }

  async run(prompt, { signal, timeoutMs = 110000, expectedConversation = null, newConversation = expectedConversation === null, onConversation } = {}) {
    const started = Date.now();
    const normalizedPrompt = normalizeText(prompt);
    const composer = await waitFor(() => this.adapter.composer(), Math.min(timeoutMs, this.startTimeoutMs), signal);
    if (!composer) throw bridgeError('turn-controller', 'composer-not-found', 'ChatGPT composer was not found.');
    if (this.adapter.isGenerating()) throw bridgeError('turn-controller', 'already-generating', 'ChatGPT is already generating a response.');

    const baselineAssistant = new Set(this.assistantTurns().map((turn) => turn.id));
    const baselineUsers = new Set(this.userTurns().map((turn) => turn.id));
    const baselineConversation = new Set(this.conversationTurns().map((turn) => turn.id));
    this.adapter.setComposerText(composer, prompt);
    const send = await waitFor(() => {
      const node = this.adapter.sendButton();
      return node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' ? node : null;
    }, Math.min(this.startTimeoutMs, remaining(started, timeoutMs)), signal);
    if (!send) throw bridgeError('turn-controller', 'send-unavailable', 'ChatGPT send button did not become available.');
    send.click();

    let requestUserTurn = null;
    const submitted = await waitFor(() => {
      const explicit = this.userTurns().filter((turn) => !baselineUsers.has(turn.id));
      if (explicit.length > 1) throw bridgeError('turn-controller', 'manual-interference', 'Another user turn appeared while Hex was submitting its request.');
      if (explicit.length === 1) {
        if (normalizeText(explicit[0].text) !== normalizedPrompt) throw bridgeError('turn-controller', 'manual-interference', 'The submitted ChatGPT turn does not match the Hex request.');
        requestUserTurn = explicit[0];
        return true;
      }

      // Some ChatGPT builds temporarily omit data-message-author-role while
      // retaining conversation-turn test ids. Accept only an exact prompt match.
      const generic = this.conversationTurns().filter((turn) => !baselineConversation.has(turn.id) && normalizeText(turn.text) === normalizedPrompt);
      if (generic.length > 1) throw bridgeError('turn-controller', 'manual-interference', 'Multiple matching user turns appeared while Hex was submitting its request.');
      if (generic.length === 1) {
        requestUserTurn = generic[0];
        return true;
      }
      return false;
    }, Math.min(this.startTimeoutMs, remaining(started, timeoutMs)), signal);
    if (!submitted || !requestUserTurn) throw bridgeError('turn-controller', 'submission-unverified', 'The ChatGPT user turn could not be matched to the Hex request.');

    let latest = '', latestId = null, lastChangedAt = Date.now(), sawGenerating = this.adapter.isGenerating(), observedConversation = expectedConversation;
    let missingConversationSince = null, bootstrapMigrated = false;
    let stopObserving = NOOP;
    try {
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) throw abortError(signal.reason);

        // Read one logical snapshot before judging navigation. The production
        // lifecycle proves that a brand-new chat can move provisional CID A ->
        // final CID B while the same user turn and data-turn-id stay alive. A
        // real navigation replaces that request turn instead.
        const conversationTurns = this.conversationTurns();
        const userTurns = this.userTurns();
        const freshUsers = userTurns.filter((turn) => !baselineUsers.has(turn.id));
        const requestPresent = requestTurnIsPresent(requestUserTurn, userTurns, conversationTurns, normalizedPrompt);
        const conversation = this.adapter.conversation();

        if (conversation) {
          missingConversationSince = null;
          if (!observedConversation) {
            observedConversation = conversation;
            onConversation?.(conversation);
          } else if (conversation.id !== observedConversation.id) {
            // Existing sessions keep strict conversation isolation. Only a
            // request that started from New Chat may migrate its provisional CID,
            // and only while the exact submitted user turn is still present and
            // no competing user turn appeared.
            if (!newConversation || !this.adapter.isGenerating() || !requestPresent || freshUsers.length !== 1) {
              throw bridgeError('turn-controller', 'conversation-switched', 'ChatGPT conversation changed while a Hex request was in flight.', { expected: observedConversation, actual: conversation });
            }
            observedConversation = conversation;
            bootstrapMigrated = true;
            onConversation?.(conversation);
          }
        } else if (observedConversation) {
          if (missingConversationSince === null) missingConversationSince = Date.now();
          if (Date.now() - missingConversationSince >= this.conversationGraceMs) {
            throw bridgeError('turn-controller', 'conversation-switched', 'ChatGPT conversation disappeared while a Hex request was in flight.', { expected: observedConversation });
          }
        }

        // If a provisional CID was accepted and the request turn then disappears,
        // this was navigation to another conversation, not bootstrap migration.
        if (bootstrapMigrated && !requestPresent) {
          throw bridgeError('turn-controller', 'conversation-switched', 'ChatGPT left the Hex request after a new-conversation identity migration.', { expected: observedConversation });
        }
        if (freshUsers.length > 1) {
          throw bridgeError('turn-controller', 'manual-interference', 'Another user turn appeared while one Hex request was in flight.');
        }

        // Scope error detection to the turns this request created. Fall back to
        // the unscoped read when no turn node is known, so a build whose turn
        // wrappers Hex cannot resolve loses no error detection at all.
        const activeNodes = conversationTurns
          .filter((turn) => !baselineConversation.has(turn.id))
          .map((turn) => turn.node)
          .filter(Boolean);
        if (!activeNodes.length && requestUserTurn?.node) activeNodes.push(requestUserTurn.node);
        const error = this.adapter.errorState(activeNodes.length ? activeNodes : null);
        if (error) throw bridgeError('turn-controller', 'response-error', 'ChatGPT reported an error while generating the Hex turn.', { error });
        if (this.adapter.isGenerating()) sawGenerating = true;

        const explicit = this.assistantTurns().filter((turn) => !baselineAssistant.has(turn.id));
        if (explicit.length > 1) throw bridgeError('turn-controller', 'manual-interference', 'Multiple assistant turns appeared while one Hex request was in flight.');
        const turn = explicit[0] || this.fallbackResponseTurn({ baselineConversation, baselineUsers, requestUserTurn, normalizedPrompt });
        if (turn) {
          if (latestId && turn.id !== latestId) throw bridgeError('turn-controller', 'stale-response', 'The assistant turn identity changed before the Hex response settled.');
          latestId = turn.id;
          if (turn.node && stopObserving === NOOP) stopObserving = this.adapter.observeMutations?.(turn.node, () => { lastChangedAt = Date.now(); }) || NOOP;
          if (turn.text !== latest) { latest = turn.text; lastChangedAt = Date.now(); }

          const settledFor = Date.now() - lastChangedAt;
          const settled = latest.trim() && !this.adapter.isGenerating() && settledFor >= this.quietMs && (sawGenerating || requestUserTurn);
          if (settled) {
            // A known conversation that temporarily reads as null is not safe to
            // finalize. A short SPA gap will recover; a real New Chat navigation
            // is rejected above after conversationGraceMs.
            if (observedConversation && !conversation) {
              await delay(this.pollMs, signal);
              continue;
            }
            const identity = conversation || observedConversation;
            if (identity || settledFor >= Math.max(this.quietMs, this.conversationGraceMs)) {
              return { text: latest.trim(), conversation: identity || null, turnId: turn.id };
            }
          }
        }
        await delay(this.pollMs, signal);
      }
      throw bridgeError('turn-controller', 'timeout', 'ChatGPT response capture timed out.', {
        sawResponseText: !!latest.trim(), responseTurnId: latestId, sawGenerating, conversation: observedConversation || null,
      });
    } finally { stopObserving(); }
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

  assistantTurns() { return canonicalTurns(this.adapter, this.adapter.assistantTurns?.() || []); }
  userTurns() { return canonicalTurns(this.adapter, this.adapter.userTurns?.() || []); }
  conversationTurns() {
    if (typeof this.adapter.conversationTurns === 'function') return canonicalTurns(this.adapter, this.adapter.conversationTurns() || []);
    if (typeof this.adapter.all !== 'function') return [];
    return canonicalTurns(this.adapter, (this.adapter.all('conversationTurn') || []).map((node) => ({
      node, id: this.adapter.identity?.(node), text: this.adapter.text?.(node) || '',
    })));
  }
}

export function normalizeModel(label) {
  const value = String(label || '');
  return MODEL_PATTERNS.find((item) => item.pattern.test(value)) || null;
}

export function normalizeReasoning(label) {
  const value = String(label || '');
  return REASONING_PATTERNS.find((item) => item.pattern.test(value) && !(item.reject?.test(value))) || null;
}

export function conversationIdentity(value) {
  try {
    const url = new URL(String(value), 'https://chatgpt.com');
    const match = CONVERSATION_PATH.exec(url.pathname);
    return match ? { id: match[1], url: `${url.origin}/c/${match[1]}` } : null;
  } catch { return null; }
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

function conversationTurnIds(adapter) {
  if (typeof adapter?.conversationTurns !== 'function') return new Set();
  return new Set((adapter.conversationTurns() || []).map((turn) => String(turn?.id || '')).filter(Boolean));
}
function priorTurnsCleared(adapter, priorTurns) {
  if (!priorTurns?.size) return true;
  const current = conversationTurnIds(adapter);
  for (const id of priorTurns) if (current.has(id)) return false;
  return true;
}
function requestTurnIsPresent(request, userTurns, conversationTurns, normalizedPrompt) {
  if (!request) return false;
  const matches = (turn) => {
    if (!turn) return false;
    const sameIdentity = turn.id === request.id || (!!turn.node && !!request.node && turn.node === request.node);
    return sameIdentity && normalizeText(turn.text) === normalizedPrompt;
  };
  return (userTurns || []).some(matches) || (conversationTurns || []).some(matches);
}
function bridgeError(stage, code, message, details = null) { return new ChatGPTBridgeError(code, message, details, stage); }
function validConversation(value) { return !!value && typeof value.id === 'string' && conversationIdentity(value.url)?.id === value.id; }
function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function uniqueOptions(values) { return [...new Map(values.map((item) => [item.id, item])).values()]; }
function isVisible(node) { return !node?.hidden && node?.getAttribute?.('aria-hidden') !== 'true' && node?.getAttribute?.('disabled') == null; }
function remaining(started, timeoutMs) { return Math.max(1, timeoutMs - (Date.now() - started)); }
const NOOP = () => {};

export function waitFor(probe, timeoutMs, signal) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (signal?.aborted) { reject(abortError(signal.reason)); return; }
      try { const value = await probe(); if (value) { resolve(value); return; } } catch (error) { reject(error); return; }
      if (Date.now() >= deadline) { resolve(null); return; }
      setTimeout(check, 80);
    };
    check();
  });
}

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