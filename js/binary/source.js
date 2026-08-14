const DEFAULT_MAX_READ_LENGTH = 16 * 1024 * 1024;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class ByteSourceError extends Error {
  constructor(message, code = 'BYTE_SOURCE_ERROR') {
    super(message);
    this.name = 'ByteSourceError';
    this.code = code;
  }
}

export class ByteSourceRangeError extends ByteSourceError {
  constructor(message, { offset = null, length = null, size = null } = {}) {
    super(message, 'BYTE_SOURCE_RANGE_ERROR');
    this.name = 'ByteSourceRangeError';
    this.offset = offset;
    this.length = length;
    this.size = size;
  }
}

export class ByteSourceLimitError extends ByteSourceError {
  constructor(message) {
    super(message, 'BYTE_SOURCE_LIMIT_ERROR');
    this.name = 'ByteSourceLimitError';
  }
}

export function nonNegativeBigInt(value, label = 'value') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new ByteSourceRangeError(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ByteSourceRangeError(`${label} must be a non-negative safe integer or bigint`);
  }
  return BigInt(value);
}

export function safeNumber(value, label = 'value') {
  const n = nonNegativeBigInt(value, label);
  if (n > MAX_SAFE_BIGINT) throw new ByteSourceLimitError(`${label} exceeds JavaScript's safe integer range`);
  return Number(n);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('ByteSource read was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function asBytes(value, label = 'read result') {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ByteSourceError(`${label} must be a Uint8Array, ArrayBuffer, or ArrayBufferView`);
}

export class ByteSource {
  constructor(size, { maxReadLength = DEFAULT_MAX_READ_LENGTH } = {}) {
    this.size = nonNegativeBigInt(size, 'source size');
    if (!Number.isSafeInteger(maxReadLength) || maxReadLength <= 0) {
      throw new ByteSourceLimitError('maxReadLength must be a positive safe integer');
    }
    this.maxReadLength = maxReadLength;
  }

  validateRange(offset, length) {
    const o = nonNegativeBigInt(offset, 'read offset');
    const n64 = nonNegativeBigInt(length, 'read length');
    if (n64 > BigInt(this.maxReadLength)) {
      throw new ByteSourceLimitError(`read length ${n64} exceeds the ${this.maxReadLength}-byte limit`);
    }
    if (o > this.size || n64 > this.size - o) {
      throw new ByteSourceRangeError('read outside source', { offset: o, length: n64, size: this.size });
    }
    return { offset: o, length: Number(n64) };
  }

  async read(_offset, _length, _options = {}) {
    throw new ByteSourceError('ByteSource.read() is not implemented');
  }

  async readExactly(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfAborted(options.signal);
    const bytes = asBytes(await this.read(range.offset, range.length, options));
    throwIfAborted(options.signal);
    if (bytes.byteLength !== range.length) {
      throw new ByteSourceRangeError(`truncated read: expected ${range.length} bytes, received ${bytes.byteLength}`, {
        offset: range.offset, length: BigInt(range.length), size: this.size,
      });
    }
    return bytes;
  }

  subrange(offset, length) {
    return new SubrangeByteSource(this, offset, length);
  }
}

export class MemoryByteSource extends ByteSource {
  constructor(input, options = {}) {
    const bytes = asBytes(input, 'memory source');
    super(BigInt(bytes.byteLength), options);
    this.bytes = bytes;
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfAborted(options.signal);
    const start = safeNumber(range.offset, 'read offset');
    return this.bytes.subarray(start, start + range.length);
  }
}

export class BlobByteSource extends ByteSource {
  constructor(blob, options = {}) {
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) throw new TypeError('BlobByteSource expects a Blob or File');
    super(BigInt(blob.size), options);
    this.blob = blob;
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfAborted(options.signal);
    const start = safeNumber(range.offset, 'Blob read offset');
    const bytes = new Uint8Array(await this.blob.slice(start, start + range.length).arrayBuffer());
    throwIfAborted(options.signal);
    return bytes;
  }
}

export class SubrangeByteSource extends ByteSource {
  constructor(parent, offset, length, options = {}) {
    const base = asByteSource(parent);
    const start = nonNegativeBigInt(offset, 'subrange offset');
    const size = nonNegativeBigInt(length, 'subrange length');
    if (start > base.size || size > base.size - start) {
      throw new ByteSourceRangeError('subrange outside source', { offset: start, length: size, size: base.size });
    }
    super(size, { maxReadLength: options.maxReadLength ?? base.maxReadLength });
    this.parent = base;
    this.offset = start;
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    return this.parent.readExactly(this.offset + range.offset, range.length, options);
  }
}

class DelegatingByteSource extends ByteSource {
  constructor(source, options = {}) {
    super(source.size, { maxReadLength: options.maxReadLength ?? source.maxReadLength ?? DEFAULT_MAX_READ_LENGTH });
    this.delegate = source;
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfAborted(options.signal);
    // The adapter contract keeps offsets lossless while lengths stay allocation-safe.
    const bytes = asBytes(await this.delegate.read(range.offset, range.length, options));
    throwIfAborted(options.signal);
    if (bytes.byteLength !== range.length) {
      throw new ByteSourceRangeError(`truncated read: expected ${range.length} bytes, received ${bytes.byteLength}`, {
        offset: range.offset, length: BigInt(range.length), size: this.size,
      });
    }
    return bytes;
  }
}

export function asByteSource(input, options = {}) {
  if (input instanceof ByteSource) return input;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return new MemoryByteSource(input, options);
  if (typeof Blob !== 'undefined' && input instanceof Blob) return new BlobByteSource(input, options);
  if (input && (typeof input.size === 'bigint' || Number.isSafeInteger(input.size)) && typeof input.read === 'function') {
    return new DelegatingByteSource(input, options);
  }
  throw new TypeError('Expected bytes, Blob/File, or an object with size and async read(offset, length)');
}

export async function readExactly(source, offset, length, options = {}) {
  return asByteSource(source).readExactly(offset, length, options);
}

export { DEFAULT_MAX_READ_LENGTH };
