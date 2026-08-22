import { AIError } from '../schema.js';
import { requestJSON } from '../transport.js';
import { validateModelDecision } from '../validation.js';
import { SAFE_PROVIDER_CAPABILITIES } from '../budget/wire.js';

export class AIProvider {
  constructor({ capabilities } = {}) { this.capabilities = { ...SAFE_PROVIDER_CAPABILITIES, ...(capabilities || {}) }; }
  getCapabilities() { return { ...this.capabilities }; }
  turnTimeoutMs(mode) { return mode === 'agent' ? 120000 : 30000; }
  async prepareCapabilities() { return this.getCapabilities(); }
  async nextTurn() { throw new AIError('provider_error', 'AIProvider.nextTurn is not implemented.'); }
  async streamTurn() { throw new AIError('provider_error', 'Streaming is not implemented by this provider.'); }
  cancel() {}
}

export class WorkerAIProvider extends AIProvider {
  constructor({ endpoint = '/api/ai/turn', capabilitiesEndpoint = null, fetchImpl = globalThis.fetch, timeoutMs = 110000, capabilities = {} } = {}) {
    // Before the first Worker response reveals the selected inference adapter,
    // use the conservative envelope-safe limit. A quota-free preflight normally
    // replaces this with the server-derived provider-aware limit before turn 1.
    super({ capabilities: { provider: 'worker', contextTokens: 32768, maxOutputTokens: 8192, maxTools: 10, maxRequestBytes: 64 * 1024, ...capabilities } });
    this.endpoint = endpoint;
    this.capabilitiesEndpoint = capabilitiesEndpoint || deriveCapabilitiesEndpoint(endpoint);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.controllers = new Set();
    this.capabilitiesPrepared = false;
    this.capabilitiesPromise = null;
  }

  async prepareCapabilities(options = {}) {
    if (this.capabilitiesPrepared) return this.getCapabilities();
    if (this.capabilitiesPromise) return this.capabilitiesPromise;
    this.capabilitiesPromise = this.#loadCapabilities(options).finally(() => { this.capabilitiesPromise = null; });
    return this.capabilitiesPromise;
  }

  async #loadCapabilities(options = {}) {
    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    if (typeof this.fetchImpl !== 'function') { this.capabilitiesPrepared = true; return this.getCapabilities(); }
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? 'cancelled');
    const timeout = setTimeout(() => controller.abort('timeout'), Math.max(1, Math.min(Number(options.timeoutMs) || 5000, 5000)));
    if (options.signal) { options.signal.addEventListener('abort', onAbort, { once: true }); if (options.signal.aborted) onAbort(); }
    this.controllers.add(controller);
    try {
      const response = await this.fetchImpl(this.capabilitiesEndpoint, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response?.ok) { this.capabilitiesPrepared = true; return this.getCapabilities(); }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 64 * 1024) { this.capabilitiesPrepared = true; return this.getCapabilities(); }
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* conservative fallback below */ }
      if (payload?.capabilities && typeof payload.capabilities === 'object') this.capabilities = { ...this.capabilities, ...payload.capabilities };
      this.capabilitiesPrepared = true;
      return this.getCapabilities();
    } catch (error) {
      if (options.signal?.aborted || (controller.signal.aborted && controller.signal.reason !== 'timeout')) throw new AIError('cancelled', 'AI investigation was cancelled.');
      // Capability discovery must not make the provider unavailable. A failed or
      // timed-out preflight falls back to the conservative built-in budget.
      this.capabilitiesPrepared = true;
      return this.getCapabilities();
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  async nextTurn(request, options = {}) {
    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? 'cancelled');
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

function deriveCapabilitiesEndpoint(endpoint) {
  const value = String(endpoint || '/api/ai/turn');
  return value.endsWith('/turn') ? `${value.slice(0, -5)}/capabilities` : '/api/ai/capabilities';
}
