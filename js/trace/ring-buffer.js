import { boundedInteger } from '../debug/adapter.js';

function estimateBytes(event) {
  try { return JSON.stringify(event, (_,v) => typeof v === 'bigint' ? v.toString() : v).length * 2; }
  catch { return 256; }
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
    const safe = event && typeof event === 'object' ? { ...event } : { type:'event', value:event };
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
    return { events:this.events.slice(this.events.length - n).map(({__bytes,__aggregateKey,...e}) => e), seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };
  }
}
