import { boundedInteger } from '../debug/adapter.js';

function estimateBytes(event) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(event, (_,v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }).length * 2;
  }
  catch { return Number.POSITIVE_INFINITY; }
}

function cloneTraceValue(value, state = null, depth = 0) {
  const s = state || { seen: new WeakMap(), nodes: 0 };
  if (value == null || typeof value !== 'object') return value;
  if (depth > 48 || ++s.nodes > 20000) throw new RangeError('trace event is too deeply nested');
  if (s.seen.has(value)) return s.seen.get(value);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return new value.constructor(value);
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Date) return new Date(value.getTime());
  const out = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  s.seen.set(value, out);
  if (Array.isArray(value)) {
    for (const item of value) out.push(cloneTraceValue(item, s, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) out[key] = cloneTraceValue(item, s, depth + 1);
  }
  return out;
}

function publicEvent(event) {
  const copy = cloneTraceValue(event);
  if (copy && typeof copy === 'object') { delete copy.__bytes; delete copy.__aggregateKey; }
  return copy;
}

export class TraceRingBuffer {
  constructor(options = {}) {
    this.maxEvents = boundedInteger(options.maxEvents, 4096, 16, 100000, 'maxEvents');
    this.maxBytes = boundedInteger(options.maxBytes, 2 * 1024 * 1024, 4096, 32 * 1024 * 1024, 'maxBytes');
    this.sampleRate = boundedInteger(options.sampleRate, 1, 1, 100000, 'sampleRate');
    this.filter = typeof options.filter === 'function' ? options.filter : null;
    this.events = [];
    this.bytes = 0;
    this.seen = 0;
    this.dropped = 0;
    this.aggregates = new Map();
  }
  _increment(type) { this.aggregates.set(type, (this.aggregates.get(type) || 0) + 1); }
  _decrement(type) {
    const next = (this.aggregates.get(type) || 0) - 1;
    if (next > 0) this.aggregates.set(type, next); else this.aggregates.delete(type);
  }
  push(event) {
    this.seen++;
    if (this.sampleRate > 1 && ((this.seen - 1) % this.sampleRate)) { this.dropped++; return false; }
    if (this.filter && !this.filter(event)) { this.dropped++; return false; }
    let safe;
    try { safe = event && typeof event === 'object' ? cloneTraceValue(event) : { type:'event', value:event }; }
    catch { this.dropped++; return false; }
    const size = estimateBytes(safe);
    if (size > this.maxBytes) { this.dropped++; return false; }
    const aggregateKey = String(safe.type || 'event').slice(0,128);
    safe.__bytes = size;
    safe.__aggregateKey = aggregateKey;
    this.events.push(safe); this.bytes += size; this._increment(aggregateKey);
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const old = this.events.shift(); this.bytes -= old.__bytes || 0; this._decrement(old.__aggregateKey || 'event'); this.dropped++;
    }
    return true;
  }
  clear() { this.events = []; this.bytes = 0; this.seen = 0; this.dropped = 0; this.aggregates.clear(); }
  snapshot({ limit = this.maxEvents } = {}) {
    const requested = Number(limit);
    const n = Number.isFinite(requested) ? Math.max(0, Math.min(this.events.length, Math.floor(requested))) : this.events.length;
    return { events:this.events.slice(this.events.length - n).map(publicEvent), seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };
  }
}
