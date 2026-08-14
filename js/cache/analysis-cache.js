export const ANALYSIS_CACHE_SCHEMA = 1;
const ALLOWED_FIELDS = new Set(['formatMetadata', 'functionSeeds', 'stringsIndex', 'imports', 'analysisSummaries']);

export class AnalysisCache {
  constructor(options = {}) {
    this.schemaVersion = options.schemaVersion ?? ANALYSIS_CACHE_SCHEMA;
    this.dbName = options.dbName || 'hex-analysis-cache';
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.memory = options.memory || (!this.indexedDB ? new Map() : null);
    this._db = null;
  }

  key(hash) { return `${this.schemaVersion}:${hash}`; }

  async get(hash) {
    if (!hash) return null;
    const record = this.memory ? this.memory.get(this.key(hash)) || null : await this.#idbGet(this.key(hash));
    if (!record) return null;
    if (record.schemaVersion !== this.schemaVersion || record.binaryHash !== hash) {
      await this.delete(hash);
      return null;
    }
    return structuredCloneSafe(record.data);
  }

  async put(hash, data = {}) {
    if (!hash) throw new TypeError('binary hash is required');
    const clean = {};
    for (const [key, value] of Object.entries(data)) if (ALLOWED_FIELDS.has(key)) clean[key] = value;
    // IndexedDB clones values on put, but the in-memory fallback does not. Take
    // the same snapshot here so caller-owned arrays/maps cannot mutate a cached
    // analysis after it has been stored.
    const snapshot = structuredCloneSafe(clean);
    const record = { key: this.key(hash), schemaVersion: this.schemaVersion, binaryHash: hash, updatedAt: Date.now(), data: snapshot };
    if (this.memory) this.memory.set(record.key, record);
    else await this.#idbPut(record);
    return structuredCloneSafe(snapshot);
  }

  async delete(hash) {
    const key = this.key(hash);
    if (this.memory) { this.memory.delete(key); return; }
    const db = await this.#db();
    await requestPromise(db.transaction('entries', 'readwrite').objectStore('entries').delete(key));
  }

  async invalidateStale() {
    if (this.memory) {
      let removed = 0;
      for (const [key, record] of this.memory) {
        if (record.schemaVersion !== this.schemaVersion || !key.startsWith(`${this.schemaVersion}:`)) { this.memory.delete(key); removed++; }
      }
      return removed;
    }
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      let removed = 0;
      const tx = db.transaction('entries', 'readwrite');
      const req = tx.objectStore('entries').openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (cursor.value?.schemaVersion !== this.schemaVersion) { cursor.delete(); removed++; }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear() {
    if (this.memory) { this.memory.clear(); return; }
    const db = await this.#db();
    await requestPromise(db.transaction('entries', 'readwrite').objectStore('entries').clear());
  }

  async #db() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = this.indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  async #idbGet(key) {
    const db = await this.#db();
    return requestPromise(db.transaction('entries', 'readonly').objectStore('entries').get(key));
  }

  async #idbPut(record) {
    const db = await this.#db();
    await requestPromise(db.transaction('entries', 'readwrite').objectStore('entries').put(record));
  }
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function fallbackClone(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return value.slice ? value.slice() : new value.constructor(value);
  }
  if (value instanceof Map) {
    const out = new Map(); seen.set(value, out);
    for (const [k, v] of value) out.set(fallbackClone(k, seen), fallbackClone(v, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set(); seen.set(value, out);
    for (const v of value) out.add(fallbackClone(v, seen));
    return out;
  }
  if (Array.isArray(value)) {
    const out = []; seen.set(value, out);
    for (const v of value) out.push(fallbackClone(v, seen));
    return out;
  }
  const out = {}; seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = fallbackClone(v, seen);
  return out;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return fallbackClone(value);
}
