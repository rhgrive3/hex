import { AIError } from './schema.js';

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function requestJSON(url, body, {
  signal,
  timeoutMs = 30000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new AIError('provider_error', 'Fetch is unavailable.');
  if (signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
  const responseLimit = normalizeLimit(maxResponseBytes);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), Math.max(1, timeoutMs));
  const abort = () => controller.abort(signal?.reason ?? 'cancelled');
  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
    // Close the race between the synchronous check above and listener setup.
    if (signal.aborted) abort();
  }
  try {
    if (controller.signal.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > responseLimit) {
      controller.abort('response-too-large');
      throw new AIError('context_too_large', `The AI service response exceeded ${responseLimit} bytes.`, { bytes: contentLength, maxBytes: responseLimit });
    }
    const text = await readBoundedText(response, responseLimit, controller);
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new AIError('provider_error', 'The AI service returned invalid JSON.', { status: response.status }); }
    if (!response.ok) {
      const type = normalizeRemoteError(payload?.error?.code, response.status, controller.signal, signal);
      throw new AIError(type, payload?.error?.message || `AI service failed (${response.status}).`, { status: response.status, code: payload?.error?.code });
    }
    return payload;
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    if (controller.signal.aborted) {
      if (controller.signal.reason === 'response-too-large') throw new AIError('context_too_large', `The AI service response exceeded ${responseLimit} bytes.`);
      throw new AIError('model_timeout', 'The AI model request timed out.');
    }
    throw new AIError('provider_error', error?.message || String(error));
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

async function readBoundedText(response, maxBytes, controller) {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          controller.abort('response-too-large');
          try { await reader.cancel('response-too-large'); } catch { /* best effort */ }
          throw new AIError('context_too_large', `The AI service response exceeded ${maxBytes} bytes.`, { bytes, maxBytes });
        }
        parts.push(decoder.decode(chunk, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } finally {
      try { reader.releaseLock(); } catch { /* already released/cancelled */ }
    }
  }

  // Non-streaming Response implementations are mainly test/polyfill paths.
  // We still enforce the cap immediately after materialization; real browsers
  // expose response.body and therefore take the bounded streaming path above.
  const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    controller.abort('response-too-large');
    throw new AIError('context_too_large', `The AI service response exceeded ${maxBytes} bytes.`, { bytes, maxBytes });
  }
  return text;
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.max(1024, Math.min(16 * 1024 * 1024, Math.floor(n)));
}

function normalizeRemoteError(code, status, localSignal, externalSignal) {
  if (externalSignal?.aborted) return 'cancelled';
  if (localSignal?.aborted || code === 'upstream_timeout' || status === 504) return 'model_timeout';
  if (code === 'invalid_model_output') return 'invalid_model_output';
  if (code === 'request_too_large') return 'context_too_large';
  if (code === 'rate_limited' || code === 'upstream_rate_limited' || code === 'upstream_quota_exceeded') return 'provider_error';
  return 'provider_error';
}
