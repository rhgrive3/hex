import { AIError } from '../schema.js';
import { requestJSON } from '../transport.js';
import { validateModelDecision } from '../validation.js';
import { SAFE_PROVIDER_CAPABILITIES } from '../budget/wire.js';

export class AIProvider {
  constructor({ capabilities } = {}) { this.capabilities = { ...SAFE_PROVIDER_CAPABILITIES, ...(capabilities || {}) }; }
  getCapabilities() { return { ...this.capabilities }; }
  async nextTurn() { throw new AIError('provider_error', 'AIProvider.nextTurn is not implemented.'); }
  async streamTurn() { throw new AIError('provider_error', 'Streaming is not implemented by this provider.'); }
  cancel() {}
}

export class WorkerAIProvider extends AIProvider {
  constructor({ endpoint = '/api/ai/turn', fetchImpl = globalThis.fetch, timeoutMs = 110000, capabilities = {} } = {}) {
    super({ capabilities: { provider: 'worker', contextTokens: 32768, maxOutputTokens: 8192, maxTools: 10, maxRequestBytes: 150 * 1024, ...capabilities } });
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.controllers = new Set();
  }

  async nextTurn(request, options = {}) {
    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason || 'cancelled');
    if (options.signal) { options.signal.addEventListener('abort', onAbort, { once: true }); if (options.signal.aborted) onAbort(); }
    this.controllers.add(controller);
    try {
      if (controller.signal.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
      const response = await requestJSON(this.endpoint, {
        sessionId: request.sessionId || null,
        mode: request.mode,
        style: request.style,
        scope: request.effectiveScope || request.scope,
        requestedScope: request.requestedScope || request.scope,
        effectiveScope: request.effectiveScope || request.scope,
        intent: request.intent || null,
        task: request.task || null,
        messages: request.messages || [],
        context: request.context || {},
        tools: request.tools || [],
        responseSchema: request.responseSchema || null,
      }, { signal: controller.signal, timeoutMs: options.timeoutMs || this.timeoutMs, fetchImpl: this.fetchImpl });
      if (response.capabilities && typeof response.capabilities === 'object') this.capabilities = { ...this.capabilities, ...response.capabilities };
      return validateModelDecision(response.decision, (request.tools || []).map((tool) => tool.name));
    } finally {
      this.controllers.delete(controller);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  cancel() { for (const controller of this.controllers) controller.abort('cancelled'); this.controllers.clear(); }
}
