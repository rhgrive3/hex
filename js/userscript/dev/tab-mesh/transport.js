import { createSecureId } from './tab-node.js';

export const DEV_TAB_TRANSPORT_PROTOCOL = 'hex-dev-tab-v1';
export const DEV_TAB_CHANNEL = 'hex.dev.worker.v1';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const REPLAY_LIMIT = 4096;
const TOKEN = /^[A-Za-z0-9._:~-]{1,160}$/;

export class DevTabTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DevTabTransportError';
    this.code = code;
  }
}

export async function createBrowserTabTransport(options = {}) {
  const nodeId = String(options.nodeId || '').trim();
  if (!TOKEN.test(nodeId)) throw new TypeError('A valid Hex TabNode id is required.');

  const BroadcastChannelCtor = options.BroadcastChannelCtor || globalThis.BroadcastChannel;
  const cryptoRef = options.cryptoRef || globalThis.crypto;
  if (typeof BroadcastChannelCtor !== 'function') {
    throw failure('transport-failure', 'BroadcastChannel is unavailable.');
  }
  if (!cryptoRef?.subtle || typeof cryptoRef.getRandomValues !== 'function') {
    throw failure('transport-failure', 'WebCrypto is unavailable.');
  }
  if (!options.secret) {
    throw failure('transport-failure', 'The protected Dev Tab Mesh secret is unavailable.');
  }

  const key = await importSecret(options.secret, cryptoRef);
  const channel = new BroadcastChannelCtor(options.channelName || DEV_TAB_CHANNEL);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const pending = new Map();
  const listeners = new Set();
  const replay = new Map();
  let handler = null;
  let closed = false;

  const onMessage = (event) => { void receive(event?.data); };
  if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onMessage);
  else channel.onmessage = onMessage;

  async function request(to, method, params = {}, requestOptions = {}) {
    assertOpen();
    const target = assertToken(to, 'target');
    const operation = assertToken(method, 'method');
    assertPlainData(params);
    const id = createSecureId('mesh', cryptoRef);
    const timeoutMs = normalizeTimeout(requestOptions.timeoutMs, 15000);
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(failure('transport-failure', `Tab transport request timed out: ${operation}`));
        }, timeoutMs);
      }
      pending.set(id, { resolve, reject, timer, method: operation, to: target });
      sendEnvelope({ kind: 'request', id, from: nodeId, to: target, method: operation, payload: params }).catch((error) => {
        const current = pending.get(id);
        if (!current) return;
        pending.delete(id);
        if (current.timer) clearTimeout(current.timer);
        reject(error);
      });
    });
  }

  async function emit(type, payload = {}, { to = '*' } = {}) {
    assertOpen();
    assertPlainData(payload);
    await sendEnvelope({
      kind: 'event',
      id: createSecureId('event', cryptoRef),
      from: nodeId,
      to: assertToken(to, 'target'),
      method: assertToken(type, 'event type'),
      payload,
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Transport listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setRequestHandler(next) {
    if (next != null && typeof next !== 'function') throw new TypeError('Transport request handler must be a function.');
    handler = next;
  }

  function close(reason = 'Tab transport closed.') {
    if (closed) return;
    closed = true;
    if (typeof channel.removeEventListener === 'function') channel.removeEventListener('message', onMessage);
    else if (channel.onmessage === onMessage) channel.onmessage = null;
    try { channel.close(); } catch {}
    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(failure('transport-failure', reason));
    }
    pending.clear();
    listeners.clear();
    replay.clear();
  }

  async function sendEnvelope(body) {
    const plain = { protocol: DEV_TAB_TRANSPORT_PROTOCOL, ...body, sentAt: Number(now()) };
    const encoded = new TextEncoder().encode(JSON.stringify(plain));
    if (encoded.byteLength > MAX_PLAINTEXT_BYTES) {
      throw failure('transport-failure', 'Tab transport payload exceeds the Round 2 limit.');
    }
    const iv = new Uint8Array(12);
    cryptoRef.getRandomValues(iv);
    let cipher;
    try {
      cipher = new Uint8Array(await cryptoRef.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
    } catch {
      throw failure('transport-failure', 'Tab transport encryption failed.');
    }
    try {
      channel.postMessage({ v: 1, iv: b64(iv), data: b64(cipher) });
    } catch {
      throw failure('transport-failure', 'Tab transport send failed.');
    }
  }

  async function receive(wire) {
    if (closed || !isPlainRecord(wire) || wire.v !== 1 || typeof wire.iv !== 'string' || typeof wire.data !== 'string') return;
    let message;
    try {
      const plain = await cryptoRef.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wire.iv) }, key, unb64(wire.data));
      message = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return;
    }
    if (!validMessage(message, now()) || message.from === nodeId || (message.to !== '*' && message.to !== nodeId) || replay.has(message.id)) return;
    remember(message.id, Number(now()));

    if (message.kind === 'response') {
      const current = pending.get(message.id);
      if (!current || current.method !== message.method || (current.to !== '*' && current.to !== message.from)) return;
      pending.delete(message.id);
      if (current.timer) clearTimeout(current.timer);
      if (message.payload?.ok === true) current.resolve(message.payload.result);
      else current.reject(failure(String(message.payload?.code || 'transport-failure'), String(message.payload?.message || 'Worker transport request failed.')));
      return;
    }

    if (message.kind === 'event') {
      const event = Object.freeze({
        type: message.method,
        data: clonePlain(message.payload),
        from: message.from,
        observedAt: new Date(Number(message.sentAt)).toISOString(),
      });
      for (const listener of [...listeners]) {
        try { listener(event); } catch {}
      }
      return;
    }

    if (message.kind !== 'request' || typeof handler !== 'function') return;
    let response;
    try {
      const result = await handler(message.method, clonePlain(message.payload), Object.freeze({
        from: message.from,
        requestId: message.id,
      }));
      assertPlainData(result);
      response = { ok: true, result };
    } catch (error) {
      response = { ok: false, code: safeCode(error?.code), message: safeMessage(error?.message) };
    }
    await sendEnvelope({
      kind: 'response',
      id: message.id,
      from: nodeId,
      to: message.from,
      method: message.method,
      payload: response,
    }).catch(() => {});
  }

  function remember(id, seenAt) {
    replay.set(id, seenAt);
    while (replay.size > REPLAY_LIMIT) replay.delete(replay.keys().next().value);
  }

  function assertOpen() {
    if (closed) throw failure('transport-failure', 'Tab transport is closed.');
  }

  return Object.freeze({
    nodeId,
    request,
    emit,
    subscribe,
    setRequestHandler,
    close,
    get closed() { return closed; },
  });
}

function validMessage(value, currentTime) {
  if (!isPlainRecord(value) || value.protocol !== DEV_TAB_TRANSPORT_PROTOCOL || !['request', 'response', 'event'].includes(value.kind)) return false;
  if (![value.id, value.from, value.to, value.method].every((item) => TOKEN.test(String(item || '')) || item === '*')) return false;
  if (!Number.isFinite(value.sentAt) || Math.abs(Number(currentTime) - value.sentAt) > MAX_CLOCK_SKEW_MS) return false;
  try { assertPlainData(value.payload); } catch { return false; }
  return true;
}

async function importSecret(secret, cryptoRef) {
  const bytes = secret instanceof Uint8Array ? secret : new Uint8Array(secret || []);
  if (bytes.byteLength !== 32) throw failure('transport-failure', 'Dev Tab Mesh secret must be 256 bits.');
  try {
    return await cryptoRef.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch {
    throw failure('transport-failure', 'Dev Tab Mesh key import failed.');
  }
}

function b64(bytes) {
  let raw = '';
  for (const value of bytes) raw += String.fromCharCode(value);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}
function unb64(value) {
  const text = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(text + '='.repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function assertPlainData(value, depth = 0) {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (depth > 16 || typeof value !== 'object') throw new TypeError('Tab transport accepts plain data only.');
  if (Array.isArray(value)) {
    for (const item of value) assertPlainData(item, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) throw new TypeError('Tab transport accepts plain data only.');
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Unsafe transport key.');
    assertPlainData(item, depth + 1);
  }
}
function clonePlain(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function assertToken(value, field) {
  const text = String(value || '');
  if (text !== '*' && !TOKEN.test(text)) throw new TypeError(`Invalid ${field}.`);
  return text;
}
function safeCode(value) { return typeof value === 'string' && /^[a-z0-9.-]{1,64}$/i.test(value) ? value : 'transport-failure'; }
function safeMessage(value) { return typeof value === 'string' && value ? value.slice(0, 512) : 'Worker transport request failed.'; }
function normalizeTimeout(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('Transport timeout must be non-negative.');
  return Math.floor(number);
}
function failure(code, message) { return new DevTabTransportError(code, message); }
