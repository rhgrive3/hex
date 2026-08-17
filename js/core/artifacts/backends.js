import { ArtifactStorageError, ArtifactUnsupportedError } from './contracts.js';

function exactArrayBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer) return view.buffer.slice(0);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function equalBytes(left, right) {
  const a = left instanceof Uint8Array ? left : new Uint8Array(left);
  const b = right instanceof Uint8Array ? right : new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function storageError(error, operation) {
  const quota = error?.name === 'QuotaExceededError' || error?.code === 22;
  return new ArtifactStorageError(
    quota ? 'artifact-storage-quota-exceeded' : 'artifact-storage-failure',
    `${operation}: ${String(error?.message || error || 'storage failure')}`,
    { operation, cause:String(error?.name || error || 'unknown') },
  );
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export class MemoryArtifactBackend {
  constructor({ entries = new Map(), reason = 'explicit-memory-backend' } = {}) {
    this.entries = entries;
    this.reason = reason;
    this.metrics = { reads:0, writes:0, duplicatePuts:0, deletes:0, bytes:0 };
    for (const value of entries.values()) this.metrics.bytes += Number(value?.record?.payloadSize || 0);
  }

  capabilities() {
    return Object.freeze({ backend:'memory', persistent:false, indexedDB:false, opfs:false, reason:this.reason });
  }

  async getRaw(artifactId) {
    this.metrics.reads++;
    const raw = this.entries.get(String(artifactId));
    if (!raw) return null;
    return { record:clone(raw.record), payload:new Uint8Array(raw.payload.slice(0)) };
  }

  async putAtomic(record, payload, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const id = String(record.artifactId);
    const buffer = exactArrayBuffer(payload);
    const previous = this.entries.get(id);
    if (previous) {
      if (previous.record?.payloadChecksum !== record.payloadChecksum || !equalBytes(previous.payload, buffer)) {
        throw new ArtifactStorageError('artifact-immutable-conflict', `Artifact ${id} is already published with different content`);
      }
      this.metrics.duplicatePuts++;
      return { duplicate:true };
    }
    this.entries.set(id, { record:clone(record), payload:buffer });
    this.metrics.writes++;
    this.metrics.bytes += Number(record.payloadSize || 0);
    return { duplicate:false };
  }

  async delete(artifactId) {
    const id = String(artifactId);
    const previous = this.entries.get(id);
    if (!previous) return false;
    this.entries.delete(id);
    this.metrics.deletes++;
    this.metrics.bytes -= Number(previous.record?.payloadSize || 0);
    return true;
  }

  async has(artifactId) { return this.entries.has(String(artifactId)); }
  async close() {}
  stats() { return Object.freeze({ ...this.metrics, entries:this.entries.size }); }
}

export class IndexedDbArtifactBackend {
  constructor({ indexedDB = globalThis.indexedDB, dbName = 'hex-artifact-store-v1' } = {}) {
    if (!indexedDB?.open) throw new ArtifactUnsupportedError('artifact-indexeddb-unsupported', 'IndexedDB is unavailable');
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.dbPromise = null;
    this.metrics = { reads:0, writes:0, duplicatePuts:0, deletes:0, bytesWritten:0 };
  }

  capabilities() {
    return Object.freeze({ backend:'indexeddb', persistent:true, indexedDB:true, opfs:typeof globalThis.navigator?.storage?.getDirectory === 'function' });
  }

  async #db() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      let request;
      try { request = this.indexedDB.open(this.dbName, 1); }
      catch (error) { reject(storageError(error, 'open')); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('artifacts')) db.createObjectStore('artifacts', { keyPath:'artifactId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError(request.error, 'open'));
      request.onblocked = () => reject(new ArtifactStorageError('artifact-storage-blocked', 'IndexedDB open is blocked'));
    });
    return this.dbPromise;
  }

  async getRaw(artifactId) {
    this.metrics.reads++;
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readonly');
      const done = transactionPromise(tx);
      const raw = await requestPromise(tx.objectStore('artifacts').get(String(artifactId)));
      await done;
      if (!raw) return null;
      return { record:raw.record, payload:new Uint8Array(raw.payload) };
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'get');
    }
  }

  async putAtomic(record, payload, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    let tx = null;
    let onAbort = null;
    const id = String(record.artifactId);
    const buffer = exactArrayBuffer(payload);
    try {
      const db = await this.#db();
      // Avoid non-universal transaction durability options: older iPad/WebKit
      // releases accept the two-argument form and still provide IDB atomicity.
      tx = db.transaction('artifacts', 'readwrite');
      const done = transactionPromise(tx);
      if (signal) {
        onAbort = () => { try { tx.abort(); } catch { /* already committed */ } };
        signal.addEventListener('abort', onAbort, { once:true });
      }
      const store = tx.objectStore('artifacts');
      const previous = await requestPromise(store.get(id));
      if (signal?.aborted) { try { tx.abort(); } catch {} throw signal.reason || new DOMException('Aborted', 'AbortError'); }
      if (previous) {
        if (previous.record?.payloadChecksum !== record.payloadChecksum || !equalBytes(previous.payload, buffer)) {
          try { tx.abort(); } catch {}
          throw new ArtifactStorageError('artifact-immutable-conflict', `Artifact ${id} is already published with different content`);
        }
        await done;
        this.metrics.duplicatePuts++;
        return { duplicate:true };
      }
      store.add({ artifactId:id, record:clone(record), payload:buffer });
      await done;
      if (signal?.aborted) {
        // If abort delivery raced the commit event, remove the just-published item.
        await this.delete(id);
        throw signal.reason || new DOMException('Aborted', 'AbortError');
      }
      this.metrics.writes++;
      this.metrics.bytesWritten += Number(record.payloadSize || 0);
      return { duplicate:false };
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw signal?.reason || error;
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'put');
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async delete(artifactId) {
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readwrite');
      const done = transactionPromise(tx);
      tx.objectStore('artifacts').delete(String(artifactId));
      await done;
      this.metrics.deletes++;
      return true;
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'delete');
    }
  }

  async has(artifactId) {
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readonly');
      const done = transactionPromise(tx);
      const value = await requestPromise(tx.objectStore('artifacts').getKey(String(artifactId)));
      await done;
      return value != null;
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'has');
    }
  }

  async close() {
    if (!this.dbPromise) return;
    try { (await this.dbPromise).close(); } finally { this.dbPromise = null; }
  }

  stats() { return Object.freeze({ ...this.metrics }); }
}

export function detectArtifactPersistenceCapabilities({ indexedDB = globalThis.indexedDB } = {}) {
  return Object.freeze({
    indexedDB:!!indexedDB?.open,
    opfs:typeof globalThis.navigator?.storage?.getDirectory === 'function',
  });
}

export function createArtifactBackend(options = {}) {
  const capabilities = detectArtifactPersistenceCapabilities(options);
  if (capabilities.indexedDB) return new IndexedDbArtifactBackend(options);
  if (options.allowMemoryFallback === false) throw new ArtifactUnsupportedError('artifact-persistence-unsupported', 'No persistent artifact backend is available');
  return new MemoryArtifactBackend({ entries:options.memoryEntries, reason:'persistent-storage-unavailable' });
}
