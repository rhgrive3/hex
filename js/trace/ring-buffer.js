import { boundedInteger } from '../debug/adapter.js';

function estimateBytes(event) {
  try { return Math.min(65536, JSON.stringify(event, (_,v) => typeof v === 'bigint' ? v.toString() : v).length * 2); }
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
  push(event) {
    this.seen++;
    if (this.sampleRate > 1 && ((this.seen - 1) % this.sampleRate)) { this.dropped++; return false; }
    if (this.filter && !this.filter(event)) { this.dropped++; return false; }
    const safe = event && typeof event === 'object' ? { ...event } : { type:'event', value:event };
    const size = estimateBytes(safe);
    safe.__bytes = size;
    this.events.push(safe); this.bytes += size;
    const key = String(safe.type || 'event');
    this.aggregates.set(key, (this.aggregates.get(key) || 0) + 1);
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const old = this.events.shift(); this.bytes -= old.__bytes || 0; this.dropped++;
    }
    return true;
  }
  clear() { this.events = []; this.bytes = 0; this.seen = 0; this.dropped = 0; this.aggregates.clear(); }
  snapshot({ limit = this.maxEvents } = {}) {
    const n = Math.max(0, Math.min(this.events.length, Number(limit) || 0));
    return { events:this.events.slice(this.events.length - n).map(({__bytes,...e}) => e), seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };
  }
}
