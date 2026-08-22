/** Insertion-ordered LRU on top of Map. Bounded so memory cannot creep up. */
export class LRU {
  constructor(limit) {
    const numericLimit = Number(limit);
    if (!Number.isFinite(numericLimit) || numericLimit < 0 || numericLimit > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('LRU limit must be a finite non-negative safe integer');
    }
    this.limit = Math.floor(numericLimit);
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  has(key) { return this.map.has(key); }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}
