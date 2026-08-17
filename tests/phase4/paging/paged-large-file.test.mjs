import assert from 'node:assert/strict';
import { ByteSource } from '../../../js/binary/source.js';
import { ByteSourceCancelledError } from '../../../js/bytesource/cached.js';
import { PagedArtifactReader, createPageIdentity } from '../../../js/core/artifacts/paging/index.js';

const PAGE = 64;
const HUGE_SIZE = 1n << 40n;

class SparseSource extends ByteSource {
  constructor({ delayMs = 0 } = {}) {
    super(HUGE_SIZE, { maxReadLength:Number(HUGE_SIZE) });
    this.delayMs = delayMs;
    this.bytesRead = 0;
    this.rangeRequests = 0;
    this.wholeFileViolations = 0;
  }

  async read(offset, length, { signal = null } = {}) {
    const range = this.validateRange(offset, length);
    this.rangeRequests++;
    if (range.offset === 0n && BigInt(range.length) === this.size) {
      this.wholeFileViolations++;
      throw new Error('whole-file-materialization-attempt');
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name:'AbortError', code:'ABORT_ERR' });
    if (this.delayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name:'AbortError', code:'ABORT_ERR' }));
      }, { once:true });
    });
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name:'AbortError', code:'ABORT_ERR' });
    const out = new Uint8Array(range.length);
    for (let i = 0; i < out.length; i++) out[i] = Number((range.offset + BigInt(i)) & 0xffn);
    this.bytesRead += out.byteLength;
    return out;
  }
}

assert.equal(
  createPageIdentity({ sourceId:'bin:a', pageIndex:5n, pageSize:PAGE }),
  createPageIdentity({ sourceId:'bin:a', pageIndex:5, pageSize:PAGE }),
);
assert.notEqual(
  createPageIdentity({ sourceId:'bin:a', pageIndex:5n, pageSize:PAGE }),
  createPageIdentity({ sourceId:'bin:b', pageIndex:5n, pageSize:PAGE }),
);

const source = new SparseSource();
const reader = new PagedArtifactReader(source, {
  sourceId:'huge-sparse',
  pageSize:PAGE,
  maxRangeBytes:PAGE * 4,
  maxRetainedPageBytes:PAGE * 2,
  maxPrefetchPages:2,
});

const single = await reader.readRange(1024n, 16);
assert.equal(single.bytes.byteLength, 16);
assert.equal(source.rangeRequests, 1);
assert.equal(source.bytesRead, PAGE);
assert.equal(source.wholeFileViolations, 0);

await reader.readPage(100n);
await reader.readPage(1000n);
assert.equal(reader.metrics().pagesFetched, 3);
assert.equal(reader.metrics().retainedPages, 2);
assert.equal(reader.metrics().pagesEvicted, 1);

const beforeOverlap = source.rangeRequests;
const overlapA = await reader.readRange(1000n * BigInt(PAGE) + 8n, 24);
const overlapB = await reader.readRange(1000n * BigInt(PAGE) + 16n, 24);
assert.deepEqual(overlapA.bytes.subarray(8), overlapB.bytes.subarray(0, 16));
assert.equal(source.rangeRequests, beforeOverlap);
assert.ok(reader.metrics().pagesReused >= 2);

const prefetchBefore = reader.metrics();
const prefetched = await reader.prefetch(2000n, { count:10 });
assert.equal(prefetched.scheduled, 2);
assert.equal(reader.metrics().prefetchCount - prefetchBefore.prefetchCount, 2);
assert.equal(reader.metrics().rangeRequestCount - prefetchBefore.rangeRequestCount, 2);

const warmBefore = reader.metrics().rangeRequestCount;
const cold = await reader.readPage(3000n);
const warm = await reader.readPage(3000n);
assert.deepEqual(cold.bytes, warm.bytes);
assert.equal(reader.metrics().rangeRequestCount - warmBefore, 1);

const beforeCancel = reader.metrics();
const preCancelled = new AbortController();
preCancelled.abort();
await assert.rejects(() => reader.readPage(4000n, { signal:preCancelled.signal }), ByteSourceCancelledError);
assert.equal(reader.metrics().rangeRequestCount, beforeCancel.rangeRequestCount);
assert.equal(reader.metrics().cancelledRequests - beforeCancel.cancelledRequests, 1);

const slowSource = new SparseSource({ delayMs:50 });
const slowReader = new PagedArtifactReader(slowSource, {
  sourceId:'slow',
  pageSize:PAGE,
  maxRangeBytes:PAGE * 2,
  maxRetainedPageBytes:PAGE * 2,
  maxPrefetchPages:1,
});
const mid = new AbortController();
const pending = slowReader.readPage(10n, { signal:mid.signal });
setTimeout(() => mid.abort(), 5);
await assert.rejects(() => pending, ByteSourceCancelledError);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(slowReader.metrics().cancelledRequests, 1);
assert.equal(slowReader.metrics().retainedPages, 0);
assert.equal(slowReader.metrics().pendingRequests, 0);
assert.equal(slowReader.metrics().pagesFetched, 0);
assert.equal(slowSource.bytesRead, 0);

const sharedSource = new SparseSource({ delayMs:20 });
const sharedReader = new PagedArtifactReader(sharedSource, {
  sourceId:'shared',
  pageSize:PAGE,
  maxRangeBytes:PAGE,
  maxRetainedPageBytes:PAGE * 2,
  maxPrefetchPages:0,
});
const cancelledConsumer = new AbortController();
const sharedA = sharedReader.readPage(20n, { signal:cancelledConsumer.signal });
const sharedB = sharedReader.readPage(20n);
setTimeout(() => cancelledConsumer.abort(), 2);
await assert.rejects(() => sharedA, ByteSourceCancelledError);
const sharedPage = await sharedB;
assert.equal(sharedPage.bytes.byteLength, PAGE);
assert.equal(sharedSource.rangeRequests, 1, 'coalesced readers must share one range request');
assert.equal(sharedReader.metrics().cancelledRequests, 1);
assert.equal(sharedReader.metrics().pagesFetched, 1);

const detectorSource = new SparseSource();
await assert.rejects(() => detectorSource.read(0n, Number(HUGE_SIZE)), /whole-file-materialization-attempt/);
assert.equal(detectorSource.wholeFileViolations, 1);
assert.equal(source.wholeFileViolations, 0);
assert.ok(reader.metrics().bytesRead < Number(HUGE_SIZE));
assert.ok(reader.metrics().peakRetainedPageBytes <= PAGE * 2);

for (const count of [10, 100, 1000, 10000]) {
  const scalingSource = new SparseSource();
  const scalingReader = new PagedArtifactReader(scalingSource, {
    sourceId:`scale-${count}`,
    pageSize:PAGE,
    maxRangeBytes:PAGE,
    maxRetainedPageBytes:PAGE * 10,
    maxPrefetchPages:0,
  });
  for (let i = 0; i < count; i++) await scalingReader.readPage(BigInt(i));
  const metrics = scalingReader.metrics();
  assert.equal(metrics.pagesFetched, count);
  assert.equal(metrics.rangeRequestCount, count);
  assert.equal(metrics.retainedPages, Math.min(count, 10));
  assert.equal(metrics.pagesEvicted, Math.max(0, count - 10));
  assert.ok(metrics.peakRetainedPageBytes <= PAGE * 10);
}

console.log(JSON.stringify({
  largestSyntheticSourceBytes:HUGE_SIZE.toString(),
  bytesActuallyRead:reader.metrics().bytesRead,
  wholeFileViolationsDuringPagedAccess:source.wholeFileViolations,
  cancellation:{ beforeRead:'cancelled', midRead:'cancelled-no-residue', sharedConsumer:'survivor-completed' },
  scalingPages:[10, 100, 1000, 10000],
  metrics:reader.metrics(),
}));
console.log('phase4 paging: PASS');
