import {
  CHATGPT_PARENT_ORIGINS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
} from './embed-protocol.js';

export const EMBED_BOOTSTRAP_TYPE = 'hex.embed.child-bootstrap-ready';
export const EMBED_GENERATION_PARAM = '__hex_embed_generation';
export const EMBED_PROVIDER_PARAM = '__hex_ai_provider';
export const DEFAULT_EMBED_BOOTSTRAP_TIMEOUT_MS = 20000;

export function normalizeEmbedGeneration(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d{0,14}$/.test(text)) throw new TypeError('Invalid Hex embed generation.');
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError('Invalid Hex embed generation.');
  return String(number);
}

export function withEmbedGeneration(src, generation) {
  const url = new URL(String(src || ''));
  url.searchParams.set(EMBED_GENERATION_PARAM, normalizeEmbedGeneration(generation));
  return url.href;
}

export function readEmbedGeneration(locationRef = globalThis.location) {
  const raw = readLocationParam(locationRef, EMBED_GENERATION_PARAM);
  if (raw == null) return null;
  try { return normalizeEmbedGeneration(raw); } catch { return null; }
}

export function createEmbedBootstrapMessage(generation) {
  return Object.freeze({
    type: EMBED_BOOTSTRAP_TYPE,
    protocol: EMBED_PROTOCOL,
    version: EMBED_PROTOCOL_VERSION,
    generation: normalizeEmbedGeneration(generation),
  });
}

export function announceEmbedChildBootstrapReady(options = {}) {
  const windowRef = options.windowRef || options.window || globalThis.window;
  const parent = options.parent || windowRef?.parent;
  const generation = normalizeEmbedGeneration(options.generation);
  const targetOrigins = normalizeOrigins(options.targetOrigins || CHATGPT_PARENT_ORIGINS);
  if (!parent || parent === windowRef || typeof parent.postMessage !== 'function') throw new Error('Hex embed parent window is unavailable.');
  const message = createEmbedBootstrapMessage(generation);
  let attempts = 0;
  for (const origin of targetOrigins) { parent.postMessage(message, origin); attempts += 1; }
  if (!attempts) throw new Error('Hex embed has no allowed parent origin.');
  return message;
}

export function waitForEmbedChildBootstrap(options = {}) {
  const windowRef = options.windowRef || options.window || globalThis.window;
  const expectedSource = options.expectedSource;
  const childOrigin = normalizeBootstrapOrigin(options.childOrigin);
  const generation = normalizeEmbedGeneration(options.generation);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_EMBED_BOOTSTRAP_TIMEOUT_MS);
  const signal = options.signal;
  if (!windowRef?.addEventListener || !windowRef?.removeEventListener) return Promise.reject(new TypeError('A parent window event target is required.'));
  if (!expectedSource) return Promise.reject(new TypeError('Expected iframe source is required.'));
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      windowRef.removeEventListener('message', onMessage);
      signal?.removeEventListener?.('abort', onAbort);
      if (timer !== null) clearTimeout(timer);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => settle(abortError(signal?.reason));
    function onMessage(event) {
      /* An iframe sandboxed without allow-same-origin has the serialized origin
         "null". Source identity + generation are therefore mandatory and remain
         part of the check; accepting opaque origin alone would be insufficient. */
      if (event?.source !== expectedSource || event?.origin !== childOrigin) return;
      const data = event?.data;
      if (!isPlainRecord(data) || data.type !== EMBED_BOOTSTRAP_TYPE) return;
      if (data.protocol !== EMBED_PROTOCOL || data.version !== EMBED_PROTOCOL_VERSION) return;
      if (String(data.generation) !== generation) return;
      settle(null, Object.freeze({ generation, origin: childOrigin, source: expectedSource }));
    }
    windowRef.addEventListener('message', onMessage);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => settle(localError('EMBED_BOOTSTRAP_TIMEOUT', 'Hex iframe bootstrap timed out.')), timeoutMs);
  });
}

export function readEmbedProvider(locationRef = globalThis.location) {
  return normalizeEmbedProvider(readLocationParam(locationRef, EMBED_PROVIDER_PARAM));
}

export function setEmbedProvider(src, provider) {
  const url = new URL(String(src || ''));
  const normalized = normalizeEmbedProvider(provider);
  if (normalized) url.searchParams.set(EMBED_PROVIDER_PARAM, normalized);
  else url.searchParams.delete(EMBED_PROVIDER_PARAM);
  return url.href;
}

export function normalizeEmbedProvider(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'gemini' || normalized === 'worker') return 'gemini';
  if (normalized === 'chatgpt' || normalized === 'chatgpt-web') return 'chatgpt';
  return null;
}

function readLocationParam(locationRef, name) {
  try {
    if (typeof locationRef?.search === 'string' && locationRef.search) return new URLSearchParams(locationRef.search).get(name);
  } catch {}
  try {
    if (typeof locationRef?.href === 'string' && locationRef.href) return new URL(locationRef.href).searchParams.get(name);
  } catch {}
  return null;
}
function normalizeOrigins(values) {
  const input = typeof values === 'string' ? [values] : values;
  const out = [];
  for (const value of input || []) {
    try { const origin = normalizeOrigin(value); if (!out.includes(origin)) out.push(origin); } catch {}
  }
  return out;
}
function normalizeBootstrapOrigin(value) {
  if (String(value) === 'null') return 'null';
  return normalizeOrigin(value);
}
function normalizeOrigin(value) {
  const text = String(value || '');
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.origin !== text) throw new TypeError('Expected an exact HTTPS origin.');
  return url.origin;
}
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('Embed timeout must be a non-negative finite number.');
  return Math.floor(number);
}
function abortError(reason) {
  const error = localError('EMBED_BOOTSTRAP_ABORTED', typeof reason === 'string' && reason ? reason : 'Hex iframe bootstrap was aborted.');
  error.name = 'AbortError';
  return error;
}
function localError(code, message) { const error = new Error(message); error.code = code; return error; }
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
