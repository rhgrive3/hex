const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3;
const FNV_PRIME_HI = 0x100;

/*
 * FNV-1a 64-bit without a BigInt operation per byte.
 *
 * Browsers represent ordinary numbers as IEEE-754 doubles. A byte-at-a-time
 * BigInt implementation is exact, but it becomes disproportionately expensive
 * on 30–100 MiB executables. Keep the state as two uint32 limbs instead.
 * Multiplication by the FNV prime (0x00000100_000001B3) is reduced modulo
 * 2^64 explicitly, so this produces the same digest as the canonical BigInt
 * implementation while remaining practical on iPad-class hardware.
 */
function fnv1a64State(bytes, seed = null) {
  let hi, lo;
  if (seed == null) {
    hi = FNV_OFFSET_HI;
    lo = FNV_OFFSET_LO;
  } else if (typeof seed === 'bigint') {
    hi = Number((seed >> 32n) & 0xffffffffn) >>> 0;
    lo = Number(seed & 0xffffffffn) >>> 0;
  } else if (typeof seed === 'object' && seed) {
    hi = Number(seed.hi) >>> 0;
    lo = Number(seed.lo) >>> 0;
  } else {
    throw new TypeError('FNV seed must be BigInt or {hi, lo}');
  }

  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;

    const a0 = lo & 0xffff;
    const a1 = lo >>> 16;
    const p0 = a0 * FNV_PRIME_LO;
    const p1 = a1 * FNV_PRIME_LO;
    const lowWide = p0 + ((p1 & 0xffff) * 0x10000);
    const carry = Math.floor(lowWide / 0x100000000) + Math.floor(p1 / 0x10000);
    const nextLo = lowWide >>> 0;

    hi = (Math.imul(hi, FNV_PRIME_LO) + carry + Math.imul(lo, FNV_PRIME_HI)) >>> 0;
    lo = nextLo;
  }
  return { hi, lo };
}

export function fnv1a64(bytes, seed = null) {
  const x = fnv1a64State(bytes, seed);
  return (BigInt(x.hi) << 32n) | BigInt(x.lo);
}

export const fnv1a64BigInt = fnv1a64;

export function fingerprintBytes(bytes) {
  return digestHex(fnv1a64State(bytes));
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
  let state = { hi: FNV_OFFSET_HI, lo: FNV_OFFSET_LO };
  let total = 0;
  const sections = image.sections.filter((s) => s.fileSize > 0n && (!executableOnly || s.perms.execute));
  for (const s of sections) {
    const start = Number(s.fileOffset), size = Number(s.fileSize);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || start + size > image.bytes.length) continue;
    const b = image.bytes.subarray(start, start + size);
    state = fnv1a64State(b, state);
    total += b.length;
  }
  return { algorithm: 'fnv1a64', hash: digestHex(state), bytes: total, scope: executableOnly ? 'executable-sections' : 'all-sections' };
}

function digestHex(state) {
  return state.hi.toString(16).padStart(8, '0') + state.lo.toString(16).padStart(8, '0');
}
