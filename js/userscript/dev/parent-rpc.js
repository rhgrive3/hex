export const DEV_PARENT_RPC_PROTOCOL = 'hex-dev-parent-rpc-v1';
export const DEV_PARENT_RPC_METHODS = Object.freeze([
  'dev.worker.discover',
  'dev.worker.claim',
  'dev.worker.create_chat',
  'dev.worker.send',
  'dev.worker.observe',
  'dev.worker.followup',
  'dev.worker.nudge',
  'dev.worker.stop',
  'dev.worker.result',
  'dev.worker.release',
  'dev.worker.wait_event',
]);

const METHODS = new Set(DEV_PARENT_RPC_METHODS);
const MAX_DEPTH = 32;
const REQUEST_ID = /^devrpc_[a-f0-9]{32}$/;

export function createDevWorkerParentRpc({ port, runtime } = {}) {
  if (!usablePort(port)) throw new TypeError('Dev Worker parent RPC requires a MessagePort.');
  if (!runtime || typeof runtime !== 'object') throw new TypeError('Dev Worker parent RPC requires a runtime.');

  const active = new Map();
  let closed = false;

  const onMessage = (event) => {
    const message = event?.data;
    if (!validBase(message) || message.kind !== 'request') return;
    void handle(message);
  };
  const onCancel = (event) => {
    const message = event?.data;
    if (!validBase(message) || message.kind !== 'cancel') return;
    active.get(message.id)?.abort('remote-cancel');
  };

  listen(port, onMessage);
  listen(port, onCancel);
  port.start?.();

  async function handle(message) {
    if (closed || active.has(message.id)) return;
    const controller = new AbortController();
    active.set(message.id, controller);
    try {
      const result = await dispatch(
        runtime,
        message.method,
        normalizeParams(message.params),
        controller.signal,
      );
      post(port, {
        protocol: DEV_PARENT_RPC_PROTOCOL,
        kind: 'result',
        id: message.id,
        method: message.method,
        result: sanitize(result),
      });
    } catch (error) {
      post(port, {
        protocol: DEV_PARENT_RPC_PROTOCOL,
        kind: 'error',
        id: message.id,
        method: message.method,
        error: {
          code: safeCode(error?.code),
          message: safeMessage(error?.message),
        },
      });
    } finally {
      active.delete(message.id);
    }
  }

  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      unlisten(port, onMessage);
      unlisten(port, onCancel);
      for (const controller of active.values()) controller.abort('rpc-closed');
      active.clear();
    },
  });
}

export function createDevWorkerParentRpcClient({ port, timeoutMs = 20000 } = {}) {
  if (!usablePort(port)) throw new TypeError('Dev Worker RPC client requires a MessagePort.');

  const pending = new Map();
  let closed = false;

  const onMessage = (event) => {
    const message = event?.data;
    if (!validBase(message) || !['result', 'error'].includes(message.kind)) return;
    const current = pending.get(message.id);
    if (!current || current.method !== message.method) return;

    pending.delete(message.id);
    if (current.timer) clearTimeout(current.timer);
    current.detach?.();
    if (message.kind === 'result') current.resolve(sanitize(message.result));
    else current.reject(remoteError(message.error));
  };

  listen(port, onMessage);
  port.start?.();

  async function call(method, params = {}, options = {}) {
    if (closed) throw rpcError('transport-failure', 'Dev Worker RPC is closed.');
    if (!METHODS.has(method)) {
      throw rpcError('transport-failure', `Dev Worker RPC method is not allowed: ${method}`);
    }

    const id = requestId();
    const signal = options.signal;
    const limit = options.timeoutMs === 0
      ? 0
      : normalizeTimeout(options.timeoutMs, timeoutMs);
    if (signal?.aborted) throw abortError(signal.reason);

    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        const current = pending.get(id);
        if (!current) return;
        pending.delete(id);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        post(port, { protocol: DEV_PARENT_RPC_PROTOCOL, kind: 'cancel', id, method });
        reject(abortError(signal?.reason));
      };

      if (limit > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          signal?.removeEventListener?.('abort', onAbort);
          post(port, { protocol: DEV_PARENT_RPC_PROTOCOL, kind: 'cancel', id, method });
          reject(rpcError('transport-failure', `Dev Worker RPC timed out: ${method}`));
        }, limit);
      }

      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        detach: () => signal?.removeEventListener?.('abort', onAbort),
      });
      post(port, {
        protocol: DEV_PARENT_RPC_PROTOCOL,
        kind: 'request',
        id,
        method,
        params: sanitize(params),
      });
    });
  }

  return Object.freeze({
    discover: (args = {}, opts = {}) => call('dev.worker.discover', args, opts),
    claim: (args = {}, opts = {}) => call('dev.worker.claim', args, opts),
    createChat: (args = {}, opts = {}) => call('dev.worker.create_chat', args, opts),
    send: (args = {}, opts = {}) => call('dev.worker.send', args, opts),
    observe: (args = {}, opts = {}) => call('dev.worker.observe', args, opts),
    followup: (args = {}, opts = {}) => call('dev.worker.followup', args, opts),
    nudge: (args = {}, opts = {}) => call('dev.worker.nudge', args, opts),
    stop: (args = {}, opts = {}) => call('dev.worker.stop', args, opts),
    result: (args = {}, opts = {}) => call('dev.worker.result', args, opts),
    release: (args = {}, opts = {}) => call('dev.worker.release', args, opts),
    waitEvent: (args = {}, opts = {}) => call('dev.worker.wait_event', args, {
      ...opts,
      timeoutMs: 0,
    }),
    close() {
      if (closed) return;
      closed = true;
      unlisten(port, onMessage);
      for (const current of pending.values()) {
        if (current.timer) clearTimeout(current.timer);
        current.detach?.();
        current.reject(rpcError('transport-failure', 'Dev Worker RPC closed.'));
      }
      pending.clear();
    },
  });
}

async function dispatch(runtime, method, params, signal) {
  const options = { signal };
  if (method === 'dev.worker.discover') return runtime.discover(params, options);
  if (method === 'dev.worker.claim') return runtime.claim(params, options);
  if (method === 'dev.worker.create_chat') return runtime.createChat(params, options);
  if (method === 'dev.worker.send') return runtime.send(params, options);
  if (method === 'dev.worker.observe') return runtime.observe(params, options);
  if (method === 'dev.worker.followup') return runtime.followup(params, options);
  if (method === 'dev.worker.nudge') return runtime.nudge(params, options);
  if (method === 'dev.worker.stop') return runtime.stop(params, options);
  if (method === 'dev.worker.result') return runtime.result(params, options);
  if (method === 'dev.worker.release') return runtime.release(params, options);
  if (method === 'dev.worker.wait_event') return runtime.waitEvent(params, options);
  throw rpcError('transport-failure', 'Unknown Dev Worker RPC method.');
}

function validBase(message) {
  return isPlainRecord(message)
    && message.protocol === DEV_PARENT_RPC_PROTOCOL
    && ['request', 'result', 'error', 'cancel'].includes(message.kind)
    && typeof message.id === 'string'
    && REQUEST_ID.test(message.id)
    && METHODS.has(message.method);
}

function normalizeParams(value) {
  if (value == null) return {};
  if (!isPlainRecord(value)) {
    throw rpcError('transport-failure', 'Dev Worker RPC params must be a plain object.');
  }
  return sanitize(value);
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (depth >= MAX_DEPTH || typeof value !== 'object' || seen.has(value)) {
    throw rpcError('transport-failure', 'Unsafe Dev Worker RPC data.');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, depth + 1, seen));
    }
    if (!isPlainRecord(value)) {
      throw rpcError('transport-failure', 'Unsafe Dev Worker RPC data.');
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw rpcError('transport-failure', 'Unsafe Dev Worker RPC key.');
      }
      out[key] = sanitize(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function requestId() {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw rpcError('transport-failure', 'WebCrypto is required for Dev Worker RPC request identity.');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `devrpc_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function usablePort(port) {
  return !!port
    && typeof port.postMessage === 'function'
    && (typeof port.addEventListener === 'function' || 'onmessage' in port);
}

function post(port, value) {
  try { port.postMessage(value); } catch {}
}
function listen(port, handler) {
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', handler);
    return;
  }
  const previous = port.onmessage;
  port.onmessage = (event) => {
    previous?.(event);
    handler(event);
  };
}
function unlisten(port, handler) {
  try { port.removeEventListener?.('message', handler); } catch {}
}
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('RPC timeout must be non-negative.');
  return Math.floor(number);
}
function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9.-]{1,64}$/i.test(value)
    ? value
    : 'provider-error';
}
function safeMessage(value) {
  return typeof value === 'string' && value
    ? value.slice(0, 512)
    : 'Dev Worker RPC failed.';
}
function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function remoteError(value) {
  return rpcError(safeCode(value?.code), safeMessage(value?.message));
}
function abortError(reason) {
  const error = rpcError('cancelled', String(reason || 'cancelled'));
  error.name = 'AbortError';
  return error;
}
