import { ByteSource, asByteSource, nonNegativeBigInt } from '../binary/source.js';

export class ByteSourceCancelledError extends Error {
  constructor(message = 'ByteSource read was cancelled') {
    super(message);
    this.name = 'ByteSourceCancelledError';
    this.code = 'BYTE_SOURCE_CANCELLED';
  }
}

function isAbortLike(error) {
  return error?.name === 'AbortError'
    || error?.name === 'ByteSourceCancelledError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'BYTE_SOURCE_CANCELLED';
}

function throwIfCancelled(signal, onCancelled = null) {
  if (!signal?.aborted) return;
  onCancelled?.();
  throw new ByteSourceCancelledError();
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

async function waitForInflight(entry, signal, onCancelled) {
  throwIfCancelled(signal, onCancelled);
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.controller?.abort();
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      release();
      fn(value);
    };
    const onAbort = () => {
      onCancelled?.();
      finish(reject, new ByteSourceCancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once:true });
    entry.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, isAbortLike(error) ? new ByteSourceCancelledError() : error),
    );
  });
}

export class CachedByteSource extends ByteSource {
  constructor(input, options = {}) {
    const source = asByteSource(input, options.source || {});
    super(source.size, { maxReadLength: options.maxReadLength ?? source.maxReadLength });
    this.source = source;
    this.pageSize = positiveSafeInteger(options.pageSize ?? 256 * 1024, 'pageSize');
    this.maxCachedBytes = options.maxCachedBytes ?? 8 * 1024 * 1024;
    this.maxPrefetchPages = options.maxPrefetchPages ?? 2;
    this.abortUnobservedReads = options.abortUnobservedReads === true;
    if (!Number.isSafeInteger(this.maxCachedBytes) || this.maxCachedBytes < this.pageSize) throw new TypeError('maxCachedBytes must be at least one page');
    if (!Number.isSafeInteger(this.maxPrefetchPages) || this.maxPrefetchPages < 0) throw new TypeError('maxPrefetchPages must be a non-negative safe integer');
    this.cache = new Map();
    this.inflight = new Map();
    this.cachedBytes = 0;
    this.generation = 0;
    this.stats = {
      requests:0, hits:0, misses:0, backendBytesRead:0, largestRead:0,
      rangeRequestCount:0, pagesFetched:0, pagesReused:0, pagesEvicted:0,
      prefetchCount:0, cancelledRequests:0, peakRetainedPageBytes:0,
    };
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfCancelled(options.signal, () => { this.stats.cancelledRequests++; });
    this.stats.requests++;
    this.stats.largestRead = Math.max(this.stats.largestRead, range.length);
    if (range.length === 0) return new Uint8Array(0);

    const out = new Uint8Array(range.length);
    let done = 0;
    const start = range.offset;
    while (done < range.length) {
      throwIfCancelled(options.signal, () => { this.stats.cancelledRequests++; });
      const absolute = start + BigInt(done);
      const pageIndex = absolute / BigInt(this.pageSize);
      const pageOffset = Number(absolute % BigInt(this.pageSize));
      const page = await this.#page(pageIndex, { signal:options.signal });
      if (pageOffset >= page.length) break;
      const take = Math.min(page.length - pageOffset, range.length - done);
      out.set(page.subarray(pageOffset, pageOffset + take), done);
      done += take;
    }

    const prefetchPages = options.prefetchPages ?? 0;
    if (prefetchPages) {
      const end = start + BigInt(done);
      await this.prefetch(end, { pages:prefetchPages, signal:options.signal });
    }
    return done === range.length ? out : out.subarray(0, done);
  }

  async readExactly(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    const bytes = await this.read(range.offset, range.length, options);
    if (bytes.byteLength !== range.length) throw new Error(`truncated cached read: expected ${range.length}, received ${bytes.byteLength}`);
    return bytes;
  }

  async prefetch(offset, { pages = 1, signal = null } = {}) {
    const start = nonNegativeBigInt(offset, 'prefetch offset');
    if (start > this.size) throw new RangeError('prefetch offset outside source');
    if (!Number.isSafeInteger(pages) || pages < 0) throw new TypeError('prefetch pages must be a non-negative safe integer');
    throwIfCancelled(signal, () => { this.stats.cancelledRequests++; });
    const limit = Math.min(pages, this.maxPrefetchPages);
    if (limit === 0 || start === this.size) return Object.freeze({ requested:pages, scheduled:0 });
    let pageIndex = start / BigInt(this.pageSize);
    if (start % BigInt(this.pageSize) !== 0n) pageIndex++;
    let scheduled = 0;
    for (let i = 0; i < limit; i++) {
      const index = pageIndex + BigInt(i);
      if (index * BigInt(this.pageSize) >= this.size) break;
      await this.#page(index, { signal, prefetch:true });
      scheduled++;
    }
    return Object.freeze({ requested:pages, scheduled });
  }

  evictPage(pageIndex) {
    const index = nonNegativeBigInt(pageIndex, 'page index');
    return this.#drop(index.toString(), true);
  }

  async #page(pageIndex, { signal = null, prefetch = false } = {}) {
    const key = pageIndex.toString();
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits++;
      this.stats.pagesReused++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    this.stats.misses++;
    let entry = this.inflight.get(key);
    if (!entry) entry = this.#startPage(key, pageIndex, prefetch);
    return waitForInflight(entry, signal, () => { this.stats.cancelledRequests++; });
  }

  #startPage(key, pageIndex, prefetch) {
    const offset = pageIndex * BigInt(this.pageSize);
    const remaining = this.size - offset;
    const length = Number(remaining < BigInt(this.pageSize) ? remaining : BigInt(this.pageSize));
    const generation = this.generation;
    const controller = this.abortUnobservedReads && typeof AbortController === 'function' ? new AbortController() : null;
    const entry = { controller, waiters:0, settled:false, promise:null };
    this.stats.rangeRequestCount++;
    if (prefetch) this.stats.prefetchCount++;
    entry.promise = (async () => {
      try {
        const bytes = await this.source.readExactly(offset, length, controller ? { signal:controller.signal } : {});
        this.stats.pagesFetched++;
        this.stats.backendBytesRead += bytes.byteLength;
        if (generation === this.generation) this.#remember(key, bytes);
        return bytes;
      } catch (error) {
        if (isAbortLike(error)) throw new ByteSourceCancelledError();
        throw error;
      }
    })().finally(() => {
      entry.settled = true;
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    });
    this.inflight.set(key, entry);
    return entry;
  }

  #remember(key, bytes) {
    if (this.cache.has(key)) this.#drop(key, false);
    while (this.cachedBytes + bytes.byteLength > this.maxCachedBytes && this.cache.size) {
      this.#drop(this.cache.keys().next().value, true);
    }
    this.cache.set(key, bytes);
    this.cachedBytes += bytes.byteLength;
    this.stats.peakRetainedPageBytes = Math.max(this.stats.peakRetainedPageBytes, this.cachedBytes);
  }

  #drop(key, countEviction) {
    const value = this.cache.get(key);
    if (!value) return false;
    this.cachedBytes -= value.byteLength;
    this.cache.delete(key);
    if (countEviction) this.stats.pagesEvicted++;
    return true;
  }

  clear() {
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
    this.cachedBytes = 0;
  }

  memoryStats() {
    return {
      bytesCached:this.cachedBytes,
      chunksCached:this.cache.size,
      pendingReads:this.inflight.size,
      ...this.stats,
    };
  }
}

export class InstrumentedByteSource extends ByteSource {
  constructor(input) {
    const source = asByteSource(input);
    super(source.size, { maxReadLength:source.maxReadLength });
    this.source = source;
    this.reads = [];
    this.bytesReturned = 0;
    this.cancelledReads = 0;
    this.wholeFileRequests = 0;
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    if (range.offset === 0n && BigInt(range.length) === this.size) this.wholeFileRequests++;
    this.reads.push({ offset:nonNegativeBigInt(range.offset), length:range.length });
    try {
      const bytes = await this.source.readExactly(range.offset, range.length, options);
      this.bytesReturned += bytes.byteLength;
      return bytes;
    } catch (error) {
      if (isAbortLike(error) || options.signal?.aborted) this.cancelledReads++;
      throw error;
    }
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
    return {
      reads:this.reads.length,
      rangeRequestCount:this.reads.length,
      totalRequested,
      bytesRead:this.bytesReturned,
      largestSingleRead,
      peakRequestedRange,
      cancelledReads:this.cancelledReads,
      wholeFileRequests:this.wholeFileRequests,
    };
  }
}
