/**
 * Exact-width machine integer semantics.
 *
 * Every Phase 8 constant is a bitvector of a declared width, and every operation
 * on one wraps at that width. This module exists because JavaScript numbers and
 * C's undefined behaviour are both wrong models of what a machine does: a
 * decompiler that folds `0xFFFFFFF0 + 0x20` into `0x100000010` has invented a
 * 33-bit register, and a decompiler that treats a left shift past the width as
 * undefined has confused the source language with the hardware.
 *
 * Nothing here is architecture-specific. Widths, signedness and wrapping are
 * properties of the value, not of the target.
 */

function fail(code) { throw new TypeError(code); }

/** Widths Phase 8 will reason about. Anything else is unknown, not guessed. */
const SUPPORTED_WIDTHS = Object.freeze([1, 8, 16, 32, 64, 128]);
const WIDTH_SET = new Set(SUPPORTED_WIDTHS);

export function isSupportedWidth(bits) {
  return WIDTH_SET.has(Number(bits));
}

/** Normalizes a value into the unsigned representation of its width. */
export function unsignedOf(value, bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-bitvector-unsupported-width:${bits}`);
  return BigInt.asUintN(Number(bits), BigInt(value));
}

/** The signed interpretation of the same bits. */
export function signedOf(value, bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-bitvector-unsupported-width:${bits}`);
  return BigInt.asIntN(Number(bits), BigInt(value));
}

export function maxUnsigned(bits) { return (1n << BigInt(bits)) - 1n; }
export function minSigned(bits) { return -(1n << BigInt(bits - 1)); }
export function maxSigned(bits) { return (1n << BigInt(bits - 1)) - 1n; }

/** A constant: raw unsigned bits plus the width they mean something at. */
export function bitvector(value, bits) {
  return Object.freeze({ bits: Number(bits), value: unsignedOf(value, bits) });
}

export function sameBitvector(left, right) {
  return left != null && right != null && left.bits === right.bits && left.value === right.value;
}

/** Truncation keeps the low bits. It is exact and always defined. */
export function truncate(constant, toBits) {
  if (!isSupportedWidth(toBits)) return null;
  if (toBits > constant.bits) return null;
  return bitvector(constant.value, toBits);
}

/** Zero extension. Widening to a narrower width is a caller error, not a wrap. */
export function zeroExtend(constant, toBits) {
  if (!isSupportedWidth(toBits) || toBits < constant.bits) return null;
  return bitvector(constant.value, toBits);
}

/** Sign extension reads the source as signed and re-encodes at the new width. */
export function signExtend(constant, toBits) {
  if (!isSupportedWidth(toBits) || toBits < constant.bits) return null;
  return bitvector(signedOf(constant.value, constant.bits), toBits);
}

function requireSameWidth(left, right) {
  return left.bits === right.bits ? left.bits : null;
}

/**
 * Binary operations, all modular at the operand width.
 *
 * Returns null when the operation is not exactly modelled — a mixed-width
 * operand pair, an unsupported operator, or a division by zero, which traps on
 * some targets and is not something a generic optimizer may fold away.
 */
export function evaluateBinary(operator, left, right) {
  const bits = requireSameWidth(left, right);
  // Shifts are the one case where a different right-hand width is normal.
  const shiftAmount = () => right.value;
  if (bits == null && !['shl', 'lshr', 'ashr', 'rotl', 'rotr'].includes(operator)) return null;
  const width = bits ?? left.bits;
  const w = BigInt(width);

  switch (operator) {
    case 'add': return bitvector(left.value + right.value, width);
    case 'sub': return bitvector(left.value - right.value, width);
    case 'mul': return bitvector(left.value * right.value, width);
    case 'and': return bitvector(left.value & right.value, width);
    case 'or': return bitvector(left.value | right.value, width);
    case 'xor': return bitvector(left.value ^ right.value, width);
    case 'shl': {
      const amount = shiftAmount();
      // A shift at or past the width is architecture-defined (masked on some
      // targets, zero on others). Generic code does not get to pick.
      if (amount >= w) return null;
      return bitvector(left.value << amount, width);
    }
    case 'lshr': {
      const amount = shiftAmount();
      if (amount >= w) return null;
      return bitvector(left.value >> amount, width);
    }
    case 'ashr': {
      const amount = shiftAmount();
      if (amount >= w) return null;
      return bitvector(signedOf(left.value, width) >> amount, width);
    }
    case 'rotl': {
      const amount = shiftAmount() % w;
      return bitvector((left.value << amount) | (left.value >> (w - amount)), width);
    }
    case 'rotr': {
      const amount = shiftAmount() % w;
      return bitvector((left.value >> amount) | (left.value << (w - amount)), width);
    }
    case 'udiv': return right.value === 0n ? null : bitvector(left.value / right.value, width);
    case 'urem': return right.value === 0n ? null : bitvector(left.value % right.value, width);
    case 'sdiv': {
      if (right.value === 0n) return null;
      const a = signedOf(left.value, width);
      const b = signedOf(right.value, width);
      // INT_MIN / -1 overflows the width; the result is not representable.
      if (a === minSigned(width) && b === -1n) return null;
      const quotient = a / b;
      return bitvector(quotient, width);
    }
    case 'srem': {
      if (right.value === 0n) return null;
      const a = signedOf(left.value, width);
      const b = signedOf(right.value, width);
      if (a === minSigned(width) && b === -1n) return null;
      return bitvector(a % b, width);
    }
    case 'eq': return bitvector(left.value === right.value ? 1n : 0n, 1);
    case 'ne': return bitvector(left.value === right.value ? 0n : 1n, 1);
    case 'ult': return bitvector(left.value < right.value ? 1n : 0n, 1);
    case 'ule': return bitvector(left.value <= right.value ? 1n : 0n, 1);
    case 'ugt': return bitvector(left.value > right.value ? 1n : 0n, 1);
    case 'uge': return bitvector(left.value >= right.value ? 1n : 0n, 1);
    case 'slt': return bitvector(signedOf(left.value, width) < signedOf(right.value, width) ? 1n : 0n, 1);
    case 'sle': return bitvector(signedOf(left.value, width) <= signedOf(right.value, width) ? 1n : 0n, 1);
    case 'sgt': return bitvector(signedOf(left.value, width) > signedOf(right.value, width) ? 1n : 0n, 1);
    case 'sge': return bitvector(signedOf(left.value, width) >= signedOf(right.value, width) ? 1n : 0n, 1);
    default: return null;
  }
}

/** Unary operations. Returns null for anything not exactly modelled. */
export function evaluateUnary(operator, operand) {
  switch (operator) {
    case 'not': return bitvector(~operand.value, operand.bits);
    case 'neg': return bitvector(-operand.value, operand.bits);
    case 'is-zero': return bitvector(operand.value === 0n ? 1n : 0n, 1);
    case 'is-nonzero': return bitvector(operand.value === 0n ? 0n : 1n, 1);
    default: return null;
  }
}

/**
 * Extracts a bit field, low-bit first. Out-of-range requests return null rather
 * than a silently clamped answer.
 */
export function extractField(constant, lowBit, fieldBits) {
  const low = Number(lowBit);
  const width = Number(fieldBits);
  if (!Number.isInteger(low) || low < 0 || !isSupportedWidth(width)) return null;
  if (low + width > constant.bits) return null;
  return bitvector((constant.value >> BigInt(low)) & maxUnsigned(width), width);
}

/** Inserts a bit field into a value at `lowBit`. */
export function insertField(target, field, lowBit) {
  const low = Number(lowBit);
  if (!Number.isInteger(low) || low < 0 || low + field.bits > target.bits) return null;
  const mask = maxUnsigned(field.bits) << BigInt(low);
  return bitvector((target.value & ~mask) | ((field.value << BigInt(low)) & mask), target.bits);
}

export { SUPPORTED_WIDTHS };
