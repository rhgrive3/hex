import { BinaryReadError } from './reader.js';
import { ByteSourceLimitError, safeNumber } from './source.js';

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
    this.length = safeNumber(size, 'binary source size');
    this.__binaryByteBacking = true;
    this.chunks = [];
  }

  add(offset, input) {
    const start = safeNumber(offset, 'cached range offset');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (BigInt(start) + BigInt(bytes.length) > BigInt(this.length)) throw new BinaryReadError('cached range exceeds source', start);
    if (!bytes.length) return;
    this.chunks.push({ start, end: start + bytes.length, bytes });
    this.chunks.sort((a, b) => a.start - b.start);
  }

  subarray(start, end = this.length) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.length) {
      throw new BinaryReadError('read outside file', Math.max(0, start || 0));
    }
    const size = end - start;
    if (!size) return new Uint8Array();
    let cursor = start;
    for (const chunk of this.chunks) {
      if (chunk.end <= cursor) continue;
      if (chunk.start > cursor) throw new SourceRangeMissingError(cursor, end - cursor);
      cursor = Math.min(end, chunk.end);
      if (cursor === end) break;
    }
    if (cursor !== end) throw new SourceRangeMissingError(cursor, end - cursor);
    const out = new Uint8Array(size);
    cursor = start;
    for (const chunk of this.chunks) {
      if (chunk.end <= cursor) continue;
      const takeEnd = Math.min(end, chunk.end);
      out.set(chunk.bytes.subarray(cursor - chunk.start, takeEnd - chunk.start), cursor - start);
      cursor = takeEnd;
      if (cursor === end) return out;
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
  let cachedBytes = 0;
  let totalRequestedBytes = 0;
  let largestRead = 0;
  const initial = options.initial || [];
  for (const item of initial) {
    if (cachedBytes + item.bytes.byteLength > maxCachedBytes) throw new ByteSourceLimitError(`initial metadata exceeds the ${maxCachedBytes}-byte cache limit`);
    sparse.add(item.offset, item.bytes);
    cachedBytes += item.bytes.byteLength;
  }

  for (;;) {
    try {
      // Parsers remain synchronous. On a cache miss we fetch a bounded range
      // and restart deterministically. Callers may opt into a larger
      // maxPageSize so large metadata avoids O(n^2) restart storms without
      // removing the overall metadata memory budget.
      const image = parser(sparse, parserOptions);
      image.attachSource(source, { discardBytes: true });
      image.metadata.sourceBacked = true;
      image.metadata.sourceReads = { requests: reads, cachedBytes, pageSize, maxPageSize, totalRequestedBytes, largestRead };
      return image;
    } catch (error) {
      if (error?.code !== 'BINARY_SOURCE_RANGE_MISSING') throw error;
      if (++reads > maxReads) throw new ByteSourceLimitError(`binary metadata required more than ${maxReads} range reads`);
      const offset = error.offset;
      if (offset >= source.size) throw new BinaryReadError('truncated binary metadata', offset);
      const remaining = source.size - offset;
      const budgetRemaining = maxCachedBytes - cachedBytes;
      if (budgetRemaining <= 0) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);

      const growthShift = Math.min(5, Math.floor((reads - 1) / 4));
      const adaptive = Math.min(maxPageSize, pageSize * (2 ** growthShift));
      const wantedByParser = error.length > BigInt(maxPageSize) ? maxPageSize : safeNumber(error.length, 'missing source range length');
      const requested = Math.max(pageSize, adaptive, wantedByParser);
      const requestLimit = Math.min(requested, maxPageSize, source.maxReadLength, budgetRemaining);
      const length = Number(remaining < BigInt(requestLimit) ? remaining : BigInt(requestLimit));
      if (length <= 0) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
      const bytes = await source.readExactly(offset, length);
      sparse.add(offset, bytes);
      cachedBytes += bytes.byteLength;
      totalRequestedBytes += bytes.byteLength;
      largestRead = Math.max(largestRead, bytes.byteLength);
    }
  }
}
