import { ArtifactStorageError, ArtifactUnsupportedError } from './contracts.js';
import {
  compatiblePublishedArtifact,
  createStorageEnvelopeFields,
  sameObservedArtifact,
} from './storage/integrity.js';

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

function abortError(signal) {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
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
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    transaction.oncomplete = () => finish(resolve);
    transaction.onerror = () => finish(reject, transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => finish(reject, transaction.error || new DOMException('IndexedDB transaction aborted', 'AbortError'));
  });
}

async function absorbTransactionFailure(done) {
  if (!done) return;
  try { await done; } catch { /* request error is mapped by the caller */ }
}

function storedRow(record, payload) {
  return {
    artifactId:String(record.artifactId),
    ...createStorageEnvelopeFields(record),
    record:clone(record),
    payload:exactArrayBuffer(payload),
  };
}

function cloneRaw(raw) {
  if (!raw) return null;
  const result = { record:clone(raw.record) };
  if (Object.hasOwn(raw, 'storageEnvelopeSchemaVersion')) result.storageEnvelopeSchemaVersion = raw.storageEnvelopeSchemaVersion;
  if (Object.hasOwn(raw, 'recordChecksum')) result.recordChecksum = raw.recordChecksum;
  if (Object.hasOwn(raw, 'payload')) result.payload = new Uint8Array(exactArrayBuffer(raw.payload));
  return result;
}

function payloadByteLength(raw) {
  if (!raw || !Object.hasOwn(raw, 'payload')) return 0;
  try { return new Uint8Array(raw.payload).byteLength; }
  catch { return Number(raw.record?.payloadSize || 0); }
}

export class MemoryArtifactBackend {
  constructor({ entries = new Map(), reason = 'explicit-memory-backend' } = {}) {
    this.entries = entries;
    this.reason = reason;
    this.metrics = {
      reads:0,
      readBytes:0,
      writes:0,
      writeBytes:0,
      bytesWritten:0,
      duplicatePuts:0,
      deletes:0,
      deleteMisses:0,
      hasChecks:0,
      bytes:0,
    };
    for (const value of entries.values()) this.metrics.bytes += payloadByteLength(value);
  }

  capabilities() {
    return Object.freeze({ backend:'memory', persistent:false, indexedDB:false, opfs:false, reason:this.reason });
  }

  async getRaw(artifactId) {
    this.metrics.reads++;
    const raw = this.entries.get(String(artifactId));
    if (!raw) return null;
    const result = cloneRaw(raw);
    this.metrics.readBytes += result.payload?.byteLength || 0;
    return result;
  }

  async putAtomic(record, payload, { signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    const id = String(record.artifactId);
    const buffer = exactArrayBuffer(payload);
    const previous = this.entries.get(id);
    if (previous) {
      if (!compatiblePublishedArtifact(previous.record, record, previous.payload, buffer)) {
        throw new ArtifactStorageError('artifact-immutable-conflict', `Artifact ${id} is already published with different content`);
      }
      this.metrics.duplicatePuts++;
      return { duplicate:true, ...cloneRaw(previous) };
    }
    const row = storedRow(record, buffer);
    this.entries.set(id, row);
    this.metrics.writes++;
    this.metrics.writeBytes += buffer.byteLength;
    this.metrics.bytesWritten += buffer.byteLength;
    this.metrics.bytes += buffer.byteLength;
    return { duplicate:false, ...cloneRaw(row) };
  }

  async delete(artifactId) {
    const id = String(artifactId);
    const previous = this.entries.get(id);
    if (!previous) {
      this.metrics.deleteMisses++;
      return false;
    }
    this.entries.delete(id);
    this.metrics.deletes++;
    this.metrics.bytes -= payloadByteLength(previous);
    if (this.metrics.bytes < 0) this.metrics.bytes = 0;
    return true;
  }

  async deleteIfMatches(artifactId, record, payload) {
    const id = String(artifactId);
    const previous = this.entries.get(id);
    if (!previous) return false;
    if (!sameObservedArtifact(previous.record, record, previous.payload, payload)) return false;
    return this.delete(id);
  }

  async has(artifactId) {
    this.metrics.hasChecks++;
    return this.entries.has(String(artifactId));
  }

  async close() {}
  stats() { return Object.freeze({ ...this.metrics, entries:this.entries.size }); }
}

export class IndexedDbArtifactBackend {
  constructor({ indexedDB = globalThis.indexedDB, dbName = 'hex-artifact-store-v1', navigator = globalThis.navigator } = {}) {
    if (!indexedDB?.open) throw new ArtifactUnsupportedError('artifact-indexeddb-unsupported', 'IndexedDB is unavailable');
    this.indexedDB = indexedDB;
    this.navigator = navigator;
    this.dbName = dbName;
    this.dbPromise = null;
    this.metrics = {
      reads:0,
      readBytes:0,
      writes:0,
      writeBytes:0,
      bytesWritten:0,
      duplicatePuts:0,
      deletes:0,
      deleteMisses:0,
      hasChecks:0,
      openFailures:0,
      transactionAborts:0,
    };
  }

  capabilities() {
    return Object.freeze({
      backend:'indexeddb',
      persistent:true,
      indexedDB:true,
      opfs:typeof this.navigator?.storage?.getDirectory === 'function',
      durability:'browser-managed',
    });
  }

  async #db() {
    if (this.dbPromise) return this.dbPromise;
    let promise;
    promise = new Promise((resolve, reject) => {
      let request;
      try { request = this.indexedDB.open(this.dbName, 1); }
      catch (error) { reject(storageError(error, 'open')); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('artifacts')) db.createObjectStore('artifacts', { keyPath:'artifactId' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          if (this.dbPromise === promise) this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(storageError(request.error, 'open'));
      request.onblocked = () => reject(new ArtifactStorageError('artifact-storage-blocked', 'IndexedDB open is blocked'));
    });
    this.dbPromise = promise.catch((error) => {
      this.metrics.openFailures++;
      if (this.dbPromise) this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
  }

  async getRaw(artifactId) {
    this.metrics.reads++;
    let done = null;
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readonly');
      done = transactionPromise(tx);
      const raw = await requestPromise(tx.objectStore('artifacts').get(String(artifactId)));
      await done;
      if (!raw) return null;
      const result = cloneRaw(raw);
      this.metrics.readBytes += result.payload?.byteLength || 0;
      return result;
    } catch (error) {
      await absorbTransactionFailure(done);
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'get');
    }
  }

  async putAtomic(record, payload, { signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    let tx = null;
    let done = null;
    let onAbort = null;
    const id = String(record.artifactId);
    const buffer = exactArrayBuffer(payload);
    try {
      const db = await this.#db();
      if (signal?.aborted) throw abortError(signal);
      // Use the portable two-argument transaction form for older iPad/WebKit.
      // A single readwrite transaction owns conflict detection and publication.
      tx = db.transaction('artifacts', 'readwrite');
      done = transactionPromise(tx);
      if (signal) {
        onAbort = () => {
          try { tx.abort(); this.metrics.transactionAborts++; } catch { /* transaction already completed */ }
        };
        signal.addEventListener('abort', onAbort, { once:true });
      }
      const store = tx.objectStore('artifacts');
      const previous = await requestPromise(store.get(id));
      if (signal?.aborted) {
        try { tx.abort(); this.metrics.transactionAborts++; } catch {}
        await absorbTransactionFailure(done);
        throw abortError(signal);
      }
      if (previous) {
        if (!compatiblePublishedArtifact(previous.record, record, previous.payload, buffer)) {
          try { tx.abort(); this.metrics.transactionAborts++; } catch {}
          await absorbTransactionFailure(done);
          throw new ArtifactStorageError('artifact-immutable-conflict', `Artifact ${id} is already published with different content`);
        }
        await done;
        this.metrics.duplicatePuts++;
        return { duplicate:true, ...cloneRaw(previous) };
      }
      const row = storedRow(record, buffer);
      await requestPromise(store.add(row));
      await done;
      this.metrics.writes++;
      this.metrics.writeBytes += buffer.byteLength;
      this.metrics.bytesWritten += buffer.byteLength;
      return { duplicate:false, ...cloneRaw(row) };
    } catch (error) {
      await absorbTransactionFailure(done);
      if (error?.name === 'AbortError' || signal?.aborted) throw abortError(signal);
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'put');
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async delete(artifactId) {
    const id = String(artifactId);
    let done = null;
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readwrite');
      done = transactionPromise(tx);
      const store = tx.objectStore('artifacts');
      const existing = await requestPromise(store.getKey(id));
      if (existing == null) {
        await done;
        this.metrics.deleteMisses++;
        return false;
      }
      await requestPromise(store.delete(id));
      await done;
      this.metrics.deletes++;
      return true;
    } catch (error) {
      await absorbTransactionFailure(done);
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'delete');
    }
  }

  async deleteIfMatches(artifactId, record, payload) {
    const id = String(artifactId);
    let done = null;
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readwrite');
      done = transactionPromise(tx);
      const store = tx.objectStore('artifacts');
      const previous = await requestPromise(store.get(id));
      if (!previous || !sameObservedArtifact(previous.record, record, previous.payload, payload)) {
        await done;
        return false;
      }
      await requestPromise(store.delete(id));
      await done;
      this.metrics.deletes++;
      return true;
    } catch (error) {
      await absorbTransactionFailure(done);
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'delete-if-match');
    }
  }

  async has(artifactId) {
    this.metrics.hasChecks++;
    let done = null;
    try {
      const db = await this.#db();
      const tx = db.transaction('artifacts', 'readonly');
      done = transactionPromise(tx);
      const value = await requestPromise(tx.objectStore('artifacts').getKey(String(artifactId)));
      await done;
      return value != null;
    } catch (error) {
      await absorbTransactionFailure(done);
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError(error, 'has');
    }
  }

  async close() {
    if (!this.dbPromise) return;
    const promise = this.dbPromise;
    try { (await promise).close(); }
    finally { if (this.dbPromise === promise) this.dbPromise = null; }
  }

  stats() { return Object.freeze({ ...this.metrics }); }
}

export function detectArtifactPersistenceCapabilities({ indexedDB = globalThis.indexedDB, navigator = globalThis.navigator } = {}) {
  return Object.freeze({
    indexedDB:!!indexedDB?.open,
    opfs:typeof navigator?.storage?.getDirectory === 'function',
  });
}

export function createArtifactBackend(options = {}) {
  const capabilities = detectArtifactPersistenceCapabilities(options);
  if (capabilities.indexedDB) return new IndexedDbArtifactBackend(options);
  if (options.allowMemoryFallback === false) {
    throw new ArtifactUnsupportedError('artifact-persistence-unsupported', 'No persistent artifact backend is available');
  }
  return new MemoryArtifactBackend({ entries:options.memoryEntries, reason:'persistent-storage-unavailable' });
}
