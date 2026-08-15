export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_CONTEXT_CHARS = 160000;
export const REQUEST_TIMEOUT_MS = 110000;
export const MAX_UPSTREAM_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 4000;
export const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const AI_QUOTA_BINDING = 'AI_QUOTA';

export function isJsonRequest(request) { return (request.headers.get('content-type') || '').toLowerCase().startsWith('application/json'); }
export function byteLength(value) { return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength; }
export function boundedText(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }

export async function readLimitedText(request, limit = MAX_REQUEST_BYTES) {
  const announced = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(announced) && announced > limit) throw new HttpError(413, 'request_too_large', 'The analysis request is too large.');
  if (!request.body) throw new HttpError(400, 'missing_body', 'A JSON request body is required.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'request_too_large', 'The analysis request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

export function quotaClientKey(request) { return boundedText(request.headers.get('cf-connecting-ip'), 128).trim() || 'unknown'; }
export function quotaSessionId(value) { return boundedText(value, 128).trim() || 'anonymous'; }
export async function acquireDistributedQuota(request, env, sessionId) {
  const binding = env?.[AI_QUOTA_BINDING];
  if (!binding || typeof binding.getByName !== 'function') return { response: jsonError(503, 'quota_unavailable', 'AI quota enforcement is unavailable; requests are blocked fail-closed.'), lease: null };
  try {
    const stub = binding.getByName('ip:' + quotaClientKey(request));
    if (!stub || typeof stub.acquire !== 'function' || typeof stub.release !== 'function') throw new Error('invalid quota stub');
    const result = await stub.acquire({ sessionId: quotaSessionId(sessionId) });
    if (!result?.allowed) {
      const retrySeconds = Math.max(1, Math.ceil(Number(result?.retryAfterMs || 1000) / 1000));
      const code = result?.reason === 'concurrency' ? 'concurrency_limited' : 'rate_limited';
      const message = result?.reason === 'concurrency' ? 'Too many concurrent AI requests. Please retry shortly.' : 'Too many AI requests. Please retry shortly.';
      return { response: jsonError(429, code, message, { 'retry-after': String(retrySeconds) }), lease: null };
    }
    if (!result.token) throw new Error('quota lease token missing');
    return { response: null, lease: { stub, token: result.token } };
  } catch (error) {
    console.error('[ai-quota] acquire failed', { message: error?.message || String(error) });
    return { response: jsonError(503, 'quota_unavailable', 'AI quota enforcement is temporarily unavailable; requests are blocked fail-closed.'), lease: null };
  }
}
export async function releaseDistributedQuota(lease) { if (!lease?.stub || !lease.token) return; try { await lease.stub.release(lease.token); } catch (error) { console.error('[ai-quota] release failed', { message: error?.message || String(error) }); } }
export async function readUpstreamFailure(response) { let code = null; try { const body = await response.json(); if (body?.error) code = typeof body.error.code === 'string' ? body.error.code : typeof body.error.status === 'string' ? body.error.status.toLowerCase() : null; } catch { try { await response.body?.cancel(); } catch {} } return { code: typeof code === 'string' ? code.slice(0, 80) : null }; }
export function isRetryableUpstreamFailure(status, code) { return RETRYABLE_UPSTREAM_STATUSES.has(status) && !(status === 429 && code === 'quota_exceeded'); }
export function retryDelayMs(attempt, retryAfter) { const after = parseRetryAfterMs(retryAfter); if (after != null) return Math.min(after, RETRY_MAX_DELAY_MS); const exponential = Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), RETRY_MAX_DELAY_MS); return Math.min(exponential + Math.floor(Math.random() * Math.min(250, Math.max(1, exponential / 4))), RETRY_MAX_DELAY_MS); }
export function parseRetryAfterMs(value) { if (typeof value !== 'string' || !value.trim()) return null; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000); const when = Date.parse(value); return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null; }
export async function waitForRetry(attempt, retryAfter, signal) { const delay = retryDelayMs(attempt, retryAfter); if (signal.aborted) return false; if (delay <= 0) return true; return new Promise((resolve) => { let settled = false; const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); }; const onAbort = () => finish(false); const timer = setTimeout(() => finish(true), delay); signal.addEventListener('abort', onAbort, { once: true }); }); }
export function logRetryableFailure(attempt, status, code) { console.warn('[gemini] transient upstream failure', { attempt, maxAttempts: MAX_UPSTREAM_ATTEMPTS, status: status || null, code: code || null }); }
export function upstreamError(status, upstreamCode, retryAfter) { const headers = retryAfter ? { 'retry-after': retryAfter } : undefined; if (status === 429 && upstreamCode === 'quota_exceeded') return jsonError(429, 'upstream_quota_exceeded', 'The analysis service quota is exhausted. Please try again after the quota resets.', headers); if (status === 429) return jsonError(429, 'upstream_rate_limited', 'The analysis service is busy even after retrying. Please try again shortly.', headers); if (status === 408 || status === 504) return jsonError(504, 'upstream_timeout', 'The analysis service did not respond in time.'); if (status === 401 || status === 403) return jsonError(502, 'upstream_configuration_error', 'The analysis service rejected its configuration.'); if (status >= 400 && status < 500) return jsonError(502, 'upstream_request_rejected', 'The analysis service rejected the request.'); return jsonError(502, 'upstream_error', 'The analysis service returned an unexpected error after retrying.'); }
export function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
export function jsonError(status, code, message, extraHeaders) { return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(extraHeaders || {}) } }); }
export class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
