import {
  ChatGPTBridgeError, ChatGPTDOMAdapter, ChatGPTConversationRouter, ChatGPTModelController,
  ChatGPTTurnController, waitFor,
} from './chatgpt-adapter.js';

const LATE_BINDING_LIMIT = 32;
const DEFAULT_LATE_BINDING_WAIT_MS = 2500;
const DEV_SUPERVISOR_PROMPT_PREFIX = 'HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1';

export function installChatGPTWebBridge(options = {}) {
  const existing = globalThis.__HEX_CHATGPT_BRIDGE__;
  if (existing && typeof existing.request === 'function') return existing;

  const adapter = options.adapter || new ChatGPTDOMAdapter(options);
  // ChatGPT page-origin Web Storage is writable by the page we are isolating
  // from the protected Hex runtime. It must not be an authority for mapping a
  // Hex session to a ChatGPT conversation. Trusted hosts/tests can still opt in
  // to persistence by explicitly injecting a storage implementation.
  const routerOptions = Object.prototype.hasOwnProperty.call(options, 'storage')
    ? options
    : { ...options, storage: null };
  const router = options.router || new ChatGPTConversationRouter(adapter, routerOptions);
  const models = options.models || new ChatGPTModelController(adapter, options);
  const turns = options.turns || new ChatGPTTurnController(adapter, options);
  const lateBindings = new Map();
  const lateBindingWaitMs = positiveMs(options.lateBindingWaitMs, DEFAULT_LATE_BINDING_WAIT_MS);
  let active = null;

  const bridge = {
    async request(prompt, requestOptions = {}) {
      if (active) throw new ChatGPTBridgeError('already-active', 'ChatGPT Web is already handling another Hex turn.', null, 'bridge');
      const controller = new AbortController();
      const externalSignal = requestOptions.signal;
      const onExternalAbort = () => controller.abort(externalSignal?.reason ?? 'cancelled');
      externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
      if (externalSignal?.aborted) onExternalAbort();
      const sessionKey = String(requestOptions.sessionKey || '').trim();
      active = { controller, sessionKey: requestOptions.sessionKey || null };
      try {
        const recovered = await adoptLateBinding({
          adapter, router, lateBindings, sessionKey, signal: controller.signal, waitMs: lateBindingWaitMs,
        });
        // If the exact prior Supervisor assistant turn is still present but
        // ChatGPT has not exposed a /c/<id> yet, the current unbound surface is
        // already proven to be this same logical session. Do not click New Chat
        // merely because the SPA route identity is late. Continue on that surface
        // and keep trying to bind a concrete identity after this turn settles.
        const routed = recovered?.reuseCurrentSurface
          ? { conversation: null, isNew: true }
          : await router.route(requestOptions.sessionKey, { signal: controller.signal });
        const selection = await models.select({ model: requestOptions.model, reasoning: requestOptions.reasoning }, { signal: controller.signal });
        const requestPrompt = String(prompt || '');
        const result = await turns.run(requestPrompt, {
          signal: controller.signal,
          // Leave timeout undefined when the caller did not set one so the
          // TurnController's 110 s bound beats the outer 120 s embed RPC.
          timeoutMs: explicitTimeout(requestOptions.timeoutMs ?? options.timeoutMs) ?? undefined,
          expectedConversation: routed.conversation,
          newConversation: routed.isNew === true,
          completionMode: requestPrompt.startsWith(DEV_SUPERVISOR_PROMPT_PREFIX)
            ? 'single-json-object'
            : null,
        });
        // New Chat can expose its settled /c/<id> slightly after the assistant
        // response itself has become quiet. If we return before that route
        // identity appears, the next request for the same logical session must
        // not be mistaken for another New Chat. First wait briefly for the late
        // identity; if it still is not visible, retain only the previous turn id
        // in trusted in-memory state so the next same-session request can safely
        // recover only from that exact prior turn.
        const bound = await settleConversationBinding({
          adapter,
          router,
          lateBindings,
          sessionKey,
          result,
          routedConversation: routed.conversation,
          signal: controller.signal,
          waitMs: lateBindingWaitMs,
        });
        return { text: result.text, conversation: bound, selection, turnId: result.turnId };
      } finally {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
        if (active?.controller === controller) active = null;
      }
    },

    cancel() { if (active) { active.controller.abort('cancelled'); adapter.stop(); } },
    async capabilities() {
      // Capability/status polling runs during Hex startup and must be read-only.
      // Opening ChatGPT's model menu here can take longer than the parent RPC
      // capability deadline and can race a real turn. Enumerate only the
      // selection already visible in the page; explicit setSelection() remains
      // responsible for opening the picker when the user asks to change it.
      const current = adapter.currentSelection();
      const modelList = current.model
        ? [{ id: current.model, displayName: current.model, current: true }]
        : [];
      const reasoning = current.reasoning
        ? [{ id: current.reasoning, displayName: current.reasoning, current: true }]
        : [];
      return {
        provider: 'chatgpt-web',
        ready: !!adapter.composer(),
        maxConcurrentRequests: 1,
        conversationRouting: true,
        models: modelList,
        reasoning,
        current,
      };
    },
    getSelection() { return adapter.currentSelection(); },
    setSelection(selection, requestOptions = {}) { return models.select(selection, requestOptions); },
    status() {
      return {
        ready: !!adapter.composer(), busy: !!active, host: adapter.location?.hostname || null,
        generating: adapter.isGenerating(), conversation: adapter.conversation(), selection: adapter.currentSelection(),
        error: adapter.errorState(),
      };
    },
    conversationFor(sessionKey) { return router.binding(sessionKey); },
  };

  globalThis.__HEX_CHATGPT_BRIDGE__ = bridge;
  return bridge;
}

export default installChatGPTWebBridge;

async function settleConversationBinding({ adapter, router, lateBindings, sessionKey, result, routedConversation, signal, waitMs }) {
  if (!sessionKey) return result.conversation || routedConversation || null;
  if (result.conversation) {
    lateBindings.delete(sessionKey);
    return router.bind(sessionKey, result.conversation) || result.conversation;
  }
  if (routedConversation) {
    lateBindings.delete(sessionKey);
    return router.bind(sessionKey, routedConversation) || routedConversation;
  }

  const turnId = String(result.turnId || '').trim();
  if (!turnId) return null;
  const late = await waitFor(() => matchingCurrentConversation(adapter, turnId), waitMs, signal);
  if (late) {
    lateBindings.delete(sessionKey);
    return router.bind(sessionKey, late) || late;
  }
  rememberLateBinding(lateBindings, sessionKey, turnId);
  return null;
}

async function adoptLateBinding({ adapter, router, lateBindings, sessionKey, signal, waitMs }) {
  if (!sessionKey || router.binding(sessionKey)) {
    lateBindings.delete(sessionKey);
    return null;
  }
  const pending = lateBindings.get(sessionKey);
  if (!pending?.turnId) return null;
  const conversation = await waitFor(
    () => matchingCurrentConversation(adapter, pending.turnId),
    Math.min(waitMs, 1500),
    signal,
  );
  if (conversation) {
    const bound = router.bind(sessionKey, conversation) || conversation;
    lateBindings.delete(sessionKey);
    return Object.freeze({ conversation: bound, reuseCurrentSurface: false });
  }
  if (!adapter.conversation?.() && turnIdentityPresent(adapter, pending.turnId)) {
    return Object.freeze({ conversation: null, reuseCurrentSurface: true });
  }
  return null;
}

function matchingCurrentConversation(adapter, turnId) {
  const current = adapter.conversation?.() || null;
  if (!current?.id || !current?.url) return null;
  return turnIdentityPresent(adapter, turnId) ? current : null;
}

function turnIdentityPresent(adapter, turnId) {
  const wanted = String(turnId || '');
  if (!wanted) return false;
  for (const method of ['assistantTurns', 'conversationTurns']) {
    let turns = [];
    try { turns = adapter?.[method]?.() || []; } catch { turns = []; }
    if (turns.some((turn) => String(turn?.id || '') === wanted)) return true;
  }
  return false;
}

function rememberLateBinding(map, sessionKey, turnId) {
  map.delete(sessionKey);
  map.set(sessionKey, Object.freeze({ turnId: String(turnId) }));
  while (map.size > LATE_BINDING_LIMIT) map.delete(map.keys().next().value);
}

function explicitTimeout(value) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

function positiveMs(value, fallback) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
