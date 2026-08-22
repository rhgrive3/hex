function validBits(bits) {
  const n = Number(bits || 64);
  return Number.isInteger(n) && n > 0 && n <= 64 ? n : 64;
}

export function normalizedSignedness(signed) {
  return signed === true ? true : signed === false ? false : null;
}

export function normalizeIntegerValue(value, bits = 64, signed = false) {
  const width = validBits(bits);
  const raw = BigInt.asUintN(width, BigInt(value));
  return signed === true ? BigInt.asIntN(width, raw) : raw;
}

export function rangeWithDomain(min, max, bits = 64, signed = null) {
  return {
    min: BigInt(min),
    max: BigInt(max),
    bits: validBits(bits),
    signed: normalizedSignedness(signed),
  };
}

/**
 * Reinterpret one contiguous integer interval in another signedness domain.
 * If reinterpretation crosses the sign discontinuity, the image is two
 * intervals and cannot be represented by the range model; fail closed.
 */
export function normalizeRangeDomain(range, bits, signed) {
  if (!range || range.min == null || range.max == null) return null;
  const width = validBits(bits || range.bits || 64);
  const srcBits = validBits(range.bits || width);
  const srcSigned = normalizedSignedness(range.signed);
  const dstSigned = normalizedSignedness(signed);
  if (srcBits !== width) return null;
  const min = BigInt(range.min), max = BigInt(range.max);
  if (min > max) return null;
  if (srcSigned == null || dstSigned == null) {
    return srcSigned === dstSigned ? rangeWithDomain(min, max, width, dstSigned) : null;
  }
  if (srcSigned === dstSigned) return rangeWithDomain(min, max, width, dstSigned);

  const modulus = 1n << BigInt(width);
  const sign = 1n << BigInt(width - 1);

  if (srcSigned === false && dstSigned === true) {
    if (max < sign) return rangeWithDomain(min, max, width, true);
    if (min >= sign) return rangeWithDomain(min - modulus, max - modulus, width, true);
    return null;
  }

  // signed -> unsigned
  if (min >= 0n) return rangeWithDomain(min, max, width, false);
  if (max < 0n) return rangeWithDomain(min + modulus, max + modulus, width, false);
  return null;
}

export function mergeRangeDomain(a, b, bits = null, signed = undefined) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const width = validBits(bits || a.bits || b.bits || 64);
  const targetSigned = signed === undefined ? normalizedSignedness(a.signed) : normalizedSignedness(signed);
  const x = normalizeRangeDomain(a, width, targetSigned);
  const y = normalizeRangeDomain(b, width, targetSigned);
  if (!x || !y) return null;
  return rangeWithDomain(x.min < y.min ? x.min : y.min, x.max > y.max ? x.max : y.max, width, targetSigned);
}
