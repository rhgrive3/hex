import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { decodeWireValue, encodeWireValue } from '../debug/remote-protocol.js';
import { RUNTIME_FACETS } from './provider.js';
import { createRuntimeEventBatch } from './events.js';

export const RUNTIME_PROVIDER_PROTOCOL = 'hex-runtime-provider';
export const RUNTIME_PROVIDER_PROTOCOL_VERSION = 1;

const TYPES = new Set(['hello', 'hello-ack', 'request', 'response', 'event-batch', 'cancel', 'error', 'close']);
const METHOD_NAMESPACE = /^(runtime\.(session|target|events)\.|debugger\.|instrumentation\.|trace\.|emulator\.)[a-zA-Z0-9_.:-]+$/;
const BLOCKED_METHODS = /(^|\.)(exec|shell|spawn|system|hostCommand|runCommand)(\.|$)/i;
const MAX_PACKET_BYTES = 1024 * 1024;

function byteSize(value) {
  const json = JSON.stringify(encodeWireValue(value));
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).byteLength : json.length * 2;
}

function positiveId(value, name = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new DebugAdapterError('malformed-provider-data', `${name} must be a positive safe integer`);
  return n;
}

function epoch(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new DebugAdapterError('malformed-provider-data', 'provider epoch must be a positive safe integer');
  return n;
}

function facet(value) {
  if (value == null) return null;
  const normalized = String(value);
  if (!RUNTIME_FACETS.includes(normalized)) throw new DebugAdapterError('protocol-mismatch', `unknown runtime facet: ${normalized}`);
  return normalized;
}

function validateMethod(method, packetFacet = null) {
  const text = String(method ?? '');
  if (!text || text.length > 160 || !METHOD_NAMESPACE.test(text)) throw new DebugAdapterError('protocol-mismatch', `invalid provider method namespace: ${text || '<empty>'}`);
  if (BLOCKED_METHODS.test(text)) throw new DebugAdapterError('permission-denied', 'host command execution is prohibited');
  const namespace = text.split('.')[0];
  if (packetFacet && namespace !== packetFacet && namespace !== 'runtime') {
    throw new DebugAdapterError('protocol-mismatch', `provider method ${text} does not belong to facet ${packetFacet}`);
  }
  return text;
}

function normalizeFacetList(value) {
  if (!Array.isArray(value)) throw new DebugAdapterError('malformed-provider-data', 'facets must be an array');
  const out = [...new Set(value.map(String))];
  for (const item of out) facet(item);
  return out.sort();
}

export function validateProviderPacket(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DebugAdapterError('malformed-provider-data', 'provider packet must be an object');
  const packet = decodeWireValue(encodeWireValue(input));
  if (packet.protocol !== RUNTIME_PROVIDER_PROTOCOL) throw new DebugAdapterError('protocol-mismatch', 'invalid runtime provider protocol identity');
  if (packet.version !== RUNTIME_PROVIDER_PROTOCOL_VERSION) throw new DebugAdapterError('protocol-mismatch', `unsupported runtime provider protocol version: ${packet.version}`);
  if (!TYPES.has(packet.type)) throw new DebugAdapterError('malformed-provider-data', `invalid runtime provider packet type: ${packet.type}`);
  if (byteSize(packet) > MAX_PACKET_BYTES) throw new DebugAdapterError('resource-limit', 'runtime provider packet exceeds 1 MiB');

  if (packet.type === 'hello' || packet.type === 'hello-ack') {
    if (typeof packet.providerId !== 'string' || !packet.providerId.trim()) throw new DebugAdapterError('malformed-provider-data', 'provider hello requires providerId');
    if (typeof packet.providerVersion !== 'string' || !packet.providerVersion.trim()) throw new DebugAdapterError('malformed-provider-data', 'provider hello requires providerVersion');
    normalizeFacetList(packet.facets || []);
    return packet;
  }

  if (packet.type !== 'close') packet.epoch = epoch(packet.epoch);
  if (['request', 'response', 'cancel', 'error'].includes(packet.type)) packet.id = positiveId(packet.id);
  if (packet.type === 'request') {
    packet.facet = facet(packet.facet);
    packet.method = validateMethod(packet.method, packet.facet);
  }
  if (packet.type === 'event-batch') {
    packet.facet = facet(packet.facet);
    packet.batch = createRuntimeEventBatch(packet.batch);
  }
  return packet;
}

export function createProviderHello(descriptor, extra = {}) {
  return validateProviderPacket({
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type: 'hello',
    providerId: String(descriptor.id),
    providerVersion: String(descriptor.version ?? '1'),
    facets: Array.from(descriptor.facets || []),
    capabilities: descriptor.capabilities || {},
    architecture: extra.architecture ?? null,
    platform: extra.platform ?? null,
    maxPacketBytes: MAX_PACKET_BYTES,
    supportsCancellation: true,
    supportsEventBatches: true,
  });
}

export function negotiateProviderHello(localDescriptor, remoteHello) {
  const remote = validateProviderPacket(remoteHello);
  if (remote.type !== 'hello' && remote.type !== 'hello-ack') throw new DebugAdapterError('protocol-mismatch', 'provider negotiation requires hello packet');
  const localFacets = new Set(localDescriptor.facets || []);
  const facets = remote.facets.filter((name) => localFacets.has(name));
  return Object.freeze({
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    localProviderId: String(localDescriptor.id),
    remoteProviderId: remote.providerId,
    remoteProviderVersion: remote.providerVersion,
    facets: Object.freeze(facets),
    capabilities: remote.capabilities || {},
    architecture: remote.architecture ?? null,
    platform: remote.platform ?? null,
    supportsCancellation: remote.supportsCancellation === true,
    supportsEventBatches: remote.supportsEventBatches === true,
  });
}

export class RuntimeProviderProtocolClient {
  constructor(transport, options = {}) {
    if (!transport || typeof transport.send !== 'function') throw new DebugAdapterError('provider-transport', 'provider transport.send is required');
    this.transport = transport;
    this.timeoutMs = boundedInteger(options.timeoutMs, 5000, 10, 60000, 'timeoutMs');
    this.maxPending = boundedInteger(options.maxPending, 128, 1, 1024, 'maxPending');
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.epoch = 1;
    this.closed = false;
    this.unsubscribe = typeof transport.onMessage === 'function' ? transport.onMessage((packet) => this.receive(packet)) : null;
  }

  setEpoch(next) {
    const value = epoch(next);
    if (value === this.epoch) return value;
    this.epoch = value;
    for (const [id, pending] of this.pending) {
      this.#finish(id, pending, new DebugAdapterError('cancelled', 'provider request invalidated by epoch change'));
    }
    return value;
  }

  onEvent(listener) {
    if (typeof listener !== 'function') throw new DebugAdapterError('provider-listener', 'provider event listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(method, payload = null, options = {}) {
    if (this.closed) throw new DebugAdapterError('disconnected', 'provider protocol client is closed');
    if (this.pending.size >= this.maxPending) throw new DebugAdapterError('backpressure', 'provider pending request limit reached');
    const id = this.#allocateId();
    const packet = validateProviderPacket({
      protocol: RUNTIME_PROVIDER_PROTOCOL,
      version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
      type: 'request',
      id,
      epoch: this.epoch,
      facet: options.facet ?? null,
      method,
      payload,
    });
    const timeoutMs = boundedInteger(options.timeoutMs, this.timeoutMs, 10, 60000, 'timeoutMs');
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, signal: options.signal, abort: null, timer: null, epoch: this.epoch };
      pending.timer = setTimeout(() => {
        this.#finish(id, pending, new DebugAdapterError('timeout', `provider request timed out: ${method}`));
        try { this.transport.send(validateProviderPacket({ protocol: RUNTIME_PROVIDER_PROTOCOL, version: 1, type: 'cancel', id, epoch: pending.epoch })); } catch {}
      }, timeoutMs);
      if (options.signal) {
        pending.abort = () => {
          this.#finish(id, pending, new DebugAdapterError('cancelled', `provider request cancelled: ${method}`));
          try { this.transport.send(validateProviderPacket({ protocol: RUNTIME_PROVIDER_PROTOCOL, version: 1, type: 'cancel', id, epoch: pending.epoch })); } catch {}
        };
        if (options.signal.aborted) return pending.abort();
        options.signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      try { this.transport.send(packet); }
      catch (error) { this.#finish(id, pending, error); }
    });
  }

  receive(input) {
    let packet;
    try { packet = validateProviderPacket(input); }
    catch { return false; }
    if (packet.type === 'event-batch') {
      if (packet.epoch !== this.epoch) return false;
      for (const listener of [...this.listeners]) { try { listener(packet.batch, packet); } catch {} }
      return true;
    }
    if (!['response', 'error'].includes(packet.type)) return false;
    const pending = this.pending.get(packet.id);
    if (!pending || packet.epoch !== pending.epoch || packet.epoch !== this.epoch) return false;
    if (packet.type === 'error') this.#finish(packet.id, pending, new DebugAdapterError(packet.code || 'provider-failure', packet.message || 'provider request failed', packet.details || null));
    else this.#finish(packet.id, pending, null, packet.result);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) this.#finish(id, pending, new DebugAdapterError('disconnected', 'provider protocol client closed'));
    if (typeof this.unsubscribe === 'function') { try { this.unsubscribe(); } catch {} }
    this.unsubscribe = null;
    this.listeners.clear();
  }

  #allocateId() {
    if (this.nextId > Number.MAX_SAFE_INTEGER) this.nextId = 1;
    while (this.pending.has(this.nextId)) this.nextId++;
    return this.nextId++;
  }

  #finish(id, pending, error = null, value = undefined) {
    if (!this.pending.has(id) && pending.timer == null) return;
    clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort);
    this.pending.delete(id);
    if (error) pending.reject(error); else pending.resolve(value);
  }
}
