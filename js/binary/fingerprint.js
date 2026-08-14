const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(bytes, seed = FNV_OFFSET) {
  let h = BigInt(seed) & MASK64;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

export function fingerprintBytes(bytes) {
  return fnv1a64(bytes).toString(16).padStart(16, '0');
}

export function fingerprintFunction(image, fn, opts = {}) {
  const maxBytes = Math.max(16, opts.maxBytes || 1 << 20);
  let size = fn.size == null ? BigInt(opts.fallbackBytes || 64) : fn.size;
  if (size <= 0n) return null;
  if (size > BigInt(maxBytes)) size = BigInt(maxBytes);
  const bytes = image.readVirtual(fn.address, Number(size));
  if (!bytes || !bytes.length) return null;
  return {
    algorithm: 'fnv1a64',
    hash: fingerprintBytes(bytes),
    bytes: bytes.length,
    truncated: fn.size != null && fn.size > BigInt(bytes.length),
  };
}

export function fingerprintImage(image, opts = {}) {
  const executableOnly = opts.executableOnly !== false;
  let h = FNV_OFFSET;
  let total = 0;
  const sections = image.sections.filter((s) => s.fileSize > 0n && (!executableOnly || s.perms.execute));
  for (const s of sections) {
    const start = Number(s.fileOffset), size = Number(s.fileSize);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || start + size > image.bytes.length) continue;
    const b = image.bytes.subarray(start, start + size);
    h = fnv1a64(b, h);
    total += b.length;
  }
  return { algorithm: 'fnv1a64', hash: h.toString(16).padStart(16, '0'), bytes: total, scope: executableOnly ? 'executable-sections' : 'all-sections' };
}
