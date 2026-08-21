export * from './contracts.js';
export * from './hot-cache.js';
export * from './backends.js';
export * from './store.js';

export const PAGED_ARTIFACT_QUERY_VERSION = 'hex-paged-artifact-query-v1';

export async function readArtifactPage(source, {
  offset = 0n,
  length,
  maxPageBytes = 256 * 1024,
  signal = null,
  budget = null,
} = {}) {
  const max = Number(maxPageBytes);
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('artifact-page-max-size-invalid');
  const n = Number(length);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RangeError('artifact-page-size-invalid');
  budget?.consume?.('pagesFetched', 1);
  budget?.consume?.('bytesRead', n);
  budget?.checkCancelled?.();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const bytes = await source.readExactly(offset, n, { signal });
  budget?.checkCancelled?.();
  return Object.freeze({ offset:BigInt(offset), length:bytes.byteLength, bytes });
}
