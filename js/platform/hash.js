import { asByteSource } from '../binary/source.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('hash cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

export async function hashByteSource(input, options = {}) {
  const source = asByteSource(input);
  throwIfAborted(options.signal);
  const chunkSize = Math.min(options.chunkSize ?? 1024 * 1024, source.maxReadLength);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');
  let hash = FNV_OFFSET;
  let offset = 0n;
  while (offset < source.size) {
    throwIfAborted(options.signal);
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


function bytesHex(bytes) {
  return Array.from(bytes || []).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cryptographic identity for a ByteSource without materializing the whole file.
 * Every byte participates: each fixed-size chunk is SHA-256 hashed, then an
 * ordered, domain-separated manifest of those digests is SHA-256 hashed again.
 * This is a tree/content hash, not the conventional SHA-256(file) encoding.
 */
export async function sha256TreeByteSource(input, options = {}) {
  const source = asByteSource(input);
  throwIfAborted(options.signal);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const error = new Error('SubtleCrypto SHA-256 is unavailable');
    error.code = 'SHA256_UNAVAILABLE';
    throw error;
  }
  const chunkSize = Math.min(options.chunkSize ?? 4 * 1024 * 1024, source.maxReadLength);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');

  const digests = [];
  let offset = 0n;
  while (offset < source.size) {
    throwIfAborted(options.signal);
    const remaining = source.size - offset;
    const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
    const bytes = await source.readExactly(offset, length, { signal: options.signal });
    digests.push(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    offset += BigInt(bytes.byteLength);
    options.onProgress?.({ done: offset, total: source.size });
  }

  const header = new TextEncoder().encode(
    `hex-sha256-tree-v1\0${source.size.toString()}\0${chunkSize}\0${digests.length}\0`);
  const manifest = new Uint8Array(header.byteLength + digests.length * 32);
  manifest.set(header, 0);
  let at = header.byteLength;
  for (const digest of digests) { manifest.set(digest, at); at += digest.byteLength; }
  const root = new Uint8Array(await subtle.digest('SHA-256', manifest));
  return `sha256tree:v1:${source.size.toString(16)}:${bytesHex(root)}`;
}
