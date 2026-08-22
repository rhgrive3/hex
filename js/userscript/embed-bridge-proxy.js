import { createRpcClient } from './embed-protocol.js';

const DEFAULT_REFRESH_TIMEOUT_MS = 2000;
const DEFAULT_RPC_TIMEOUT_MS = 120000;
const SAFE_STATUS = Object.freeze({
  ready: false,
  busy: false,
  generating: false,
  conversation: null,
  selection: null,
  error: null,
});

export function createEmbedBridgeProxy(options = {}) {
  const port = options.port;
  if (!port) throw new TypeError('embed bridge proxy requires a MessagePort.');
  const createClient = options.createClient || createRpcClient;
  const rpc = createClient(port, { timeoutMs: DEFAULT_RPC_TIMEOUT_MS, ...(options.rpcOptions || {}) });
  if (!rpc || typeof rpc.call !== 'function') throw new TypeError('embed bridge proxy requires an RPC client.');

  let statusCache = clonePlainData(SAFE_STATUS);
  let selectionCache = null;
  const conversationCache = new Map();
  const activeControllers = new Set();
  const conversationRefreshes = new Map();
  let refreshPromise = null;
  let lastRefreshStartedAt = 0;
  const refreshMinIntervalMs = normalizeTimeout(options.refreshMinIntervalMs, 500);
  let closed = false;

  async function callPlain(method, params = {}, callOptions = {}) {
    assertPlainData(params, `${method} params`);
    const result = await rpc.call(method, clonePlainData(params), callOptions);
    assertPlainData(result, `${method} result`);
    return clonePlainData(result);
  }

  function refresh(refreshOptions = {}) {
    if (closed) return Promise.resolve();
    if (refreshPromise) return refreshPromise;
    const timeoutMs = normalizeTimeout(refreshOptions.timeoutMs, DEFAULT_REFRESH_TIMEOUT_MS);
    lastRefreshStartedAt = Date.now();
    refreshPromise = Promise.allSettled([
      callPlain('chatgpt.status', {}, { timeoutMs }).then(updateStatusCache),
      callPlain('chatgpt.getSelection', {}, { timeoutMs }).then(updateSelectionCache),
    ]).then(() => undefined).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function request(prompt, requestOptions = {}) {
    if (closed) throw new Error('Embed bridge proxy is closed.');
    const controller = new AbortController();
    const externalSignal = requestOptions.signal;
    const onAbort = () => controller.abort(externalSignal?.reason ?? 'cancelled');
    if (externalSignal) {
      externalSignal.addEventListener?.('abort', onAbort, { once: true });
      if (externalSignal.aborted) onAbort();
    }
    activeControllers.add(controller);
    try {
      const params = {
        prompt: normalizePrompt(prompt),
        timeoutMs: normalizeOptionalNumber(requestOptions.timeoutMs),
        sessionKey: normalizeOptionalString(requestOptions.sessionKey, 'sessionKey'),
        model: normalizeOptionalString(requestOptions.model, 'model'),
        reasoning: normalizeOptionalString(requestOptions.reasoning, 'reasoning'),
      };
      const result = await callPlain('chatgpt.request', params, { signal: controller.signal });
      updateRequestCaches(result, params.sessionKey);
      return result;
    } finally {
      activeControllers.delete(controller);
      externalSignal?.removeEventListener?.('abort', onAbort);
    }
  }

  function cancel() {
    for (const controller of activeControllers) controller.abort('cancelled');
    void callPlain('chatgpt.cancel', {}).catch(() => {});
  }

  function capabilities(requestOptions = {}) {
    const callOptions = {};
    if (requestOptions.signal) callOptions.signal = requestOptions.signal;
    if (requestOptions.timeoutMs != null) callOptions.timeoutMs = requestOptions.timeoutMs;
    return callPlain('chatgpt.capabilities', {}, callOptions);
  }

  function getSelection() {
    scheduleRefresh();
    return clonePlainData(selectionCache);
  }

  async function setSelection(selection, requestOptions = {}) {
    assertPlainData(selection ?? {}, 'chatgpt.setSelection selection');
    if (selection != null && !isPlainRecord(selection)) throw new TypeError('chatgpt.setSelection selection must be a plain object.');
    const params = {
      model: normalizeOptionalString(selection?.model, 'model'),
      reasoning: normalizeOptionalString(selection?.reasoning, 'reasoning'),
    };
    const callOptions = {};
    if (requestOptions.signal) callOptions.signal = requestOptions.signal;
    if (requestOptions.timeoutMs != null) callOptions.timeoutMs = requestOptions.timeoutMs;
    const result = await callPlain('chatgpt.setSelection', params, callOptions);
    updateSelectionCache(result == null ? params : result);
    return result;
  }

  function status() {
    scheduleRefresh();
    return clonePlainData(statusCache);
  }

  function conversationFor(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    if (!key) return null;
    if (!conversationCache.has(key)) void refreshConversation(key);
    return conversationCache.has(key) ? clonePlainData(conversationCache.get(key)) : null;
  }

  function scheduleRefresh() {
    if (closed || refreshPromise) return;
    if (Date.now() - lastRefreshStartedAt < refreshMinIntervalMs) return;
    void refresh();
  }

  function refreshConversation(sessionKey, refreshOptions = {}) {
    if (closed || !sessionKey) return Promise.resolve(null);
    if (conversationRefreshes.has(sessionKey)) return conversationRefreshes.get(sessionKey);
    const timeoutMs = normalizeTimeout(refreshOptions.timeoutMs, DEFAULT_REFRESH_TIMEOUT_MS);
    const pending = callPlain('chatgpt.conversationFor', { sessionKey }, { timeoutMs })
      .then((value) => {
        conversationCache.set(sessionKey, clonePlainData(value ?? null));
        return value ?? null;
      })
      .catch(() => conversationCache.get(sessionKey) ?? null)
      .finally(() => conversationRefreshes.delete(sessionKey));
    conversationRefreshes.set(sessionKey, pending);
    return pending;
  }

  function close(reason = 'Embed bridge proxy closed.') {
    if (closed) return;
    closed = true;
    for (const controller of activeControllers) controller.abort(reason);
    activeControllers.clear();
    conversationRefreshes.clear();
    rpc.close?.(reason);
  }

  function requestUiClose(requestOptions = {}) {
    const callOptions = {};
    if (requestOptions.signal) callOptions.signal = requestOptions.signal;
    if (requestOptions.timeoutMs != null) callOptions.timeoutMs = requestOptions.timeoutMs;
    return callPlain('ui.close', {}, callOptions);
  }

  function updateStatusCache(value) {
    if (value == null) return statusCache;
    assertPlainData(value, 'chatgpt.status result');
    if (!isPlainRecord(value)) throw new TypeError('chatgpt.status result must be a plain object.');
    statusCache = { ...clonePlainData(SAFE_STATUS), ...clonePlainData(value) };
    if (Object.prototype.hasOwnProperty.call(value, 'selection')) updateSelectionCache(value.selection);
    return statusCache;
  }

  function updateSelectionCache(value) {
    assertPlainData(value, 'chatgpt selection');
    selectionCache = clonePlainData(value ?? null);
    return selectionCache;
  }

  function updateRequestCaches(result, sessionKey) {
    if (!isPlainRecord(result)) return;
    if (Object.prototype.hasOwnProperty.call(result, 'selection')) updateSelectionCache(result.selection);
    if (sessionKey && Object.prototype.hasOwnProperty.call(result, 'conversation')) {
      conversationCache.set(String(sessionKey), clonePlainData(result.conversation ?? null));
    }
    if (Object.prototype.hasOwnProperty.call(result, 'conversation')) {
      statusCache = { ...statusCache, conversation: clonePlainData(result.conversation ?? null) };
    }
    if (Object.prototype.hasOwnProperty.call(result, 'selection')) {
      statusCache = { ...statusCache, selection: clonePlainData(result.selection ?? null) };
    }
  }

  return Object.freeze({
    request,
    cancel,
    capabilities,
    getSelection,
    setSelection,
    status,
    conversationFor,
    refresh,
    requestUiClose,
    close,
    get closed() { return closed; },
  });
}

export function assertPlainData(value, label = 'value') {
  if (!isPlainData(value)) throw new TypeError(`${label} must contain plain data only.`);
  return value;
}

export function isPlainData(value) {
  return inspectPlainData(value, new WeakSet(), 0);
}

export function clonePlainData(value) {
  assertPlainData(value);
  return cloneCheckedPlainData(value);
}

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PLAIN_DEPTH = 64;

function inspectPlainData(value, seen, depth) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object' || depth >= MAX_PLAIN_DEPTH) return false;
  if (isBinaryLike(value) || isDomNode(value) || seen.has(value)) return false;

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    seen.add(value);
    try {
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
        const descriptor = descriptors[key];
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
        if (!inspectPlainData(descriptor.value, seen, depth + 1)) return false;
      }
      return true;
    } finally {
      seen.delete(value);
    }
  }

  if (!isPlainRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (isDomLikeRecord(descriptors)) return false;
  seen.add(value);
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) return false;
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
      if (!inspectPlainData(descriptor.value, seen, depth + 1)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function cloneCheckedPlainData(value) {
  if (value === null || typeof value !== 'object') return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue;
      out[Number(key)] = cloneCheckedPlainData(descriptors[key].value);
    }
    return out;
  }
  const out = {};
  for (const key of Object.keys(descriptors)) {
    Object.defineProperty(out, key, {
      value: cloneCheckedPlainData(descriptors[key].value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBinaryLike(value) {
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return true;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(value)) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof File !== 'undefined' && value instanceof File) return true;
  return false;
}

function isDomNode(value) {
  return typeof Node !== 'undefined' && value instanceof Node;
}

function isDomLikeRecord(descriptors) {
  const nodeType = descriptors.nodeType?.value;
  const nodeName = descriptors.nodeName?.value;
  return typeof nodeType === 'number' && typeof nodeName === 'string';
}

function normalizePrompt(value) {
  if (value == null) return '';
  const type = typeof value;
  if (type === 'string' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError('Embed bridge prompt must be string-normalizable scalar data.');
}

function normalizeOptionalString(value, field) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  throw new TypeError(`Embed bridge ${field} must be a string or null.`);
}

function normalizeOptionalNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError('Embed bridge timeout must be a finite positive number.');
  return number;
}

function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeSessionKey(value) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

export { SAFE_STATUS as EMBED_SAFE_STATUS };
export default createEmbedBridgeProxy;
