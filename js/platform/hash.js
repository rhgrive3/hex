import { asByteSource } from '../binary/source.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export async function hashByteSource(input, options = {}) {
  const source = asByteSource(input);
  const chunkSize = Math.min(options.chunkSize ?? 1024 * 1024, source.maxReadLength);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');
  let hash = FNV_OFFSET;
  let offset = 0n;
  while (offset < source.size) {
    if (options.signal?.aborted) throw new Error('hash cancelled');
    const remaining = source.size - offset;
    const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
    const bytes = await source.readExactly(offset, length, { signal: options.signal });
    for (let i = 0; i < bytes.length; i++) {
      hash ^= BigInt(bytes[i]);
      hash = (hash * FNV_PRIME) & MASK64;
    }
    offset += BigInt(bytes.length);
    options.onProgress?.({ done: offset, total: source.size });
  }
  return `fnv1a64:${source.size.toString(16)}:${hash.toString(16).padStart(16, '0')}`;
}

export function hashBytes(bytes) {
  let hash = FNV_OFFSET;
  for (const b of bytes || []) {
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}
