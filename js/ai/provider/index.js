import { AIError } from '../schema.js';
import { requestJSON } from '../transport.js';
import { validateModelDecision } from '../validation.js';

export class AIProvider {
  async nextTurn() { throw new AIError('provider_error', 'AIProvider.nextTurn is not implemented.'); }
  async streamTurn() { throw new AIError('provider_error', 'Streaming is not implemented by this provider.'); }
  cancel() {}
}

export class WorkerAIProvider extends AIProvider {
  constructor({ endpoint = '/api/ai/turn', fetchImpl = globalThis.fetch, timeoutMs = 110000 } = {}) {
    super();
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.controllers = new Set();
  }

  async nextTurn(request, options = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal.reason || 'cancelled');
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    this.controllers.add(controller);
    try {
      const response = await requestJSON(this.endpoint, {
        sessionId: request.sessionId || null,
        mode: request.mode,
        style: request.style,
        scope: request.scope,
        messages: request.messages || [],
        context: request.context || {},
        tools: request.tools || [],
        responseSchema: request.responseSchema || null,
      }, { signal: controller.signal, timeoutMs: options.timeoutMs || this.timeoutMs, fetchImpl: this.fetchImpl });
      return validateModelDecision(response.decision, (request.tools || []).map((tool) => tool.name));
    } finally {
      this.controllers.delete(controller);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  cancel() {
    for (const controller of this.controllers) controller.abort('cancelled');
    this.controllers.clear();
  }
}
