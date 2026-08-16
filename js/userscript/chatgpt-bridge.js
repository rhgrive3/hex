import {
  ChatGPTBridgeError, ChatGPTDOMAdapter, ChatGPTConversationRouter, ChatGPTModelController,
  ChatGPTTurnController,
} from './chatgpt-adapter.js';

export function installChatGPTWebBridge(options = {}) {
  const existing = globalThis.__HEX_CHATGPT_BRIDGE__;
  if (existing && typeof existing.request === 'function') return existing;

  const adapter = options.adapter || new ChatGPTDOMAdapter(options);
  const router = options.router || new ChatGPTConversationRouter(adapter, options);
  const models = options.models || new ChatGPTModelController(adapter, options);
  const turns = options.turns || new ChatGPTTurnController(adapter, options);
  let active = null;

  const bridge = {
    async request(prompt, requestOptions = {}) {
      if (active) throw new ChatGPTBridgeError('already-active', 'ChatGPT Web is already handling another Hex turn.', null, 'bridge');
      const controller = new AbortController();
      const externalSignal = requestOptions.signal;
      const onExternalAbort = () => controller.abort(externalSignal?.reason || 'cancelled');
      externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
      if (externalSignal?.aborted) onExternalAbort();
      active = { controller, sessionKey: requestOptions.sessionKey || null };
      try {
        const routed = await router.route(requestOptions.sessionKey, { signal: controller.signal });
        const selection = await models.select({ model: requestOptions.model, reasoning: requestOptions.reasoning }, { signal: controller.signal });
        const result = await turns.run(String(prompt || ''), {
          signal: controller.signal,
          timeoutMs: explicitTimeout(requestOptions.timeoutMs ?? options.timeoutMs) ?? Infinity,
          expectedConversation: routed.conversation,
          newConversation: routed.isNew === true,
        });
        // New Chat can expose a provisional /c/<id> and replace it while the
        // same logical request is generating. Never persist that intermediate
        // identity; bind only the settled conversation returned by the turn.
        const bound = result.conversation
          ? router.bind(requestOptions.sessionKey, result.conversation)
          : routed.conversation;
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

function explicitTimeout(value) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}
