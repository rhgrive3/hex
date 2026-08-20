/**
 * js/symbolic/expr/bitvector.js
 *
 * Exact fixed-width bitvector arithmetic and bitwise semantics.
 * Implements SMT-LIB 2.6 and machine-faithful BV semantics including
 * exact wraparound, signed two's-complement arithmetic, shift saturation,
 * div/rem edge cases (division by zero, signed MIN_INT / -1 overflow),
 * truncations, extensions, and bit slices.
 */

export function mask(width) {
  const w = Number(width);
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new RangeError(`mask: width must be a positive safe integer >= 1, got ${width}`);
  }
  return (1n << BigInt(w)) - 1n;
}

export function wrap(val, width) {
  const w = Number(width);
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new RangeError(`wrap: width must be a positive safe integer >= 1, got ${width}`);
  }
  const big = typeof val === 'bigint' ? val : BigInt(val);
  return BigInt.asUintN(w, big);
}

export function toUnsigned(val, width) {
  return wrap(val, width);
}

export function toSigned(val, width) {
  const w = Number(width);
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new RangeError(`toSigned: width must be a positive safe integer >= 1, got ${width}`);
  }
  return BigInt.asIntN(w, wrap(val, w));
}

export function bvAdd(a, b, width) {
  return wrap(toUnsigned(a, width) + toUnsigned(b, width), width);
}

export function bvSub(a, b, width) {
  return wrap(toUnsigned(a, width) - toUnsigned(b, width), width);
}

export function bvMul(a, b, width) {
  return wrap(toUnsigned(a, width) * toUnsigned(b, width), width);
}

export function bvUdiv(a, b, width) {
  const ub = toUnsigned(b, width);
  if (ub === 0n) {
    // SMT-LIB 2.6 standard for bvudiv by zero: all ones (mask)
    return mask(width);
  }
  const ua = toUnsigned(a, width);
  return wrap(ua / ub, width);
}

export function bvUrem(a, b, width) {
  const ub = toUnsigned(b, width);
  if (ub === 0n) {
    // SMT-LIB 2.6 standard for bvurem by zero: first operand (a)
    return toUnsigned(a, width);
  }
  const ua = toUnsigned(a, width);
  return wrap(ua % ub, width);
}

export function bvSdiv(a, b, width) {
  const sb = toSigned(b, width);
  if (sb === 0n) {
    // SMT-LIB 2.6 standard for bvsdiv by zero:
    // (bvslt a 0) ? 1 : -1
    const sa = toSigned(a, width);
    return sa < 0n ? 1n : mask(width); // mask(width) represents -1 in two's complement unsigned
  }
  const sa = toSigned(a, width);
  const minInt = -(1n << BigInt(Number(width) - 1));
  // Two's-complement overflow: MIN_INT / -1 wraps around to MIN_INT
  if (sa === minInt && sb === -1n) {
    return wrap(minInt, width);
  }
  return wrap(sa / sb, width);
}

export function bvSrem(a, b, width) {
  const sb = toSigned(b, width);
  if (sb === 0n) {
    // SMT-LIB 2.6 standard for bvsrem by zero: a
    return toUnsigned(a, width);
  }
  const sa = toSigned(a, width);
  const minInt = -(1n << BigInt(Number(width) - 1));
  if (sa === minInt && sb === -1n) {
    return 0n;
  }
  return wrap(sa % sb, width);
}

export function bvAnd(a, b, width) {
  return wrap(toUnsigned(a, width) & toUnsigned(b, width), width);
}

export function bvOr(a, b, width) {
  return wrap(toUnsigned(a, width) | toUnsigned(b, width), width);
}

export function bvXor(a, b, width) {
  return wrap(toUnsigned(a, width) ^ toUnsigned(b, width), width);
}

export function bvNot(a, width) {
  return wrap(~toUnsigned(a, width), width);
}

export function bvNeg(a, width) {
  return wrap(-toSigned(a, width), width);
}

export function bvShl(a, b, width) {
  const w = Number(width);
  const amt = toUnsigned(b, w);
  if (amt >= BigInt(w)) {
    return 0n;
  }
  return wrap(toUnsigned(a, w) << amt, w);
}

export function bvLshr(a, b, width) {
  const w = Number(width);
  const amt = toUnsigned(b, w);
  if (amt >= BigInt(w)) {
    return 0n;
  }
  return wrap(toUnsigned(a, w) >> amt, w);
}

export function bvAshr(a, b, width) {
  const w = Number(width);
  const amt = toUnsigned(b, w);
  const sa = toSigned(a, w);
  if (amt >= BigInt(w)) {
    return sa < 0n ? mask(w) : 0n;
  }
  return wrap(sa >> amt, w);
}

export function bvEq(a, b, width) {
  return toUnsigned(a, width) === toUnsigned(b, width);
}

export function bvNe(a, b, width) {
  return toUnsigned(a, width) !== toUnsigned(b, width);
}

export function bvUlt(a, b, width) {
  return toUnsigned(a, width) < toUnsigned(b, width);
}

export function bvUle(a, b, width) {
  return toUnsigned(a, width) <= toUnsigned(b, width);
}

export function bvUgt(a, b, width) {
  return toUnsigned(a, width) > toUnsigned(b, width);
}

export function bvUge(a, b, width) {
  return toUnsigned(a, width) >= toUnsigned(b, width);
}

export function bvSlt(a, b, width) {
  return toSigned(a, width) < toSigned(b, width);
}

export function bvSle(a, b, width) {
  return toSigned(a, width) <= toSigned(b, width);
}

export function bvSgt(a, b, width) {
  return toSigned(a, width) > toSigned(b, width);
}

export function bvSge(a, b, width) {
  return toSigned(a, width) >= toSigned(b, width);
}

export function bvTrunc(val, fromWidth, toWidth) {
  const fw = Number(fromWidth);
  const tw = Number(toWidth);
  if (!Number.isSafeInteger(fw) || fw <= 0 || !Number.isSafeInteger(tw) || tw <= 0) {
    throw new RangeError(`bvTrunc: widths must be positive safe integers (from=${fromWidth}, to=${toWidth})`);
  }
  if (tw >= fw) {
    throw new RangeError(`bvTrunc: toWidth (${tw}) must be strictly less than fromWidth (${fw})`);
  }
  return wrap(val, tw);
}

export function bvZext(val, fromWidth, toWidth) {
  const fw = Number(fromWidth);
  const tw = Number(toWidth);
  if (!Number.isSafeInteger(fw) || fw <= 0 || !Number.isSafeInteger(tw) || tw <= 0) {
    throw new RangeError(`bvZext: widths must be positive safe integers (from=${fromWidth}, to=${toWidth})`);
  }
  if (tw <= fw) {
    throw new RangeError(`bvZext: toWidth (${tw}) must be strictly greater than fromWidth (${fw})`);
  }
  return wrap(toUnsigned(val, fw), tw);
}

export function bvSext(val, fromWidth, toWidth) {
  const fw = Number(fromWidth);
  const tw = Number(toWidth);
  if (!Number.isSafeInteger(fw) || fw <= 0 || !Number.isSafeInteger(tw) || tw <= 0) {
    throw new RangeError(`bvSext: widths must be positive safe integers (from=${fromWidth}, to=${toWidth})`);
  }
  if (tw <= fw) {
    throw new RangeError(`bvSext: toWidth (${tw}) must be strictly greater than fromWidth (${fw})`);
  }
  return wrap(toSigned(val, fw), tw);
}

export function bvExtract(val, width, high, low) {
  const w = Number(width);
  const h = Number(high);
  const l = Number(low);
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new RangeError(`bvExtract: width must be positive safe integer >= 1, got ${width}`);
  }
  if (!Number.isSafeInteger(h) || !Number.isSafeInteger(l) || l < 0 || h < l || h >= w) {
    throw new RangeError(`bvExtract: invalid bit indices [high=${high}, low=${low}] for width ${width}`);
  }
  const extractedWidth = h - l + 1;
  const shifted = toUnsigned(val, w) >> BigInt(l);
  return wrap(shifted, extractedWidth);
}

export function bvConcat(a, widthA, b, widthB) {
  const wa = Number(widthA);
  const wb = Number(widthB);
  if (!Number.isSafeInteger(wa) || wa <= 0 || !Number.isSafeInteger(wb) || wb <= 0) {
    throw new RangeError(`bvConcat: widths must be positive safe integers (wa=${wa}, wb=${wb})`);
  }
  const totalWidth = wa + wb;
  const highPart = wrap(a, wa) << BigInt(wb);
  const lowPart = wrap(b, wb);
  return wrap(highPart | lowPart, totalWidth);
}
