import { resolveInferenceAdapter } from './js/ai/provider/worker-adapters.js';
import { handleAITurn } from './js/ai/provider/worker-turn.js';
import { handleGemini } from './js/ai/provider/worker-legacy.js';
import { normalizeAITurnRequest, normalizeAIInteraction, normalizeRequest } from './js/ai/provider/worker-protocol.js';
import {
  acquireDistributedQuota, isRetryableUpstreamFailure, jsonError, parseRetryAfterMs,
  quotaClientKey, quotaSessionId, readLimitedText, releaseDistributedQuota, retryDelayMs,
} from './js/ai/provider/worker-transport.js';

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai/turn') return handleAITurn(request, env);
    if (url.pathname === '/api/gemini') return handleGemini(request, env, executionCtx);
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      return jsonError(500, 'static_assets_unavailable', 'Static assets binding is unavailable.');
    }
    return env.ASSETS.fetch(request);
  },
};

export const __test = {
  normalizeRequest, normalizeAITurnRequest, normalizeAIInteraction, readLimitedText,
  isRetryableUpstreamFailure, retryDelayMs, parseRetryAfterMs,
  acquireDistributedQuota, releaseDistributedQuota, quotaClientKey, quotaSessionId,
  resolveInferenceAdapter,
};
