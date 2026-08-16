export const EMBED_PROTOCOL = 'hex-embed-v1';
export const EMBED_PROTOCOL_VERSION = 1;
export const CHATGPT_PARENT_ORIGINS = Object.freeze([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
export const CHATGPT_RPC_METHODS = Object.freeze([
  'chatgpt.request',
  'chatgpt.cancel',
  'chatgpt.capabilities',
  'chatgpt.getSelection',
  'chatgpt.setSelection',
  'chatgpt.status',
  'chatgpt.conversationFor',
]);
export const EMBED_RPC_METHODS = Object.freeze([...CHATGPT_RPC_METHODS, 'ui.close']);

const ALLOWED_METHODS = new Set(EMBED_RPC_METHODS);
const ATTACHED_SOURCES = new WeakSet();
const VALID_KINDS = new Set(['request', 'result', 'error', 'cancel', 'control']);
const CONTROL_READY = 'ready';
const CONTROL_CLOSE = 'close';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_SEEN_REQUEST_IDS = 4096;
const MAX_DETAILS_DEPTH = 4;
const TOKEN_RE = /^[A-Za-z0-9._:~-]+$/;
const NONCE_RE = /^[a-f0-9]{64}$/;

export function createEmbedNonce() {
  const bytes = new Uint8Array(32);
  secureCrypto().getRandomValues(bytes);
  let out = '';
  for (const value of bytes) out += value.toString(16).padStart(2, '0');
  return out;
}

export function validateAttachEvent(event, options = {}) {
  const expectedSource = options.expectedSource;
  const allowedOrigins = normalizeOrigins(options.allowedOrigins ?? CHATGPT_PARENT_ORIGINS);
  if (!event || typeof event !== 'object') return rejectAttach('invalid-event');
  if (!isObjectLike(expectedSource)) return rejectAttach('missing-expected-source');
  if (!allowedOrigins.has(event.origin)) return rejectAttach('wrong-origin');
  if (event.source !== expectedSource) return rejectAttach('wrong-source');

  const data = event.data;
  if (!isPlainRecord(data)) return rejectAttach('invalid-message');
  if (data.type !== 'hex.embed.attach') return rejectAttach('wrong-type');
  if (data.protocol !== EMBED_PROTOCOL) return rejectAttach('wrong-protocol');
  if (data.version !== EMBED_PROTOCOL_VERSION) return rejectAttach('wrong-version');
  if (!validNonce(data.nonce)) return rejectAttach('malformed-nonce');

  const ports = event.ports;
  if (!ports || Number(ports.length) !== 1 || !usablePort(ports[0])) return rejectAttach('invalid-port');
  if (sourceWasAttached(expectedSource)) return rejectAttach('duplicate-attach');

  markSourceAttached(expectedSource);
  return Object.freeze({
    ok: true,
    protocol: EMBED_PROTOCOL,
    version: EMBED_PROTOCOL_VERSION,
    nonce: data.nonce,
    port: ports[0],
  });
}

export function createRpcClient(port, options = {}) {
  assertUsablePort(port);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const readyTimeoutMs = normalizeTimeout(options.readyTimeoutMs, timeoutMs);
  const nonce = options.nonce == null ? null : String(options.nonce);
  if (nonce !== null && !validNonce(nonce)) throw rpcLocalError('RPC_INVALID_NONCE', 'Invalid embed nonce.');

  const pending = new Map();
  let closed = false;
  let readySettled = nonce === null;
  let readyResolve;
  let readyReject;
  let readyTimer = null;
  const ready = nonce === null
    ? Promise.resolve()
    : new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  if (nonce !== null && readyTimeoutMs > 0) {
    readyTimer = setTimeout(() => {
      if (readySettled || closed) return;
      readySettled = true;
      readyReject(rpcLocalError('RPC_READY_TIMEOUT', 'RPC ready handshake timed out.'));
    }, readyTimeoutMs);
  }

  const detach = listenPort(port, onMessage);
  safeStart(port);

  function finishReady(error = null) {
    if (readySettled) return;
    readySettled = true;
    if (readyTimer !== null) { clearTimeout(readyTimer); readyTimer = null; }
    if (error) readyReject(error); else readyResolve();
  }

  function onMessage(event) {
    if (closed) return;
    const message = event?.data;
    if (!validEnvelopeBase(message)) return;

    if (message.kind === 'control') {
      if (message.method === CONTROL_READY && nonce !== null && message.nonce === nonce) {
        finishReady();
      } else if (message.method === CONTROL_CLOSE) {
        closeInternal('RPC_REMOTE_CLOSED', safeMessage(message.reason, 'RPC peer closed.'), false);
      }
      return;
    }

    if (message.kind !== 'result' && message.kind !== 'error') return;
    const current = pending.get(message.id);
    if (!current || current.method !== message.method) return;
    pending.delete(message.id);
    if (current.timer !== null) clearTimeout(current.timer);
    current.detachAbort?.();

    if (message.kind === 'result') current.resolve(message.result);
    else current.reject(remoteError(message.error));
  }

  async function call(method, params, callOptions = {}) {
    if (closed) throw rpcLocalError('RPC_CLOSED', 'RPC client is closed.');
    if (!ALLOWED_METHODS.has(method)) throw rpcLocalError('RPC_METHOD_NOT_ALLOWED', `RPC method is not allowed: ${String(method)}`);
    await ready;
    if (closed) throw rpcLocalError('RPC_CLOSED', 'RPC client is closed.');

    const id = createRequestId();
    const signal = callOptions.signal;
    if (signal?.aborted) throw abortError(signal.reason);
    const requestTimeout = normalizeTimeout(callOptions.timeoutMs, timeoutMs);

    return new Promise((resolve, reject) => {
      let timer = null;
      let detached = false;
      const detachAbort = () => {
        if (detached) return;
        detached = true;
        signal?.removeEventListener?.('abort', onAbort);
      };
      const settleLocal = (error, sendCancel) => {
        const current = pending.get(id);
        if (!current) return;
        pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        detachAbort();
        if (sendCancel && !closed) safePost(port, envelope('cancel', id, method));
        reject(error);
      };
      const onAbort = () => settleLocal(abortError(signal?.reason), true);

      if (requestTimeout > 0) {
        timer = setTimeout(() => settleLocal(rpcLocalError('RPC_TIMEOUT', `RPC request timed out: ${method}`), true), requestTimeout);
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.set(id, { method, resolve, reject, timer, detachAbort });

      if (!safePost(port, { ...envelope('request', id, method), params })) {
        settleLocal(rpcLocalError('RPC_CLOSED', 'RPC port is not available.'), false);
      }
    });
  }

  function close(reason = 'RPC client closed.') {
    closeInternal('RPC_CLOSED', safeMessage(reason, 'RPC client closed.'), true);
  }

  function closeInternal(code, message, notifyPeer) {
    if (closed) return;
    closed = true;
    if (notifyPeer) safePost(port, { ...envelope('control', createControlId('close'), CONTROL_CLOSE), reason: message });
    detach();
    safeClose(port);
    if (!readySettled) finishReady(rpcLocalError(code, message));
    for (const current of pending.values()) {
      if (current.timer !== null) clearTimeout(current.timer);
      current.detachAbort?.();
      current.reject(rpcLocalError(code, message));
    }
    pending.clear();
  }

  return Object.freeze({
    call,
    close,
    ready,
    get closed() { return closed; },
  });
}

export function createRpcServer(port, options = {}) {
  assertUsablePort(port);
  const nonce = options.nonce == null ? null : String(options.nonce);
  if (nonce !== null && !validNonce(nonce)) throw rpcLocalError('RPC_INVALID_NONCE', 'Invalid embed nonce.');
  const handlers = normalizeHandlers(options.handlers);
  const active = new Map();
  const seenRequestIds = new Set();
  let closed = false;

  const detach = listenPort(port, onMessage);
  safeStart(port);
  if (nonce !== null) safePost(port, { ...envelope('control', createControlId('ready'), CONTROL_READY), nonce });

  function onMessage(event) {
    if (closed) return;
    const message = event?.data;
    if (!validEnvelopeBase(message)) return;

    if (message.kind === 'control') {
      if (message.method === CONTROL_CLOSE) closeInternal(safeMessage(message.reason, 'RPC peer closed.'), false);
      return;
    }
    if (message.kind === 'cancel') {
      const request = active.get(message.id);
      if (request && request.method === message.method) request.controller.abort('remote-cancel');
      return;
    }
    if (message.kind !== 'request') return;
    void handleRequest(message);
  }

  async function handleRequest(message) {
    const { id, method } = message;
    if (seenRequestIds.has(id)) {
      sendError(id, method, 'RPC_DUPLICATE_ID', 'Duplicate RPC request id.');
      return;
    }
    if (seenRequestIds.size >= MAX_SEEN_REQUEST_IDS) {
      sendError(id, method, 'RPC_CAPACITY', 'RPC request id capacity reached for this port.');
      return;
    }
    seenRequestIds.add(id);

    if (!ALLOWED_METHODS.has(method)) {
      sendError(id, method, 'RPC_METHOD_NOT_ALLOWED', 'RPC method is not allowed.');
      return;
    }
    const handler = handlers.get(method);
    if (typeof handler !== 'function') {
      sendError(id, method, 'RPC_METHOD_UNAVAILABLE', 'RPC method is unavailable.');
      return;
    }

    const controller = new AbortController();
    active.set(id, { method, controller });
    try {
      const result = await handler(message.params, Object.freeze({ id, method, signal: controller.signal }));
      if (!closed) safePost(port, { ...envelope('result', id, method), result });
    } catch (error) {
      if (!closed) sendSanitizedError(id, method, error, controller.signal.aborted);
    } finally {
      const current = active.get(id);
      if (current?.controller === controller) active.delete(id);
    }
  }

  function sendSanitizedError(id, method, error, wasCancelled) {
    const payload = sanitizeRemoteError(error, wasCancelled);
    safePost(port, { ...envelope('error', id, method), error: payload });
  }

  function sendError(id, method, code, message, details) {
    const error = { code, message };
    const safeDetails = sanitizeDetails(details);
    if (safeDetails !== undefined) error.details = safeDetails;
    safePost(port, { ...envelope('error', id, method), error });
  }

  function close(reason = 'RPC server closed.') {
    closeInternal(safeMessage(reason, 'RPC server closed.'), true);
  }

  function closeInternal(reason, notifyPeer) {
    if (closed) return;
    closed = true;
    if (notifyPeer) safePost(port, { ...envelope('control', createControlId('close'), CONTROL_CLOSE), reason });
    detach();
    for (const request of active.values()) request.controller.abort('rpc-closed');
    active.clear();
    safeClose(port);
  }

  return Object.freeze({
    close,
    get closed() { return closed; },
  });
}

function envelope(kind, id, method) {
  return { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind, id, method };
}

function validEnvelopeBase(message) {
  return isPlainRecord(message)
    && message.protocol === EMBED_PROTOCOL
    && message.version === EMBED_PROTOCOL_VERSION
    && VALID_KINDS.has(message.kind)
    && validToken(message.id, 1, 128)
    && validMethodShape(message.method);
}

function validMethodShape(method) {
  return typeof method === 'string' && method.length >= 1 && method.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(method);
}

function validNonce(value) {
  return typeof value === 'string' && NONCE_RE.test(value);
}

function normalizeHandlers(input) {
  const out = new Map();
  if (input == null) return out;
  if (input instanceof Map) {
    for (const [name, handler] of input) if (ALLOWED_METHODS.has(name) && typeof handler === 'function') out.set(name, handler);
    return out;
  }
  if (!isPlainRecord(input)) throw new TypeError('RPC handlers must be a Map or plain object.');
  for (const name of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) continue;
    if (ALLOWED_METHODS.has(name) && typeof input[name] === 'function') out.set(name, input[name]);
  }
  return out;
}

function normalizeOrigins(input) {
  const values = typeof input === 'string' ? [input] : input;
  const out = new Set();
  if (!values || typeof values[Symbol.iterator] !== 'function') return out;
  for (const value of values) {
    if (typeof value === 'string' && /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(value)) out.add(value);
  }
  return out;
}

function sourceWasAttached(source) { return ATTACHED_SOURCES.has(source); }
function markSourceAttached(source) { ATTACHED_SOURCES.add(source); }

function rejectAttach(code) { return Object.freeze({ ok: false, code }); }

function createRequestId() {
  const bytes = new Uint8Array(16);
  secureCrypto().getRandomValues(bytes);
  let out = 'rpc_';
  for (const value of bytes) out += value.toString(16).padStart(2, '0');
  return out;
}

function createControlId(kind) {
  return `${kind}:${createRequestId()}`;
}

function secureCrypto() {
  const value = globalThis.crypto;
  if (!value || typeof value.getRandomValues !== 'function') throw new Error('Secure crypto.getRandomValues is required.');
  return value;
}

function sanitizeRemoteError(error, wasCancelled) {
  const code = wasCancelled ? 'RPC_CANCELLED' : safeCode(error?.code, 'RPC_REMOTE_ERROR');
  const message = wasCancelled ? 'RPC request was cancelled.' : safeMessage(error?.message, 'Remote RPC handler failed.');
  const out = { code, message };
  const details = sanitizeDetails(error?.details);
  if (details !== undefined) out.details = details;
  return out;
}

function sanitizeDetails(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length <= 2048 ? value : value.slice(0, 2048);
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DETAILS_DEPTH || typeof value !== 'object') return undefined;
  if (typeof Error !== 'undefined' && value instanceof Error) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeDetails(item, depth + 1, seen));
  if (!isPlainRecord(value)) return undefined;
  const out = Object.create(null);
  for (const key of Object.keys(value).slice(0, 64)) {
    if (/^(?:stack|cause)$/i.test(key)) continue;
    const clean = sanitizeDetails(value[key], depth + 1, seen);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function remoteError(payload) {
  const code = safeCode(payload?.code, 'RPC_REMOTE_ERROR');
  const error = rpcLocalError(code, safeMessage(payload?.message, 'Remote RPC error.'));
  const details = sanitizeDetails(payload?.details);
  if (details !== undefined) error.details = details;
  return error;
}

function rpcLocalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError(reason) {
  const message = typeof reason === 'string' && reason ? reason : 'RPC request was aborted.';
  return rpcLocalError('RPC_ABORTED', message);
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z0-9_.-]{1,64}$/i.test(value) ? value : fallback;
}
function safeMessage(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 2048) : fallback;
}
function validToken(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max && TOKEN_RE.test(value);
}
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('RPC timeout must be a non-negative finite number.');
  return Math.floor(number);
}
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function isObjectLike(value) { return (typeof value === 'object' && value !== null) || typeof value === 'function'; }
function usablePort(port) {
  return !!port && typeof port.postMessage === 'function' && typeof port.close === 'function'
    && (typeof port.addEventListener === 'function' || 'onmessage' in port);
}
function assertUsablePort(port) { if (!usablePort(port)) throw new TypeError('A usable MessagePort is required.'); }
function safeStart(port) { try { port.start?.(); } catch {} }
function safeClose(port) { try { port.close(); } catch {} }
function safePost(port, message) { try { port.postMessage(message); return true; } catch { return false; } }
function listenPort(port, handler) {
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', handler);
    return () => { try { port.removeEventListener('message', handler); } catch {} };
  }
  const previous = port.onmessage;
  port.onmessage = handler;
  return () => { if (port.onmessage === handler) port.onmessage = previous || null; };
}
