const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// Number()/BigInt() both coerce some malformed protocol scalars (null, false,
// blank strings) to zero, so reject those shapes before numeric conversion.
function rejectMalformedIntegerScalar(value, message) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) {
    throw new RangeError(message);
  }
}

export function checkedChunkIndex(value) {
  rejectMalformedIntegerScalar(value, 'Chunk index must be a non-negative safe integer.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Chunk index must be a non-negative safe integer.');
  return n;
}

export function regionSize(value, label = 'region size') {
  rejectMalformedIntegerScalar(value, `${label} is invalid.`);
  let n;
  try { n = typeof value === 'bigint' ? value : BigInt(value); }
  catch { throw new RangeError(`${label} is invalid.`); }
  if (n < 0n) throw new RangeError(`${label} must be non-negative.`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must not enter the worker as an unsafe Number.`);
  }
  return n;
}

export function boundedOffset(value, max, label = 'offset') {
  const limit = regionSize(max, 'range limit');
  if (value == null) return limit;
  const n = regionSize(value, label);
  return n > limit ? limit : n;
}

export function chunkLength(remaining, cap) {
  const n = regionSize(remaining, 'remaining range');
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('chunk cap must be a non-negative safe integer.');
  const bounded = n < BigInt(cap) ? n : BigInt(cap);
  return Number(bounded);
}

// Keep existing UI payloads numeric while they are exactly representable, but
// never round a >2^53 boundary merely for progress/reporting.
export function exactExternalInteger(value) {
  const n = regionSize(value, 'integer');
  return n <= MAX_SAFE_BIGINT ? Number(n) : n;
}

export function utf8Len(buf, index) {
  const c = buf[index];
  if (c < 0x80) return (c >= 0x20 && c < 0x7f) || c === 9 || c === 10 ? 1 : 0;
  let need = 0;
  if (c >= 0xc2 && c <= 0xdf) need = 1;
  else if (c >= 0xe0 && c <= 0xef) need = 2;
  else if (c >= 0xf0 && c <= 0xf4) need = 3;
  else return 0;
  if (index + need >= buf.length) return -1;
  const b1 = buf[index + 1];
  if ((b1 & 0xc0) !== 0x80) return 0;
  if (c === 0xe0 && b1 < 0xa0) return 0;
  if (c === 0xed && b1 > 0x9f) return 0;
  if (c === 0xf0 && b1 < 0x90) return 0;
  if (c === 0xf4 && b1 > 0x8f) return 0;
  for (let k = 2; k <= need; k++) if ((buf[index + k] & 0xc0) !== 0x80) return 0;
  return need + 1;
}

export function isExactFunctionSeed(seed) {
  if (!seed || Number(seed.confidence ?? 0) < 0.9) return false;
  if (seed.exactFunctionStart === true) return true;
  const sources = new Set([seed.source, ...(seed.sources || [])]);
  return [...sources].some((s) => ['entrypoint', 'export', 'exception', 'unwind', 'function_starts', 'tls-callback', 'guard-cf'].includes(s));
}
