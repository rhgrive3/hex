import { asByteSource, nonNegativeBigInt } from '../../../binary/source.js';
import { CachedByteSource, ByteSourceCancelledError } from '../../../bytesource/cached.js';

export const PAGED_ARTIFACT_BOUNDARY_VERSION = 'hex-paged-artifact-boundary-v1';

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
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
    this.cancelledBeforeDispatch = 0;
    this.cache = new CachedByteSource(source, {
      pageSize:this.pageSize,
      maxCachedBytes:this.maxRetainedPageBytes,
      maxReadLength:this.maxRangeBytes,
      maxPrefetchPages:this.maxPrefetchPages,
    });
  }

  #checkCancelled(signal) {
    if (!signal?.aborted) return;
    this.cancelledBeforeDispatch++;
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
    this.#checkCancelled(signal);
    const index = nonNegativeBigInt(pageIndex, 'page index');
    const count = this.pageCount();
    if (index >= count) throw new RangeError('page index outside source');
    const offset = index * BigInt(this.pageSize);
    const remaining = this.source.size - offset;
    const length = Number(remaining < BigInt(this.pageSize) ? remaining : BigInt(this.pageSize));
    const bytes = await this.cache.readExactly(offset, length, { signal });
    return Object.freeze({
      pageId:this.pageIdentity(index), pageIndex:index, offset, length:bytes.byteLength, bytes,
    });
  }

  async readRange(offset, length, { signal = null, prefetchPages = 0 } = {}) {
    this.#checkCancelled(signal);
    const start = nonNegativeBigInt(offset, 'range offset');
    const size = nonNegativeSafeInteger(length, 'range length');
    if (size > this.maxRangeBytes) throw new RangeError('artifact range exceeds maxRangeBytes');
    if (start > this.source.size || BigInt(size) > this.source.size - start) throw new RangeError('artifact range outside source');
    if (size === 0) return Object.freeze({ offset:start, length:0, bytes:new Uint8Array(0), pageIds:Object.freeze([]) });
    const requestedPrefetch = nonNegativeSafeInteger(prefetchPages, 'prefetchPages');
    const first = start / BigInt(this.pageSize);
    const last = (start + BigInt(size) - 1n) / BigInt(this.pageSize);
    const pageIds = [];
    for (let index = first; index <= last; index++) pageIds.push(this.pageIdentity(index));
    const bytes = await this.cache.readExactly(start, size, { signal });
    if (requestedPrefetch > 0) await this.prefetch(last + 1n, { count:requestedPrefetch, signal, allowPastEnd:true });
    return Object.freeze({ offset:start, length:bytes.byteLength, bytes, pageIds:Object.freeze(pageIds) });
  }

  async prefetch(pageIndex, { count = 1, signal = null, allowPastEnd = false } = {}) {
    this.#checkCancelled(signal);
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
    for (let i = 0; i < bounded; i++) pageIds.push(this.pageIdentity(index + BigInt(i)));
    const result = await this.cache.prefetch(index * BigInt(this.pageSize), { pages:bounded, signal });
    return Object.freeze({ requested, scheduled:result.scheduled, pageIds:Object.freeze(pageIds.slice(0, result.scheduled)) });
  }

  evictPage(pageIndex) {
    const index = nonNegativeBigInt(pageIndex, 'page index');
    return this.cache.evictPage(index);
  }

  clear() {
    this.cache.clear();
  }

  metrics() {
    const stats = this.cache.memoryStats();
    return Object.freeze({
      contractVersion:PAGED_ARTIFACT_BOUNDARY_VERSION,
      bytesRead:stats.backendBytesRead,
      rangeRequestCount:stats.rangeRequestCount,
      pagesFetched:stats.pagesFetched,
      pagesReused:stats.pagesReused,
      pagesEvicted:stats.pagesEvicted,
      prefetchCount:stats.prefetchCount,
      cancelledRequests:stats.cancelledRequests + this.cancelledBeforeDispatch,
      peakRetainedPageBytes:stats.peakRetainedPageBytes,
      retainedPageBytes:stats.bytesCached,
      retainedPages:stats.chunksCached,
      pendingRequests:stats.pendingReads,
    });
  }
}
