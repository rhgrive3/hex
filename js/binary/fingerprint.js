const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3;
const FNV_PRIME_HI = 0x100;

/*
 * FNV-1a 64-bit without a BigInt operation per byte.
 * The two uint32 limbs produce the exact canonical 64-bit digest but avoid
 * millions of BigInt multiplications on large mobile binaries.
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
  } else throw new TypeError('FNV seed must be BigInt or {hi, lo}');

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

export async function fingerprintFunction(image, fn, opts = {}) {
  const maxBytes = Math.max(16, opts.maxBytes || 1 << 20);
  let size = fn.size == null ? BigInt(opts.fallbackBytes || 64) : BigInt(fn.size);
  if (size <= 0n) return null;
  if (size > BigInt(maxBytes)) size = BigInt(maxBytes);
  const bytes = typeof image.readVirtualAsync === 'function'
    ? await image.readVirtualAsync(fn.address, Number(size))
    : image.readVirtual(fn.address, Number(size));
  if (!bytes || !bytes.length) return null;
  return { algorithm:'fnv1a64', hash:fingerprintBytes(bytes), bytes:bytes.length,
    truncated:fn.size != null && BigInt(fn.size) > BigInt(bytes.length) };
}

async function mappingChunk(image, mapping, offset, length) {
  const fileOffset = BigInt(mapping.fileOffset) + BigInt(offset);
  if (image.bytes) {
    const start=Number(fileOffset);
    if (!Number.isSafeInteger(start) || start < 0 || start + length > image.bytes.length) return null;
    return image.bytes.subarray(start,start+length);
  }
  if (image.source) return image.source.readExactly(fileOffset,length);
  if (mapping.address != null && typeof image.readVirtualAsync === 'function') return image.readVirtualAsync(BigInt(mapping.address)+BigInt(offset),length);
  return null;
}

export async function fingerprintImage(image, opts = {}) {
  const executableOnly = opts.executableOnly !== false;
  const chunkBytes = Math.max(4096, Math.min(1 << 20, Number(opts.chunkBytes || 256 * 1024)));
  let state={hi:FNV_OFFSET_HI,lo:FNV_OFFSET_LO}, total=0;
  let ranges=image.sections.filter((x)=>x.fileSize>0n && (!executableOnly || x.perms.execute));
  if (!ranges.length) ranges=image.segments.filter((x)=>x.fileSize>0n && (!executableOnly || x.perms.execute));
  for (const mapping of ranges) {
    const size=BigInt(mapping.fileSize);
    for (let off=0n;off<size;) {
      const take=Number(size-off < BigInt(chunkBytes) ? size-off : BigInt(chunkBytes));
      const bytes=await mappingChunk(image,mapping,off,take);
      if (!bytes || bytes.length !== take) break;
      state=fnv1a64State(bytes,state); total+=bytes.length; off+=BigInt(bytes.length);
    }
  }
  return {algorithm:'fnv1a64',hash:digestHex(state),bytes:total,scope:executableOnly?'executable-mappings':'all-mappings'};
}

function digestHex(state) {
  return state.hi.toString(16).padStart(8, '0') + state.lo.toString(16).padStart(8, '0');
}
