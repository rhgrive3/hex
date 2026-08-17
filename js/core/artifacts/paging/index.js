import { asByteSource, nonNegativeBigInt } from '../../../binary/source.js';
import { ByteSourceCancelledError } from '../../../bytesource/cached.js';

export const PAGED_ARTIFACT_BOUNDARY_VERSION = 'hex-paged-artifact-boundary-v1';

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

function isAbortLike(error) {
  return error?.name === 'AbortError'
    || error?.name === 'ByteSourceCancelledError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'BYTE_SOURCE_CANCELLED';
}

export function createPageIdentity({ sourceId, pageIndex, pageSize }) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('sourceId must be a non-empty string');
  const index = nonNegativeBigInt(pageIndex, 'page index');
  const size = positiveSafeInteger(pageSize, 'pageSize');
  return `${PAGED_ARTIFACT_BOUNDARY_VERSION}:${sourceId.length}:${sourceId}:${size}:${index}`;
}

export class PagedArtifactReader {
  constructor(input, options = {}) {
    const source = asByteSource(input, options.source || {});
    this.sourceId = options.sourceId;
    if (typeof this.sourceId !== 'string' || this.sourceId.length === 0) throw new TypeError('sourceId must be a non-empty string');
    this.pageSize = positiveSafeInteger(options.pageSize ?? 64 * 1024, 'pageSize');
    this.maxRangeBytes = positiveSafeInteger(options.maxRangeBytes ?? 1024 * 1024, 'maxRangeBytes');
    this.maxRetainedPageBytes = positiveSafeInteger(options.maxRetainedPageBytes ?? 4 * 1024 * 1024, 'maxRetainedPageBytes');
    this.maxPrefetchPages = nonNegativeSafeInteger(options.maxPrefetchPages ?? 2, 'maxPrefetchPages');
    if (this.pageSize > source.maxReadLength) throw new RangeError('pageSize exceeds source maxReadLength');
    if (this.maxRangeBytes < this.pageSize) throw new RangeError('maxRangeBytes must be at least one page');
    if (this.maxRetainedPageBytes < this.pageSize) throw new RangeError('maxRetainedPageBytes must be at least one page');

    this.source = source;
    this.pages = new Map();
    this.inflight = new Map();
    this.retainedPageBytes = 0;
    this.stats = {
      bytesRead:0,
      rangeRequestCount:0,
      pagesFetched:0,
      pagesReused:0,
      pagesEvicted:0,
      prefetchCount:0,
      cancelledRequests:0,
      peakRetainedPageBytes:0,
    };
  }

  #throwIfCancelled(signal) {
    if (!signal?.aborted) return;
    this.stats.cancelledRequests++;
    throw new ByteSourceCancelledError('Paged artifact request was cancelled');
  }

  pageCount() {
    if (this.source.size === 0n) return 0n;
    return (this.source.size + BigInt(this.pageSize) - 1n) / BigInt(this.pageSize);
  }

  pageIdentity(pageIndex) {
    return createPageIdentity({ sourceId:this.sourceId, pageIndex, pageSize:this.pageSize });
  }

  pageIndexForOffset(offset) {
    const value = nonNegativeBigInt(offset, 'offset');
    if (value >= this.source.size) throw new RangeError('offset outside source');
    return value / BigInt(this.pageSize);
  }

  async readPage(pageIndex, { signal = null } = {}) {
    this.#throwIfCancelled(signal);
    const index = nonNegativeBigInt(pageIndex, 'page index');
    const count = this.pageCount();
    if (index >= count) throw new RangeError('page index outside source');
    const bytes = await this.#page(index, { signal });
    const offset = index * BigInt(this.pageSize);
    return Object.freeze({
      pageId:this.pageIdentity(index), pageIndex:index, offset, length:bytes.byteLength, bytes,
    });
  }

  async readRange(offset, length, { signal = null, prefetchPages = 0 } = {}) {
    this.#throwIfCancelled(signal);
    const start = nonNegativeBigInt(offset, 'range offset');
    const size = nonNegativeSafeInteger(length, 'range length');
    if (size > this.maxRangeBytes) throw new RangeError('artifact range exceeds maxRangeBytes');
    if (start > this.source.size || BigInt(size) > this.source.size - start) throw new RangeError('artifact range outside source');
    if (size === 0) return Object.freeze({ offset:start, length:0, bytes:new Uint8Array(0), pageIds:Object.freeze([]) });

    const requestedPrefetch = nonNegativeSafeInteger(prefetchPages, 'prefetchPages');
    const out = new Uint8Array(size);
    const pageIds = [];
    let done = 0;
    while (done < size) {
      this.#throwIfCancelled(signal);
      const absolute = start + BigInt(done);
      const pageIndex = absolute / BigInt(this.pageSize);
      const pageOffset = Number(absolute % BigInt(this.pageSize));
      const page = await this.#page(pageIndex, { signal });
      const take = Math.min(page.byteLength - pageOffset, size - done);
      if (take <= 0) throw new Error('paged source returned an empty page inside a validated range');
      out.set(page.subarray(pageOffset, pageOffset + take), done);
      pageIds.push(this.pageIdentity(pageIndex));
      done += take;
    }

    if (requestedPrefetch > 0) {
      const lastPage = (start + BigInt(size) - 1n) / BigInt(this.pageSize);
      await this.prefetch(lastPage + 1n, { count:requestedPrefetch, signal, allowPastEnd:true });
    }
    return Object.freeze({ offset:start, length:out.byteLength, bytes:out, pageIds:Object.freeze(pageIds) });
  }

  async prefetch(pageIndex, { count = 1, signal = null, allowPastEnd = false } = {}) {
    this.#throwIfCancelled(signal);
    const index = nonNegativeBigInt(pageIndex, 'page index');
    const requested = nonNegativeSafeInteger(count, 'prefetch count');
    const total = this.pageCount();
    if (index >= total) {
      if (allowPastEnd || requested === 0) return Object.freeze({ requested, scheduled:0, pageIds:Object.freeze([]) });
      throw new RangeError('prefetch page index outside source');
    }

    const available = total - index;
    const boundedAvailable = Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available);
    const bounded = Math.min(requested, this.maxPrefetchPages, boundedAvailable);
    const pageIds = [];
    for (let i = 0; i < bounded; i++) {
      this.#throwIfCancelled(signal);
      const current = index + BigInt(i);
      await this.#page(current, { signal, prefetch:true });
      pageIds.push(this.pageIdentity(current));
    }
    return Object.freeze({ requested, scheduled:pageIds.length, pageIds:Object.freeze(pageIds) });
  }

  evictPage(pageIndex) {
    const index = nonNegativeBigInt(pageIndex, 'page index');
    return this.#drop(index.toString(), true);
  }

  clear() {
    for (const entry of this.inflight.values()) entry.controller?.abort();
    this.stats.pagesEvicted += this.pages.size;
    this.pages.clear();
    this.inflight.clear();
    this.retainedPageBytes = 0;
  }

  metrics() {
    return Object.freeze({
      contractVersion:PAGED_ARTIFACT_BOUNDARY_VERSION,
      ...this.stats,
      retainedPageBytes:this.retainedPageBytes,
      retainedPages:this.pages.size,
      pendingRequests:this.inflight.size,
    });
  }

  async #page(pageIndex, { signal = null, prefetch = false } = {}) {
    const key = pageIndex.toString();
    const cached = this.pages.get(key);
    if (cached) {
      this.stats.pagesReused++;
      this.pages.delete(key);
      this.pages.set(key, cached);
      return cached;
    }

    let entry = this.inflight.get(key);
    if (entry) this.stats.pagesReused++;
    else entry = this.#startPage(key, pageIndex, prefetch);
    return this.#waitForPage(entry, signal);
  }

  #startPage(key, pageIndex, prefetch) {
    const offset = pageIndex * BigInt(this.pageSize);
    const remaining = this.source.size - offset;
    const length = Number(remaining < BigInt(this.pageSize) ? remaining : BigInt(this.pageSize));
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const entry = { controller, waiters:0, settled:false, discard:false, promise:null };
    this.stats.rangeRequestCount++;
    if (prefetch) this.stats.prefetchCount++;

    entry.promise = (async () => {
      try {
        const bytes = await this.source.readExactly(offset, length, controller ? { signal:controller.signal } : {});
        this.stats.pagesFetched++;
        this.stats.bytesRead += bytes.byteLength;
        if (!entry.discard) this.#remember(key, bytes);
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

  #waitForPage(entry, signal) {
    this.#throwIfCancelled(signal);
    entry.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (!entry.settled && entry.waiters === 0) {
          entry.discard = true;
          entry.controller?.abort();
        }
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        release();
        fn(value);
      };
      const onAbort = () => {
        this.stats.cancelledRequests++;
        finish(reject, new ByteSourceCancelledError());
      };
      signal?.addEventListener?.('abort', onAbort, { once:true });
      entry.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, isAbortLike(error) ? new ByteSourceCancelledError() : error),
      );
    });
  }

  #remember(key, bytes) {
    if (this.pages.has(key)) this.#drop(key, false);
    while (this.retainedPageBytes + bytes.byteLength > this.maxRetainedPageBytes && this.pages.size) {
      this.#drop(this.pages.keys().next().value, true);
    }
    this.pages.set(key, bytes);
    this.retainedPageBytes += bytes.byteLength;
    this.stats.peakRetainedPageBytes = Math.max(this.stats.peakRetainedPageBytes, this.retainedPageBytes);
  }

  #drop(key, countEviction) {
    const value = this.pages.get(key);
    if (!value) return false;
    this.retainedPageBytes -= value.byteLength;
    this.pages.delete(key);
    if (countEviction) this.stats.pagesEvicted++;
    return true;
  }
}
