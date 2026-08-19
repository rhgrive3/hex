/**
 * Wrapped range domain.
 *
 * A range here is a set of values on Z/2^n, represented as an interval that may
 * wrap around the end of the width: `[0xFFFFFFF0, 0x0000000F]` at 32 bits is the
 * 32 values around zero, not the empty set and not everything. Machine
 * arithmetic wraps, so a domain that cannot represent a wrapped set has to
 * answer "unknown" for the most common loop counters, or — much worse — answer
 * with an unwrapped interval that excludes values the program can actually
 * reach.
 *
 * The rule this module follows everywhere: when an operation cannot be
 * represented exactly, widen to the full width rather than invent a tighter
 * answer. False precision in a decompiler becomes a confident wrong claim in the
 * user interface, which is the one failure the architecture forbids outright.
 */

import { isSupportedWidth, maxUnsigned, signedOf, unsignedOf } from './bitvector.js';

function fail(code) { throw new TypeError(code); }

/** Every value of the width. The safe answer. */
export function fullRange(bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  return Object.freeze({ bits: Number(bits), kind: 'full', lower: 0n, upper: maxUnsigned(bits) });
}

/** No value at all. Produced by meeting disjoint facts, never by guessing. */
export function emptyRange(bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  return Object.freeze({ bits: Number(bits), kind: 'empty', lower: 0n, upper: 0n });
}

/**
 * The inclusive interval from `lower` up to `upper`, wrapping if `upper` is
 * numerically below `lower`.
 */
export function rangeOf(lower, upper, bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  const low = unsignedOf(lower, bits);
  const high = unsignedOf(upper, bits);
  // An interval that covers the whole width is `full`, however it was written,
  // so two spellings of "everything" compare equal.
  if (low === unsignedOf(high + 1n, bits)) return fullRange(bits);
  return Object.freeze({ bits: Number(bits), kind: low <= high ? 'interval' : 'wrapped', lower: low, upper: high });
}

export function singleton(constant) {
  return rangeOf(constant.value, constant.value, constant.bits);
}

export function isFull(range) { return range.kind === 'full'; }
export function isEmpty(range) { return range.kind === 'empty'; }

/** How many values the range holds. Used for widening decisions and reporting. */
export function cardinality(range) {
  if (isEmpty(range)) return 0n;
  if (isFull(range)) return 1n << BigInt(range.bits);
  return unsignedOf(range.upper - range.lower, range.bits) + 1n;
}

export function contains(range, value) {
  if (isEmpty(range)) return false;
  if (isFull(range)) return true;
  const point = unsignedOf(value, range.bits);
  return range.kind === 'interval'
    ? point >= range.lower && point <= range.upper
    : point >= range.lower || point <= range.upper;
}

export function sameRange(left, right) {
  return left.bits === right.bits && left.kind === right.kind
    && left.lower === right.lower && left.upper === right.upper;
}

/**
 * Union. Wrapped intervals have no unique least upper bound, so this picks the
 * smaller of the two candidate hulls and falls back to full. Picking a hull is
 * always sound; picking the smaller one is what keeps the answer useful.
 */
export function join(left, right) {
  if (left.bits !== right.bits) return fullRange(Math.max(left.bits, right.bits));
  if (isEmpty(left)) return right;
  if (isEmpty(right)) return left;
  if (isFull(left) || isFull(right)) return fullRange(left.bits);
  if (contains(left, right.lower) && contains(left, right.upper) && cardinality(left) >= cardinality(right)) return left;
  if (contains(right, left.lower) && contains(right, left.upper) && cardinality(right) >= cardinality(left)) return right;
  const candidates = [rangeOf(left.lower, right.upper, left.bits), rangeOf(right.lower, left.upper, left.bits)]
    .filter((candidate) => contains(candidate, left.lower) && contains(candidate, left.upper)
      && contains(candidate, right.lower) && contains(candidate, right.upper));
  if (candidates.length === 0) return fullRange(left.bits);
  return candidates.reduce((best, candidate) => (cardinality(candidate) < cardinality(best) ? candidate : best));
}

/**
 * Widening.
 *
 * Applied once a value has been revisited more times than the threshold, so a
 * loop-carried range cannot climb one step per iteration forever. Widening to
 * full is deliberately blunt: a cleverer widening operator would be a precision
 * feature, and P8-2's contract is bounded convergence, not a rich domain.
 */
export function widen(previous, next) {
  if (sameRange(previous, next)) return next;
  return fullRange(previous.bits);
}

function wrappingAdd(range, delta) {
  return rangeOf(range.lower + delta, range.upper + delta, range.bits);
}

/**
 * Range arithmetic.
 *
 * Only the operations with an exact, cheap wrapped answer are modelled. The rest
 * report the full range and a reason, so a consumer can tell "we proved nothing"
 * apart from "nobody looked".
 */
export function evaluateBinaryRange(operator, left, right) {
  if (isEmpty(left) || isEmpty(right)) return { range: emptyRange(left.bits), exact: true, reason: null };
  const bits = left.bits;
  const unknown = (reason) => ({ range: fullRange(bits), exact: false, reason });
  if (right.bits !== bits && !['shl', 'lshr', 'ashr'].includes(operator)) {
    return unknown('operands have different widths');
  }

  switch (operator) {
    case 'add': {
      if (isFull(left) || isFull(right)) return unknown('an operand is unconstrained');
      // Adding two intervals is exact when the result still fits in one
      // interval: the widths sum to at most the whole space.
      const size = cardinality(left) + cardinality(right) - 1n;
      if (size > (1n << BigInt(bits))) return unknown('the sum covers the whole width');
      return { range: rangeOf(left.lower + right.lower, left.upper + right.upper, bits), exact: true, reason: null };
    }
    case 'sub': {
      if (isFull(left) || isFull(right)) return unknown('an operand is unconstrained');
      const size = cardinality(left) + cardinality(right) - 1n;
      if (size > (1n << BigInt(bits))) return unknown('the difference covers the whole width');
      return { range: rangeOf(left.lower - right.upper, left.upper - right.lower, bits), exact: true, reason: null };
    }
    case 'and': {
      // Exact only for the common masking case: a constant mask bounds the
      // result from above regardless of the other operand.
      if (cardinality(right) === 1n) return { range: rangeOf(0n, right.lower, bits), exact: false, reason: 'masked by a constant' };
      if (cardinality(left) === 1n) return { range: rangeOf(0n, left.lower, bits), exact: false, reason: 'masked by a constant' };
      return unknown('bitwise and of two ranges is not modelled');
    }
    case 'or':
    case 'xor':
    case 'mul':
    case 'udiv':
    case 'sdiv':
    case 'urem':
    case 'srem':
      return unknown(`${operator} of two ranges is not modelled`);
    case 'shl':
    case 'lshr':
    case 'ashr':
      return unknown(`${operator} of two ranges is not modelled`);
    default:
      return unknown(`unmodelled operator: ${operator}`);
  }
}

/** Zero extension is exact for a non-wrapped range and unknown for a wrapped one. */
export function zeroExtendRange(range, toBits) {
  if (!isSupportedWidth(toBits) || toBits < range.bits) return { range: fullRange(toBits), exact: false, reason: 'invalid extension width' };
  if (isEmpty(range)) return { range: emptyRange(toBits), exact: true, reason: null };
  if (range.kind === 'wrapped' || isFull(range)) {
    // A wrapped source range becomes two disjoint intervals once extended, which
    // this domain cannot represent. The bound that is still true is the source
    // width's maximum.
    return { range: rangeOf(0n, maxUnsigned(range.bits), toBits), exact: false, reason: 'wrapped source range cannot be extended exactly' };
  }
  return { range: rangeOf(range.lower, range.upper, toBits), exact: true, reason: null };
}

/** Sign extension is exact when the range does not straddle the sign boundary. */
export function signExtendRange(range, toBits) {
  if (!isSupportedWidth(toBits) || toBits < range.bits) return { range: fullRange(toBits), exact: false, reason: 'invalid extension width' };
  if (isEmpty(range)) return { range: emptyRange(toBits), exact: true, reason: null };
  if (range.kind === 'wrapped' || isFull(range)) {
    return { range: fullRange(toBits), exact: false, reason: 'wrapped source range cannot be sign extended exactly' };
  }
  const low = signedOf(range.lower, range.bits);
  const high = signedOf(range.upper, range.bits);
  if (low > high) {
    // The interval crosses from positive into negative once reinterpreted.
    return { range: fullRange(toBits), exact: false, reason: 'range straddles the sign boundary' };
  }
  return { range: rangeOf(low, high, toBits), exact: true, reason: null };
}

/** Truncation is exact only when the range fits inside the narrower width. */
export function truncateRange(range, toBits) {
  if (!isSupportedWidth(toBits) || toBits > range.bits) return { range: fullRange(toBits), exact: false, reason: 'invalid truncation width' };
  if (isEmpty(range)) return { range: emptyRange(toBits), exact: true, reason: null };
  if (toBits === range.bits) return { range, exact: true, reason: null };
  if (isFull(range) || range.kind === 'wrapped') return { range: fullRange(toBits), exact: false, reason: 'wrapped source range cannot be truncated exactly' };
  if (cardinality(range) > (1n << BigInt(toBits))) {
    return { range: fullRange(toBits), exact: false, reason: 'range is wider than the target width' };
  }
  return { range: rangeOf(range.lower, range.upper, toBits), exact: true, reason: null };
}

/** A human-readable form for diagnostics and evidence. */
export function describeRange(range) {
  if (isEmpty(range)) return `empty:${range.bits}`;
  if (isFull(range)) return `full:${range.bits}`;
  const prefix = range.kind === 'wrapped' ? 'wrapped' : 'interval';
  return `${prefix}:${range.bits}[0x${range.lower.toString(16)},0x${range.upper.toString(16)}]`;
}
