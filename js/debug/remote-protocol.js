import { DEBUG_PROTOCOL_VERSION, DebugAdapterError, boundedInteger } from './adapter.js';

const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_ARRAY = 65536;
const ALLOWED_TYPES = new Set(['hello','request','response','event','cancel']);
const BLOCKED_METHODS = /^(exec|shell|spawn|system|hostCommand|runCommand)$/i;

function jsonByteSize(value) {
  let json;
  try { json = JSON.stringify(value); }
  catch { throw new DebugAdapterError('malformed-packet', 'remote packet is not serializable'); }
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).byteLength;
  return json.length * 2;
}

function encodeWireValue(value, depth = 0) {
  if (depth > 20) throw new DebugAdapterError('malformed-packet', 'remote packet nesting is too deep');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DebugAdapterError('malformed-packet', 'remote packet numbers must be finite');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
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
      if (key.length > 256) throw new DebugAdapterError('malformed-packet', 'remote field name is too long');
      const field = value[key];
      if (field === undefined || typeof field === 'function' || typeof field === 'symbol') throw new DebugAdapterError('malformed-packet', `remote field is not serializable: ${key}`);
      out[key] = encodeWireValue(field, depth + 1);
    }
    return out;
  }
  throw new DebugAdapterError('malformed-packet', 'remote packet contains an unsupported value');
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
    this.epoch = next;
    for (const [id, pending] of [...this.pending]) {
      if (pending.epoch === next) continue;
      this._cleanupPending(id, pending);
      pending.reject(new DebugAdapterError('stale-request', 'request invalidated by session epoch change'));
      this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch:pending.epoch, reason:'session-epoch-changed' }).catch(() => {});
    }
    return this.epoch;
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
    if (options.signal && options.signal.aborted) return Promise.reject(new DebugAdapterError('cancelled', String(options.signal.reason || 'cancelled')));
    const id = this._allocateId();
    const epoch = options.epoch == null ? this.epoch : Number(options.epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) return Promise.reject(new DebugAdapterError('invalid-epoch', 'epoch must be a non-negative safe integer'));
    const timeoutMs = boundedInteger(options.timeoutMs, this.timeoutMs, 10, 60000, 'timeoutMs');
    const packet = { version:DEBUG_PROTOCOL_VERSION, type:'request', id, epoch, method:String(method), params };
    return new Promise((resolve,reject) => {
      const pending = { resolve, reject, timer:null, epoch, method:String(method), signal:options.signal || null, abortHandler:null };
      pending.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this._cleanupPending(id, pending);
        reject(new DebugAdapterError('timeout', `remote request timed out: ${method}`));
        this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch, reason:'timeout' }).catch(() => {});
      }, timeoutMs);
      if (pending.signal) {
        pending.abortHandler = () => this.cancel(id, String(pending.signal.reason || 'cancelled'));
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
    try { await this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch:pending.epoch, reason:String(reason).slice(0,256) }); } catch { /* best effort */ }
    return true;
  }
  receive(raw) {
    let packet;
    try { packet = validateRemotePacket(raw); } catch { return false; }
    if (packet.type !== 'hello' && packet.epoch !== this.epoch) return false;
    if (packet.type === 'response') {
      const pending = this.pending.get(packet.id);
      if (!pending || pending.epoch !== this.epoch) return false;
      this._cleanupPending(packet.id, pending);
      if (packet.error) pending.reject(new DebugAdapterError(String(packet.error.code || 'remote-error'), String(packet.error.message || 'remote error').slice(0,2048), packet.error.details || null));
      else pending.resolve(packet.result);
      return true;
    }
    if (packet.type === 'event') {
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
