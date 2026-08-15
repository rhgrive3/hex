export const ANALYSIS_CACHE_SCHEMA = 1;
const ALLOWED_FIELDS = new Set(['formatMetadata', 'functionSeeds', 'stringsIndex', 'imports', 'analysisSummaries']);

function stableValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function analysisIdentity(options = {}) {
  const version = String(options.analyzerVersion ?? options.analysisVersion ?? options.buildVersion ?? 'unknown');
  const settings = stableValue(options.semanticOptions ?? options.analysisSettings ?? options.settings ?? {});
  return `${version}:${JSON.stringify(settings)}`;
}

export class AnalysisCache {
  constructor(options = {}) {
    this.schemaVersion = options.schemaVersion ?? ANALYSIS_CACHE_SCHEMA;
    this.dbName = options.dbName || 'hex-analysis-cache';
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.analysisIdentity = analysisIdentity(options);
    this.memory = options.memory || (!this.indexedDB ? new Map() : null);
    this._db = null;
    this._idbFailed = false;
  }

  key(hash) { return `${this.schemaVersion}:${this.analysisIdentity}:${hash}`; }

  #fallback(error) {
    this._idbFailed = true;
    try { this._db?.close?.(); } catch { /* best effort */ }
    this._db = null;
    if (!this.memory) this.memory = new Map();
    this.lastIndexedDBError = error || null;
    return this.memory;
  }

  async get(hash) {
    if (!hash) return null;
    const key = this.key(hash);
    let record;
    if (this.memory) record = this.memory.get(key) || null;
    else {
      try { record = await this.#idbGet(key); }
      catch (error) { this.#fallback(error); record = this.memory.get(key) || null; }
    }
    if (!record) return null;
    if (record.schemaVersion !== this.schemaVersion || record.binaryHash !== hash || record.analysisIdentity !== this.analysisIdentity) {
      await this.delete(hash);
      return null;
    }
    return structuredCloneSafe(record.data);
  }

  async put(hash, data = {}) {
    if (!hash) throw new TypeError('binary hash is required');
    const clean = {};
    for (const [key, value] of Object.entries(data)) if (ALLOWED_FIELDS.has(key)) clean[key] = value;
    const snapshot = structuredCloneSafe(clean);
    const record = { key: this.key(hash), schemaVersion: this.schemaVersion, analysisIdentity: this.analysisIdentity, binaryHash: hash, updatedAt: Date.now(), data: snapshot };
    if (this.memory) this.memory.set(record.key, record);
    else {
      try { await this.#idbPut(record); }
      catch (error) { this.#fallback(error).set(record.key, record); }
    }
    return structuredCloneSafe(snapshot);
  }

  async delete(hash) {
    const key = this.key(hash);
    if (this.memory) { this.memory.delete(key); return; }
    try {
      const db = await this.#db();
      await requestPromise(db.transaction('entries', 'readwrite').objectStore('entries').delete(key));
    } catch (error) { this.#fallback(error).delete(key); }
  }

  async invalidateStale() {
    if (this.memory) {
      let removed = 0;
      for (const [key, record] of this.memory) {
        if (record.schemaVersion !== this.schemaVersion || record.analysisIdentity !== this.analysisIdentity || !key.startsWith(`${this.schemaVersion}:${this.analysisIdentity}:`)) { this.memory.delete(key); removed++; }
      }
      return removed;
    }
    try {
      const db = await this.#db();
      return await new Promise((resolve, reject) => {
        let removed = 0;
        const tx = db.transaction('entries', 'readwrite');
        const req = tx.objectStore('entries').openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (cursor.value?.schemaVersion !== this.schemaVersion || cursor.value?.analysisIdentity !== this.analysisIdentity) { cursor.delete(); removed++; }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    } catch (error) { this.#fallback(error); return 0; }
  }

  async clear() {
    if (this.memory) { this.memory.clear(); return; }
    try {
      const db = await this.#db();
      await requestPromise(db.transaction('entries', 'readwrite').objectStore('entries').clear());
    } catch (error) { this.#fallback(error).clear(); }
  }

  async #db() {
    if (this._idbFailed || !this.indexedDB?.open) throw this.lastIndexedDBError || new Error('IndexedDB unavailable');
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      let req;
      try { req = this.indexedDB.open(this.dbName, 1); } catch (error) { reject(error); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    return this._db;
  }

  async #idbGet(key) { const db = await this.#db(); return requestPromise(db.transaction('entries', 'readonly').objectStore('entries').get(key)); }
  async #idbPut(record) { const db = await this.#db(); await requestPromise(db.transaction('entries', 'readwrite').objectStore('entries').put(record)); }
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
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
  if (value instanceof Map) { const out = new Map(); seen.set(value, out); for (const [k, v] of value) out.set(fallbackClone(k, seen), fallbackClone(v, seen)); return out; }
  if (value instanceof Set) { const out = new Set(); seen.set(value, out); for (const v of value) out.add(fallbackClone(v, seen)); return out; }
  if (Array.isArray(value)) { const out = []; seen.set(value, out); for (const v of value) out.push(fallbackClone(v, seen)); return out; }
  const out = {}; seen.set(value, out); for (const [k, v] of Object.entries(value)) out[k] = fallbackClone(v, seen); return out;
}

function structuredCloneSafe(value) { if (typeof structuredClone === 'function') return structuredClone(value); return fallbackClone(value); }
