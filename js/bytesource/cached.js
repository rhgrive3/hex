import { ByteSource, asByteSource, nonNegativeBigInt } from '../binary/source.js';

export class ByteSourceCancelledError extends Error {
  constructor(message = 'ByteSource read was cancelled') {
    super(message);
    this.name = 'ByteSourceCancelledError';
    this.code = 'BYTE_SOURCE_CANCELLED';
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new ByteSourceCancelledError();
}

function waitForConsumer(promise, signal) {
  if (!signal) return promise;
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new ByteSourceCancelledError());
    signal.addEventListener?.('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class CachedByteSource extends ByteSource {
  constructor(input, options = {}) {
    const source = asByteSource(input, options.source || {});
    super(source.size, { maxReadLength: options.maxReadLength ?? source.maxReadLength });
    this.source = source;
    this.pageSize = options.pageSize ?? 256 * 1024;
    this.maxCachedBytes = options.maxCachedBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) throw new TypeError('pageSize must be a positive safe integer');
    if (!Number.isSafeInteger(this.maxCachedBytes) || this.maxCachedBytes < this.pageSize) throw new TypeError('maxCachedBytes must be at least one page');
    this.cache = new Map();
    this.inflight = new Map();
    this.cachedBytes = 0;
    this.generation = 0;
    this.stats = { requests: 0, hits: 0, misses: 0, backendBytesRead: 0, largestRead: 0 };
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfCancelled(options.signal);
    this.stats.requests++;
    this.stats.largestRead = Math.max(this.stats.largestRead, range.length);
    if (range.length === 0) return new Uint8Array(0);

    const out = new Uint8Array(range.length);
    let done = 0;
    const start = range.offset;
    while (done < range.length) {
      throwIfCancelled(options.signal);
      const absolute = start + BigInt(done);
      const pageIndex = absolute / BigInt(this.pageSize);
      const pageOffset = Number(absolute % BigInt(this.pageSize));
      const page = await waitForConsumer(this.#page(pageIndex), options.signal);
      throwIfCancelled(options.signal);
      if (pageOffset >= page.length) break;
      const take = Math.min(page.length - pageOffset, range.length - done);
      out.set(page.subarray(pageOffset, pageOffset + take), done);
      done += take;
    }
    return done === range.length ? out : out.subarray(0, done);
  }

  async readExactly(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    const bytes = await this.read(range.offset, range.length, options);
    if (bytes.byteLength !== range.length) throw new Error(`truncated cached read: expected ${range.length}, received ${bytes.byteLength}`);
    return bytes;
  }

  async #page(pageIndex) {
    const key = pageIndex.toString();
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    this.stats.misses++;
    let promise = this.inflight.get(key);
    if (!promise) {
      const offset = pageIndex * BigInt(this.pageSize);
      const remaining = this.size - offset;
      const length = Number(remaining < BigInt(this.pageSize) ? remaining : BigInt(this.pageSize));
      const generation = this.generation;
      promise = (async () => {
        const bytes = await this.source.readExactly(offset, length);
        this.stats.backendBytesRead += bytes.byteLength;
        if (generation === this.generation) this.#remember(key, bytes);
        return bytes;
      })().finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
      this.inflight.set(key, promise);
    }
    return promise;
  }

  #remember(key, bytes) {
    if (this.cache.has(key)) this.#drop(key);
    this.cache.set(key, bytes);
    this.cachedBytes += bytes.byteLength;
    while (this.cachedBytes > this.maxCachedBytes && this.cache.size) {
      this.#drop(this.cache.keys().next().value);
    }
  }

  #drop(key) {
    const value = this.cache.get(key);
    if (!value) return;
    this.cachedBytes -= value.byteLength;
    this.cache.delete(key);
  }

  clear() {
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
    this.cachedBytes = 0;
  }

  memoryStats() {
    return {
      bytesCached: this.cachedBytes,
      chunksCached: this.cache.size,
      pendingReads: this.inflight.size,
      ...this.stats,
    };
  }
}

export class InstrumentedByteSource extends ByteSource {
  constructor(input) {
    const source = asByteSource(input);
    super(source.size, { maxReadLength: source.maxReadLength });
    this.source = source;
    this.reads = [];
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    this.reads.push({ offset: nonNegativeBigInt(range.offset), length: range.length });
    return this.source.readExactly(range.offset, range.length, options);
  }

  metrics() {
    let totalRequested = 0;
    let largestSingleRead = 0;
    let peakRequestedRange = 0n;
    for (const read of this.reads) {
      totalRequested += read.length;
      largestSingleRead = Math.max(largestSingleRead, read.length);
      const end = read.offset + BigInt(read.length);
      if (end > peakRequestedRange) peakRequestedRange = end;
    }
    return { reads: this.reads.length, totalRequested, largestSingleRead, peakRequestedRange: peakRequestedRange.toString() };
  }
}