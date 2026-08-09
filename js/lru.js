/** Insertion-ordered LRU on top of Map. Bounded so memory cannot creep up. */
export class LRU {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
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
