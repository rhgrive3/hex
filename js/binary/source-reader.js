import { BinaryReadError } from './reader.js';
import { ByteSourceLimitError, nonNegativeBigInt, safeNumber } from './source.js';

export class SourceRangeMissingError extends BinaryReadError {
  constructor(offset, length) {
    super(`source range is not cached (${length} bytes)`, offset);
    this.name = 'SourceRangeMissingError';
    this.code = 'BINARY_SOURCE_RANGE_MISSING';
    this.offset = BigInt(offset);
    this.length = BigInt(length);
  }
}

export class SparseByteBuffer {
  constructor(size) {
    this.size = nonNegativeBigInt(size, 'binary source size');
    this.length = this.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(this.size);
    this.__binaryByteBacking = true;
    this.chunks = [];
  }

  additionalBytes(offset, length) {
    const start = nonNegativeBigInt(offset, 'cached range offset');
    const count = nonNegativeBigInt(length, 'cached range length');
    const end = start + count;
    if (end > this.size) throw new BinaryReadError('cached range exceeds source', start);
    let overlap = 0n;
    for (const chunk of this.chunks) {
      const lo = chunk.start > start ? chunk.start : start;
      const hi = chunk.end < end ? chunk.end : end;
      if (hi > lo) overlap += hi - lo;
    }
    return safeNumber(count - overlap, 'new cached byte count');
  }

  add(offset, input) {
    const start = nonNegativeBigInt(offset, 'cached range offset');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const end = start + BigInt(bytes.length);
    if (end > this.size) throw new BinaryReadError('cached range exceeds source', start);
    if (!bytes.length) return 0;
    const added = this.additionalBytes(start, bytes.length);
    let mergeStart = start, mergeEnd = end;
    const keep = [];
    const merge = [];
    for (const chunk of this.chunks) {
      if (chunk.end < start || chunk.start > end) keep.push(chunk);
      else {
        merge.push(chunk);
        if (chunk.start < mergeStart) mergeStart = chunk.start;
        if (chunk.end > mergeEnd) mergeEnd = chunk.end;
      }
    }
    const mergedLength = safeNumber(mergeEnd - mergeStart, 'merged cached range');
    const merged = new Uint8Array(mergedLength);
    for (const chunk of merge) merged.set(chunk.bytes, safeNumber(chunk.start - mergeStart, 'cached chunk offset'));
    merged.set(bytes, safeNumber(start - mergeStart, 'cached input offset'));
    keep.push({ start: mergeStart, end: mergeEnd, bytes: merged });
    keep.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    this.chunks = keep;
    return added;
  }

  subarray(start, end = this.size) {
    const begin = nonNegativeBigInt(start, 'cached read start');
    const finish = nonNegativeBigInt(end, 'cached read end');
    if (finish < begin || finish > this.size) throw new BinaryReadError('read outside file', begin);
    const size = safeNumber(finish - begin, 'cached read length');
    if (!size) return new Uint8Array();
    let cursor = begin;
    for (const chunk of this.chunks) {
      if (chunk.end <= cursor) continue;
      if (chunk.start > cursor) throw new SourceRangeMissingError(cursor, finish - cursor);
      cursor = finish < chunk.end ? finish : chunk.end;
      if (cursor === finish) break;
    }
    if (cursor !== finish) throw new SourceRangeMissingError(cursor, finish - cursor);
    const out = new Uint8Array(size);
    cursor = begin;
    for (const chunk of this.chunks) {
      if (chunk.end <= cursor) continue;
      const takeEnd = finish < chunk.end ? finish : chunk.end;
      const from = safeNumber(cursor - chunk.start, 'cached chunk read offset');
      const to = safeNumber(takeEnd - chunk.start, 'cached chunk read end');
      out.set(chunk.bytes.subarray(from, to), safeNumber(cursor - begin, 'cached output offset'));
      cursor = takeEnd;
      if (cursor === finish) return out;
    }
    return out;
  }
}

export async function parseSourceRanges(source, parser, parserOptions = {}, options = {}) {
  const pageSize = options.pageSize ?? 256 * 1024;
  // `pageSize` historically is also a hard per-read ceiling. Keep that API
  // contract unless the caller explicitly opts into adaptive batching.
  const maxPageSize = options.maxPageSize ?? pageSize;
  const maxCachedBytes = options.maxCachedBytes ?? 64 * 1024 * 1024;
  const maxReads = options.maxReads ?? 4096;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new ByteSourceLimitError('pageSize must be a positive safe integer');
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < pageSize) throw new ByteSourceLimitError('maxPageSize must be a safe integer at least as large as pageSize');
  if (!Number.isSafeInteger(maxCachedBytes) || maxCachedBytes <= 0) throw new ByteSourceLimitError('maxCachedBytes must be a positive safe integer');
  if (!Number.isSafeInteger(maxReads) || maxReads <= 0) throw new ByteSourceLimitError('maxReads must be a positive safe integer');
  const sparse = new SparseByteBuffer(source.size);
  let reads = 0;
  let parserPasses = 0;
  let cachedBytes = 0;
  let totalRequestedBytes = 0;
  let largestRead = 0;
  const initial = options.initial || [];
  for (const item of initial) {
    const added = sparse.additionalBytes(item.offset, item.bytes.byteLength);
    if (cachedBytes + added > maxCachedBytes) throw new ByteSourceLimitError(`initial metadata exceeds the ${maxCachedBytes}-byte cache limit`);
    sparse.add(item.offset, item.bytes);
    cachedBytes += added;
  }

  for (;;) {
    try {
      // Parsers remain synchronous. On a cache miss we fetch a bounded range
      // and restart deterministically. Callers may opt into a larger
      // maxPageSize so large metadata avoids O(n^2) restart storms without
      // removing the overall metadata memory budget.
      parserPasses++;
      const image = parser(sparse, parserOptions);
      image.attachSource(source, { discardBytes: true });
      image.metadata.sourceBacked = true;
      image.metadata.sourceReads = { requests: reads, parserPasses, cachedBytes, pageSize, maxPageSize, totalRequestedBytes, largestRead };
      return image;
    } catch (error) {
      if (error?.code !== 'BINARY_SOURCE_RANGE_MISSING') throw error;
      const missingEnd = error.offset + error.length > source.size ? source.size : error.offset + error.length;
      let cursor = error.offset;
      let first = true;
      while (cursor < source.size && (first || cursor < missingEnd)) {
        first = false;
        if (++reads > maxReads) throw new ByteSourceLimitError(`binary metadata required more than ${maxReads} range reads`);
        if (options.signal?.aborted) {
          const cancelled = new Error('binary metadata read aborted');
          cancelled.name = 'AbortError';
          throw cancelled;
        }
        const remaining = source.size - cursor;
        const budgetRemaining = maxCachedBytes - cachedBytes;
        if (budgetRemaining <= 0) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
        const growthShift = Math.min(5, Math.floor((reads - 1) / 4));
        const adaptive = Math.min(maxPageSize, pageSize * (2 ** growthShift));
        const missing = missingEnd > cursor ? missingEnd - cursor : 0n;
        const wantedByParser = missing > BigInt(maxPageSize) ? maxPageSize : safeNumber(missing, 'missing source range length');
        const requested = Math.max(pageSize, adaptive, wantedByParser);
        const requestLimit = Math.min(requested, maxPageSize, source.maxReadLength, budgetRemaining);
        const length = Number(remaining < BigInt(requestLimit) ? remaining : BigInt(requestLimit));
        if (length <= 0) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
        const bytes = await source.readExactly(cursor, length, { signal: options.signal });
        const added = sparse.additionalBytes(cursor, bytes.byteLength);
        if (added > budgetRemaining) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
        sparse.add(cursor, bytes);
        cachedBytes += added;
        totalRequestedBytes += bytes.byteLength;
        largestRead = Math.max(largestRead, bytes.byteLength);
        cursor += BigInt(bytes.byteLength);
      }
    }
  }
}
