import {
  ChatGPTDOMAdapter, ChatGPTConversationRouter, ChatGPTModelController,
  ChatGPTTurnController,
} from './chatgpt-adapter.js';

const DEFAULT_TIMEOUT_MS = 110000;

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
      if (active) throw new Error('ChatGPT Web is already handling another Hex turn.');
      const controller = new AbortController();
      const externalSignal = requestOptions.signal;
      const onExternalAbort = () => controller.abort(externalSignal?.reason || 'cancelled');
      externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
      if (externalSignal?.aborted) onExternalAbort();
      active = { controller, sessionKey: requestOptions.sessionKey || null };
      try {
        const routed = await router.route(requestOptions.sessionKey, { signal: controller.signal });
        const selection = await models.select({ model: requestOptions.model, reasoning: requestOptions.reasoning }, { signal: controller.signal });
        let bound = routed.conversation;
        const result = await turns.run(String(prompt || ''), {
          signal: controller.signal,
          timeoutMs: requestOptions.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS,
          expectedConversation: routed.conversation,
          onConversation: (conversation) => { bound = router.bind(requestOptions.sessionKey, conversation); },
        });
        bound = result.conversation ? router.bind(requestOptions.sessionKey, result.conversation) : bound;
        return { text: result.text, conversation: bound, selection, turnId: result.turnId };
      } finally {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
        if (active?.controller === controller) active = null;
      }
    },

    cancel() { if (active) { active.controller.abort('cancelled'); adapter.stop(); } },
    async capabilities(requestOptions = {}) {
      const discovered = await models.capabilities(requestOptions);
      return { provider: 'chatgpt-web', maxConcurrentRequests: 1, conversationRouting: true, ...discovered };
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
