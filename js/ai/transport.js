import { AIError } from './schema.js';

export async function requestJSON(url, body, { signal, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new AIError('provider_error', 'Fetch is unavailable.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), Math.max(1, timeoutMs));
  const abort = () => controller.abort(signal.reason || 'cancelled');
  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new AIError('provider_error', 'The AI service returned invalid JSON.', { status: response.status }); }
    if (!response.ok) {
      const type = normalizeRemoteError(payload?.error?.code, response.status, controller.signal, signal);
      throw new AIError(type, payload?.error?.message || `AI service failed (${response.status}).`, { status: response.status, code: payload?.error?.code });
    }
    return payload;
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    if (controller.signal.aborted) throw new AIError('model_timeout', 'The AI model request timed out.');
    throw new AIError('provider_error', error?.message || String(error));
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

function normalizeRemoteError(code, status, localSignal, externalSignal) {
  if (externalSignal?.aborted) return 'cancelled';
  if (localSignal?.aborted || code === 'upstream_timeout' || status === 504) return 'model_timeout';
  if (code === 'invalid_model_output') return 'invalid_model_output';
  if (code === 'request_too_large') return 'context_too_large';
  if (code === 'rate_limited' || code === 'upstream_rate_limited' || code === 'upstream_quota_exceeded') return 'provider_error';
  return 'provider_error';
}
