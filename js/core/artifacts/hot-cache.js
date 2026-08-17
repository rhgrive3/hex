export const ARTIFACT_HOT_CACHE_VERSION = 'hex-artifact-hot-cache-v1';

export class ArtifactHotCache {
  constructor({ maxBytes = 8 * 1024 * 1024, maxEntries = 256 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('artifact-hot-cache-max-bytes-invalid');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError('artifact-hot-cache-max-entries-invalid');
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.bytes = 0;
    this.metrics = {
      hits:0,
      misses:0,
      puts:0,
      replacements:0,
      evictions:0,
      evictionBytes:0,
      oversizeSkips:0,
      insertedBytes:0,
    };
  }

  get(artifactId) {
    const id = String(artifactId);
    const entry = this.entries.get(id);
    if (!entry) {
      this.metrics.misses++;
      return null;
    }
    this.metrics.hits++;
    // Map insertion order is the entire LRU clock. This is deterministic for a
    // deterministic access sequence and never depends on wall-clock time.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  put(artifactId, value, sizeBytes) {
    const id = String(artifactId);
    const size = Number(sizeBytes ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('artifact-hot-cache-size-invalid');
    if (this.entries.has(id)) {
      this.delete(id, false);
      this.metrics.replacements++;
    }
    this.metrics.puts++;
    if (this.maxEntries === 0 || size > this.maxBytes) {
      this.metrics.oversizeSkips++;
      return false;
    }
    this.entries.set(id, { artifactId:id, value, sizeBytes:size });
    this.bytes += size;
    this.metrics.insertedBytes += size;
    this.#evictToBudget();
    return this.entries.has(id);
  }

  delete(artifactId, countEviction = false) {
    const id = String(artifactId);
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.bytes -= entry.sizeBytes;
    if (this.bytes < 0) this.bytes = 0;
    if (countEviction) {
      this.metrics.evictions++;
      this.metrics.evictionBytes += entry.sizeBytes;
    }
    return true;
  }

  clear() {
    if (this.entries.size) {
      this.metrics.evictions += this.entries.size;
      this.metrics.evictionBytes += this.bytes;
    }
    this.entries.clear();
    this.bytes = 0;
  }

  #evictToBudget() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.delete(oldest, true);
    }
  }

  stats() {
    return Object.freeze({
      version:ARTIFACT_HOT_CACHE_VERSION,
      entries:this.entries.size,
      bytes:this.bytes,
      maxEntries:this.maxEntries,
      maxBytes:this.maxBytes,
      ...this.metrics,
    });
  }
}
