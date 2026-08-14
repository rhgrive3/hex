import { DEBUG_PROTOCOL_VERSION, DebugAdapterError, boundedInteger } from './adapter.js';

const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_ARRAY = 65536;
const ALLOWED_TYPES = new Set(['hello','request','response','event','cancel']);
const BLOCKED_METHODS = /^(exec|shell|spawn|system|hostCommand|runCommand)$/i;

function jsonSize(value) {
  try { return JSON.stringify(value, (_,v) => typeof v === 'bigint' ? v.toString() : v).length; }
  catch { throw new DebugAdapterError('malformed-packet', 'remote packet is not serializable'); }
}

function validateValue(value, depth = 0) {
  if (depth > 20) throw new DebugAdapterError('malformed-packet', 'remote packet nesting is too deep');
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new DebugAdapterError('malformed-packet', 'remote array exceeds limit');
    for (const v of value) validateValue(v, depth + 1);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 1024) throw new DebugAdapterError('malformed-packet', 'remote object has too many fields');
    for (const k of keys) { if (k.length > 256) throw new DebugAdapterError('malformed-packet', 'remote field name is too long'); validateValue(value[k], depth + 1); }
  } else if (typeof value === 'string' && value.length > MAX_PACKET_BYTES) throw new DebugAdapterError('malformed-packet', 'remote string exceeds limit');
}

export function validateRemotePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new DebugAdapterError('malformed-packet', 'remote packet must be an object');
  if (!ALLOWED_TYPES.has(packet.type)) throw new DebugAdapterError('malformed-packet', 'invalid remote packet type');
  if (packet.version !== DEBUG_PROTOCOL_VERSION) throw new DebugAdapterError('protocol-version', `unsupported remote protocol version: ${packet.version}`);
  if (jsonSize(packet) > MAX_PACKET_BYTES) throw new DebugAdapterError('packet-too-large', 'remote packet exceeds 1 MiB');
  validateValue(packet);
  if (packet.method && BLOCKED_METHODS.test(String(packet.method))) throw new DebugAdapterError('blocked-method', 'host command execution is prohibited');
  if ((packet.type === 'request' || packet.type === 'response' || packet.type === 'cancel') && !Number.isSafeInteger(packet.id)) throw new DebugAdapterError('malformed-packet', 'request id must be a safe integer');
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
  setEpoch(epoch) { this.epoch = Number(epoch) || 0; }
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async sendPacket(packet) { validateRemotePacket(packet); await this.transport.send(packet); }
  request(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new DebugAdapterError('disconnected', 'remote protocol is closed'));
    if (BLOCKED_METHODS.test(String(method))) return Promise.reject(new DebugAdapterError('blocked-method', 'host command execution is prohibited'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new DebugAdapterError('backpressure', 'too many pending remote requests'));
    const id = this.nextId++;
    const epoch = options.epoch == null ? this.epoch : Number(options.epoch);
    const timeoutMs = boundedInteger(options.timeoutMs, this.timeoutMs, 10, 60000, 'timeoutMs');
    const packet = { version:DEBUG_PROTOCOL_VERSION, type:'request', id, epoch, method:String(method), params };
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DebugAdapterError('timeout', `remote request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, epoch, method:String(method) });
      this.sendPacket(packet).catch((err) => { clearTimeout(timer); this.pending.delete(id); reject(err); });
      if (options.signal) {
        if (options.signal.aborted) this.cancel(id, 'cancelled');
        else options.signal.addEventListener('abort', () => this.cancel(id, 'cancelled'), { once:true });
      }
    });
  }
  async cancel(id, reason = 'cancelled') {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer); this.pending.delete(id);
    pending.reject(new DebugAdapterError('cancelled', reason));
    try { await this.sendPacket({ version:DEBUG_PROTOCOL_VERSION, type:'cancel', id, epoch:pending.epoch, reason:String(reason).slice(0,256) }); } catch { /* best effort */ }
    return true;
  }
  receive(raw) {
    let packet;
    try { packet = validateRemotePacket(raw); } catch { return false; }
    if (packet.epoch != null && Number(packet.epoch) !== this.epoch) return false;
    if (packet.type === 'response') {
      const p = this.pending.get(packet.id);
      if (!p || p.epoch !== this.epoch) return false;
      clearTimeout(p.timer); this.pending.delete(packet.id);
      if (packet.error) p.reject(new DebugAdapterError(String(packet.error.code || 'remote-error'), String(packet.error.message || 'remote error').slice(0,2048), packet.error.details || null));
      else p.resolve(packet.result);
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
    for (const [id,p] of this.pending) { clearTimeout(p.timer); p.reject(new DebugAdapterError('disconnected', reason)); this.pending.delete(id); }
    if (typeof this.transport.close === 'function') { try { this.transport.close(); } catch { /* ignore */ } }
  }
}
