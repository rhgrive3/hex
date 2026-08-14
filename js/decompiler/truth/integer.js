/* Width-exact integer semantics used by decompiler rewrites and truth tests. */

export const VALID_WIDTHS = new Set([1, 8, 16, 32, 64, 128]);

export function normalizeWidth(bits, fallback = 64) {
  const n = Number(bits || fallback);
  return Number.isInteger(n) && n > 0 && n <= 128 ? n : fallback;
}

export function maskFor(bits) {
  bits = normalizeWidth(bits);
  return (1n << BigInt(bits)) - 1n;
}

export function u(value, bits = 64) {
  bits = normalizeWidth(bits);
  return BigInt.asUintN(bits, BigInt(value));
}

export function s(value, bits = 64) {
  bits = normalizeWidth(bits);
  return BigInt.asIntN(bits, BigInt(value));
}

export function boolValue(value) { return BigInt(value) === 0n ? 0n : 1n; }

export function trunc(value, bits) { return u(value, bits); }
export function zext(value, fromBits, toBits) { return u(u(value, fromBits), toBits); }
export function sext(value, fromBits, toBits) { return u(s(value, fromBits), toBits); }

function shiftAmount(v, bits) {
  bits = normalizeWidth(bits);
  if (bits <= 1) return 0n;
  return u(v, bits) % BigInt(bits);
}

export function evalUnary(op, value, bits = 64, fromBits = bits) {
  bits = normalizeWidth(bits);
  switch (op) {
    case 'neg': return u(-u(value, bits), bits);
    case 'not': return u(~u(value, bits), bits);
    case 'bool': return boolValue(value);
    case 'lnot': return boolValue(value) ? 0n : 1n;
    case 'trunc': return trunc(value, bits);
    case 'zext': return zext(value, fromBits, bits);
    case 'sext': return sext(value, fromBits, bits);
    case 'abs': {
      const sv = s(value, bits);
      return u(sv < 0n ? -sv : sv, bits);
    }
    case 'clz': {
      const x = u(value, bits);
      if (x === 0n) return BigInt(bits);
      let n = 0n;
      for (let i = bits - 1; i >= 0; i--) {
        if (((x >> BigInt(i)) & 1n) !== 0n) break;
        n++;
      }
      return n;
    }
    case 'rbit': {
      let x = u(value, bits), out = 0n;
      for (let i = 0; i < bits; i++) { out = (out << 1n) | (x & 1n); x >>= 1n; }
      return out;
    }
    case 'rev': {
      if (bits % 8) return u(value, bits);
      let x = u(value, bits), out = 0n;
      for (let i = 0; i < bits / 8; i++) { out = (out << 8n) | (x & 0xffn); x >>= 8n; }
      return u(out, bits);
    }
    default: return null;
  }
}

export function evalBinary(op, av, bv, bits = 64, signed = null) {
  bits = normalizeWidth(bits);
  const a = u(av, bits), b = u(bv, bits);
  switch (op) {
    case 'add': return u(a + b, bits);
    case 'sub': return u(a - b, bits);
    case 'mul': return u(a * b, bits);
    case 'and': return u(a & b, bits);
    case 'or': return u(a | b, bits);
    case 'xor': return u(a ^ b, bits);
    case 'shl': return u(a << shiftAmount(b, bits), bits);
    case 'lshr': return u(a >> shiftAmount(b, bits), bits);
    case 'ashr': return u(s(a, bits) >> shiftAmount(b, bits), bits);
    case 'ror': {
      const sh = Number(shiftAmount(b, bits));
      if (!sh) return a;
      return u((a >> BigInt(sh)) | (a << BigInt(bits - sh)), bits);
    }
    case 'sdiv': {
      const d = s(b, bits);
      if (d === 0n) return null;
      const n = s(a, bits);
      return u(n / d, bits);
    }
    case 'udiv': return b === 0n ? null : u(a / b, bits);
    case 'smod': {
      const d = s(b, bits); if (d === 0n) return null;
      return u(s(a, bits) % d, bits);
    }
    case 'umod': return b === 0n ? null : u(a % b, bits);
    case 'eq': return a === b ? 1n : 0n;
    case 'ne': return a !== b ? 1n : 0n;
    case 'lt': return (signed === false ? a < b : s(a, bits) < s(b, bits)) ? 1n : 0n;
    case 'le': return (signed === false ? a <= b : s(a, bits) <= s(b, bits)) ? 1n : 0n;
    case 'gt': return (signed === false ? a > b : s(a, bits) > s(b, bits)) ? 1n : 0n;
    case 'ge': return (signed === false ? a >= b : s(a, bits) >= s(b, bits)) ? 1n : 0n;
    default: return null;
  }
}

export function fitsUnsigned(value, bits) { return u(value, bits) === BigInt(value); }
export function fitsSigned(value, bits) { return s(value, bits) === BigInt(value); }
export function fullMask(bits) { return maskFor(bits); }
export function isPowerOfTwo(v) { v = BigInt(v); return v > 0n && (v & (v - 1n)) === 0n; }
export function log2Exact(v) {
  if (!isPowerOfTwo(v)) return null;
  let n = 0;
  for (let x = BigInt(v); x > 1n; x >>= 1n) n++;
  return n;
}
