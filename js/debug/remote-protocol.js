import { DEBUG_PROTOCOL_VERSION, DebugAdapterError, boundedInteger } from './adapter.js';

const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_ARRAY = 65536;
const ALLOWED_TYPES = new Set(['hello','request','response','event','cancel']);
const BLOCKED_METHODS = /^(exec|shell|spawn|system|hostCommand|runCommand)$/i;
export const WIRE_TAG = '__hex_wire_type__';
export const BIGINT_TAG = 'bigint';
export const BYTES_TAG = 'bytes-base64';

function jsonByteSize(value) {
  let json;
  try { json = JSON.stringify(value); }
  catch { throw new DebugAdapterError('malformed-packet', 'remote packet is not serializable'); }
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).byteLength;
  return json.length * 2;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  if (typeof btoa !== 'function') throw new DebugAdapterError('encoding-unavailable', 'base64 encoder is unavailable');
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function base64ToBytes(text) {
  try {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(text, 'base64');
      if (buf.toString('base64') !== String(text)) throw new Error('non-canonical');
      return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    if (typeof atob !== 'function') throw new Error('decoder unavailable');
    const binary = atob(text);
    if (btoa(binary) !== String(text)) throw new Error('non-canonical');
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    throw new DebugAdapterError('malformed-packet', 'invalid base64 byte payload');
  }
}

export function encodeWireValue(value, depth = 0) {
  if (depth > 20) throw new DebugAdapterError('malformed-packet', 'remote packet nesting is too deep');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DebugAdapterError('malformed-packet', 'remote packet numbers must be finite');
    return value;
  }
  if (typeof value === 'bigint') return { [WIRE_TAG]: BIGINT_TAG, value: value.toString(10) };
  if (value instanceof Uint8Array) return { [WIRE_TAG]: BYTES_TAG, value: bytesToBase64(value), length: value.byteLength };
  if (ArrayBuffer.isView(value)) {
    return { [WIRE_TAG]: BYTES_TAG, value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), length: value.byteLength };
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new DebugAdapterError('malformed-packet', 'remote array exceeds limit');
    return value.map((v) => encodeWireValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new DebugAdapterError('malformed-packet', 'remote packet objects must be plain data');
    const keys = Object.keys(value);
    if (keys.length > 1024) throw new DebugAdapterError('malformed-packet', 'remote object has too many fields');
    const out = {};
    for (const key of keys) {
      if (key === WIRE_TAG) throw new DebugAdapterError('malformed-packet', `remote packet contains reserved field: ${WIRE_TAG}`);
      if (key.length > 256) throw new DebugAdapterError('malformed-packet', 'remote field name is too long');
      const field = value[key];
      if (field === undefined || typeof field === 'function' || typeof field === 'symbol') throw new DebugAdapterError('malformed-packet', `remote field is not serializable: ${key}`);
      Object.defineProperty(out, key, { value: encodeWireValue(field, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  throw new DebugAdapterError('malformed-packet', 'remote packet contains an unsupported value');
}

export function decodeWireValue(value, depth = 0) {
  if (depth > 20) throw new DebugAdapterError('malformed-packet', 'remote packet nesting is too deep');
  if (Array.isArray(value)) return value.map((v) => decodeWireValue(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  if (value[WIRE_TAG] === BIGINT_TAG) {
    if (Object.keys(value).some((k) => ![WIRE_TAG, 'value'].includes(k)) || !/^-?\d+$/.test(String(value.value || ''))) {
      throw new DebugAdapterError('malformed-packet', 'invalid bigint wire value');
    }
    return BigInt(value.value);
  }
  if (value[WIRE_TAG] === BYTES_TAG) {
    if (Object.keys(value).some((k) => ![WIRE_TAG, 'value', 'length'].includes(k)) || typeof value.value !== 'string') {
      throw new DebugAdapterError('malformed-packet', 'invalid byte wire value');
    }
    const out = base64ToBytes(value.value);
    if (!Number.isSafeInteger(value.length) || value.length < 0 || value.length !== out.byteLength || out.byteLength > MAX_PACKET_BYTES) {
      throw new DebugAdapterError('malformed-packet', 'byte payload length mismatch');
    }
    return out;
  }
  const out = {};
  for (const [key, field] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: decodeWireValue(field, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function validateValue(value, depth = 0) {
  if (depth > 20) throw new DebugAdapterError('malformed-packet', 'remote packet nesting is too deep');
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new DebugAdapterError('malformed-packet', 'remote array exceeds limit');
    for (const v of value) validateValue(v, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new DebugAdapterError('malformed-packet', 'remote packet objects must be plain data');
    const keys = Object.keys(value);
    if (keys.length > 1024) throw new DebugAdapterError('malformed-packet', 'remote object has too many fields');
    for (const key of keys) {
      if (key.length > 256) throw new DebugAdapterError('malformed-packet', 'remote field name is too long');
      validateValue(value[key], depth + 1);
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_PACKET_BYTES) throw new DebugAdapterError('malformed-packet', 'remote string exceeds limit');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DebugAdapterError('malformed-packet', 'remote packet numbers must be finite');
    return;
  }
  if (value == null || typeof value === 'boolean') return;
  throw new DebugAdapterError('malformed-packet', 'remote packet contains a non-wire value');
}

function validateEpoch(packet) {
  if (packet.type === 'hello') return;
  if (!Number.isSafeInteger(packet.epoch) || packet.epoch < 0) throw new DebugAdapterError('malformed-packet', 'packet epoch must be a non-negative safe integer');
}

export function validateRemotePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new DebugAdapterError('malformed-packet', 'remote packet must be an object');
  if (!ALLOWED_TYPES.has(packet.type)) throw new DebugAdapterError('malformed-packet', 'invalid remote packet type');
  if (packet.version !== DEBUG_PROTOCOL_VERSION) throw new DebugAdapterError('protocol-version', `unsupported remote protocol version: ${packet.version}`);
  validateValue(packet);
  if (jsonByteSize(packet) > MAX_PACKET_BYTES) throw new DebugAdapterError('packet-too-large', 'remote packet exceeds 1 MiB');
  validateEpoch(packet);
  if (packet.method && BLOCKED_METHODS.test(String(packet.method))) throw new DebugAdapterError('blocked-method', 'host command execution is prohibited');
  if ((packet.type === 'request' || packet.type === 'response' || packet.type === 'cancel') && (!Number.isSafeInteger(packet.id) || packet.id < 1)) throw new DebugAdapterError('malformed-packet', 'request id must be a positive safe integer');
  if (packet.type === 'request') {
    const method = String(packet.method || '');
    if (!method || method.length > 128) throw new DebugAdapterError('malformed-packet', 'request method must be 1..128 characters');
  }
  return packet;
}

export class RemoteProtocolClient {
  constructor(transport, options = {}) {
    if (!transport || typeof transport.send !== 'function') throw new DebugAdapterError('transport', 'transport.send is required');
    this.transport = transport;
    this.timeoutMs = boundedInteger(options.timeoutMs, 5000, 10, 60000, 'timeoutMs');
    this.maxPending = boundedInteger(options.maxPending, 128, 1, 1024, 'maxPending');
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.maxEventsPerSecond = boundedInteger(options.maxEventsPerSecond, 256, 1, 10000, 'maxEventsPerSecond');
    this.maxEventBytesPerSecond = boundedInteger(options.maxEventBytesPerSecond, 4 * 1024 * 1024, 1024, 64 * 1024 * 1024, 'maxEventBytesPerSecond');
    this.eventWindowStart = Date.now(); this.eventWindowCount = 0; this.eventWindowBytes = 0; this.droppedEvents = 0;
    this.epoch = 0;
    this.closed = false;
    this.unsubscribe = typeof transport.onMessage === 'function' ? transport.onMessage((packet) => this.receive(packet)) : null;
  }
  _cleanupPending(id, pending) {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
    this.pending.delete(id);
  }
  _allocateId() {
    if (this.nextId > Number.MAX_SAFE_INTEGER) this.nextId = 1;
    while (this.pending.has(this.nextId)) {
      this.nextId++;
      if (this.nextId > Number.MAX_SAFE_INTEGER) this.nextId = 1;
    }
    return this.nextId++;
  }
  setEpoch(epoch) {
    const next = Number(epoch);
    if (!Number.isSafeInteger(next) || next < 0) throw new DebugAdapterError('invalid-epoch', 'epoch must be a non-negative safe integer');
    if (next === this.epoch) return this.epoch;
    const previous = this.epoch;
    this.epoch = next;
    for (const [id, pending] of [...this.pending]) {
      if (pending.epoch === next) continue;
      this._cleanupPending(id, pending);
      pending.reject(new DebugAdapterError('stale-request', 'request invalidated by session epoch change'));
      // Lifecycle packets must use the current epoch so the peer accepts them.
      // requestEpoch preserves which generation the cancelled request belonged to.
      this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch:next, requestEpoch:pending.epoch, reason:'session-epoch-changed' }).catch(() => {});
    }
    return previous === next ? previous : this.epoch;
  }
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async sendPacket(packet) {
    const encoded = encodeWireValue(packet);
    validateRemotePacket(encoded);
    await this.transport.send(encoded);
  }
  request(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new DebugAdapterError('disconnected', 'remote protocol is closed'));
    if (BLOCKED_METHODS.test(String(method))) return Promise.reject(new DebugAdapterError('blocked-method', 'host command execution is prohibited'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new DebugAdapterError('backpressure', 'too many pending remote requests'));
    if (options.signal && options.signal.aborted) return Promise.reject(new DebugAdapterError('cancelled', String(options.signal.reason ?? 'cancelled')));
    const id = this._allocateId();
    const epoch = options.epoch == null ? this.epoch : Number(options.epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) return Promise.reject(new DebugAdapterError('invalid-epoch', 'epoch must be a non-negative safe integer'));
    let timeoutMs;
    try { timeoutMs = boundedInteger(options.timeoutMs, this.timeoutMs, 10, 60000, 'timeoutMs'); }
    catch (error) { return Promise.reject(error); }
    const packet = { version:DEBUG_PROTOCOL_VERSION, type:'request', id, epoch, method:String(method), params };
    return new Promise((resolve,reject) => {
      const pending = { resolve, reject, timer:null, epoch, method:String(method), signal:options.signal || null, abortHandler:null };
      pending.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this._cleanupPending(id, pending);
        reject(new DebugAdapterError('timeout', `remote request timed out: ${method}`));
        this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch:this.epoch, requestEpoch:epoch, reason:'timeout' }).catch(() => {});
      }, timeoutMs);
      if (pending.signal) {
        pending.abortHandler = () => this.cancel(id, String(pending.signal.reason ?? 'cancelled'));
        pending.signal.addEventListener('abort', pending.abortHandler, { once:true });
      }
      this.pending.set(id, pending);
      this.sendPacket(packet).catch((err) => {
        if (!this.pending.has(id)) return;
        this._cleanupPending(id, pending);
        reject(err);
      });
    });
  }
  async cancel(id, reason = 'cancelled') {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this._cleanupPending(id, pending);
    pending.reject(new DebugAdapterError('cancelled', reason));
    try { await this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch:this.epoch, requestEpoch:pending.epoch, reason:String(reason).slice(0,256) }); } catch { /* best effort */ }
    return true;
  }
  receive(raw) {
    let wire;
    try { wire = validateRemotePacket(raw); } catch { return false; }
    if (wire.type !== 'hello' && wire.epoch !== this.epoch) return false;
    let packet;
    try { packet = decodeWireValue(wire); } catch { return false; }
    if (packet.type === 'response') {
      const pending = this.pending.get(packet.id);
      if (!pending || pending.epoch !== this.epoch) return false;
      this._cleanupPending(packet.id, pending);
      if (packet.error) pending.reject(new DebugAdapterError(String(packet.error.code || 'remote-error'), String(packet.error.message || 'remote error').slice(0,2048), packet.error.details || null));
      else pending.resolve(packet.result);
      return true;
    }
    if (packet.type === 'event') {
      const now=Date.now();
      if (now-this.eventWindowStart >= 1000) { this.eventWindowStart=now; this.eventWindowCount=0; this.eventWindowBytes=0; this.droppedEvents=0; }
      const bytes=jsonByteSize(packet);
      if (this.eventWindowCount + 1 > this.maxEventsPerSecond || this.eventWindowBytes + bytes > this.maxEventBytesPerSecond) {
        this.droppedEvents++;
        if (this.droppedEvents === 1) {
          const notice={version:DEBUG_PROTOCOL_VERSION,type:'event',epoch:this.epoch,event:'stream-truncated',data:{reason:'event-backpressure'}};
          for (const fn of this.listeners) { try { fn(notice); } catch {} }
        }
        return false;
      }
      this.eventWindowCount++; this.eventWindowBytes+=bytes;
      for (const fn of this.listeners) { try { fn(packet); } catch { /* listener isolation */ } }
      return true;
    }
    return false;
  }
  close(reason = 'disconnected') {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.unsubscribe === 'function') this.unsubscribe();
    for (const [id,pending] of [...this.pending]) {
      this._cleanupPending(id, pending);
      pending.reject(new DebugAdapterError('disconnected', reason));
    }
    this.listeners.clear();
    if (typeof this.transport.close === 'function') { try { this.transport.close(); } catch { /* ignore */ } }
  }
}
