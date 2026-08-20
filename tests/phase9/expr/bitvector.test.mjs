import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mask,
  wrap,
  toUnsigned,
  toSigned,
  bvAdd,
  bvSub,
  bvMul,
  bvUdiv,
  bvUrem,
  bvSdiv,
  bvSrem,
  bvAnd,
  bvOr,
  bvXor,
  bvNot,
  bvNeg,
  bvShl,
  bvLshr,
  bvAshr,
  bvEq,
  bvNe,
  bvUlt,
  bvUle,
  bvUgt,
  bvUge,
  bvSlt,
  bvSle,
  bvSgt,
  bvSge,
  bvTrunc,
  bvZext,
  bvSext,
  bvExtract,
  bvConcat,
} from '../../../js/symbolic/expr/bitvector.js';

test('bitvector masks and wraps correctly across widths', () => {
  assert.equal(mask(1), 1n);
  assert.equal(mask(8), 255n);
  assert.equal(mask(16), 65535n);
  assert.equal(mask(32), 4294967295n);
  assert.equal(mask(64), 18446744073709551615n);

  assert.throws(() => mask(0), RangeError);
  assert.throws(() => mask(-1), RangeError);
  assert.throws(() => mask(1.5), RangeError);

  // Wrap
  assert.equal(wrap(256n, 8), 0n);
  assert.equal(wrap(-1n, 8), 255n);
  assert.equal(wrap(255n, 8), 255n);
  assert.equal(wrap(-1n, 64), 18446744073709551615n);
});

test('bitvector signed vs unsigned conversions', () => {
  assert.equal(toUnsigned(255n, 8), 255n);
  assert.equal(toSigned(255n, 8), -1n);
  assert.equal(toSigned(127n, 8), 127n);
  assert.equal(toSigned(128n, 8), -128n);

  assert.equal(toUnsigned(0xffffffffn, 32), 4294967295n);
  assert.equal(toSigned(0xffffffffn, 32), -1n);
  assert.equal(toSigned(0x80000000n, 32), -2147483648n);
});

test('bitvector arithmetic with exact wraparound', () => {
  // BV8(255) + BV8(1) == BV8(0)
  assert.equal(bvAdd(255n, 1n, 8), 0n);
  // BV8(0) - BV8(1) == BV8(255)
  assert.equal(bvSub(0n, 1n, 8), 255n);
  // BV8(16) * BV8(16) == BV8(0)
  assert.equal(bvMul(16n, 16n, 8), 0n);
  // BV8(15) * BV8(15) == BV8(225)
  assert.equal(bvMul(15n, 15n, 8), 225n);
  // Negation
  assert.equal(bvNeg(1n, 8), 255n);
  assert.equal(bvNeg(0n, 8), 0n);
  assert.equal(bvNeg(128n, 8), 128n); // -(-128) in 8-bit wraps to -128 (0x80)
});

test('bitvector unsigned division and remainder', () => {
  assert.equal(bvUdiv(10n, 3n, 8), 3n);
  assert.equal(bvUrem(10n, 3n, 8), 1n);
  // Division by zero standard: bvudiv(x, 0) = all-ones, bvurem(x, 0) = x
  assert.equal(bvUdiv(10n, 0n, 8), 255n);
  assert.equal(bvUrem(10n, 0n, 8), 10n);
});

test('bitvector signed division and remainder edge cases', () => {
  // 10 / 3
  assert.equal(bvSdiv(10n, 3n, 8), 3n);
  assert.equal(bvSrem(10n, 3n, 8), 1n);
  // -10 / 3 = -3 (which is 253n in unsigned 8-bit)
  assert.equal(bvSdiv(246n, 3n, 8), 253n);
  // -10 % 3 = -1 (255n in unsigned 8-bit)
  assert.equal(bvSrem(246n, 3n, 8), 255n);

  // Signed min overflow: MIN_INT / -1 wraps to MIN_INT
  // MIN_INT for BV8 is -128 (0x80)
  assert.equal(bvSdiv(128n, 255n, 8), 128n);
  assert.equal(bvSrem(128n, 255n, 8), 0n);

  // Division by zero: bvsdiv(x, 0) is (slt x 0) ? 1 : -1
  assert.equal(bvSdiv(10n, 0n, 8), 255n); // positive -> -1 (mask)
  assert.equal(bvSdiv(246n, 0n, 8), 1n);  // negative -> 1
  assert.equal(bvSrem(10n, 0n, 8), 10n);
});

test('bitvector bitwise shifts with saturation and sign-extension', () => {
  // Logical shift left
  assert.equal(bvShl(1n, 4n, 8), 16n);
  assert.equal(bvShl(1n, 8n, 8), 0n); // shift >= width returns 0n
  assert.equal(bvShl(1n, 9n, 8), 0n);

  // Logical shift right
  assert.equal(bvLshr(128n, 4n, 8), 8n);
  assert.equal(bvLshr(128n, 8n, 8), 0n); // shift >= width returns 0n
  assert.equal(bvLshr(128n, 10n, 8), 0n);

  // Arithmetic shift right
  assert.equal(bvAshr(128n, 4n, 8), 248n); // 0x80 >> 4 signed is 0xF8 (248)
  assert.equal(bvAshr(128n, 8n, 8), 255n); // negative shifted >= width fills with 1s (0xFF)
  assert.equal(bvAshr(64n, 8n, 8), 0n);    // positive shifted >= width returns 0
});

test('bitvector comparisons signed vs unsigned', () => {
  // 0xFF (255) vs 0x01 (1) in 8-bit
  const a = 255n; // signed -1, unsigned 255
  const b = 1n;   // signed 1, unsigned 1

  // Unsigned
  assert.equal(bvUlt(a, b, 8), false);
  assert.equal(bvUgt(a, b, 8), true);
  assert.equal(bvUle(a, b, 8), false);
  assert.equal(bvUge(a, b, 8), true);

  // Signed
  assert.equal(bvSlt(a, b, 8), true);
  assert.equal(bvSgt(a, b, 8), false);
  assert.equal(bvSle(a, b, 8), true);
  assert.equal(bvSge(a, b, 8), false);

  // Equality
  assert.equal(bvEq(a, 255n, 8), true);
  assert.equal(bvNe(a, 1n, 8), true);
});

test('bitvector extensions, truncations, slices, and concat', () => {
  // Trunc
  assert.equal(bvTrunc(0x1234n, 16, 8), 0x34n);
  assert.throws(() => bvTrunc(0x1234n, 8, 8), RangeError);
  assert.throws(() => bvTrunc(0x1234n, 8, 16), RangeError);

  // Zext
  assert.equal(bvZext(0x80n, 8, 16), 0x0080n);
  assert.throws(() => bvZext(0x80n, 8, 8), RangeError);

  // Sext
  assert.equal(bvSext(0x80n, 8, 16), 0xff80n);
  assert.equal(bvSext(0x7fn, 8, 16), 0x007fn);

  // Extract
  // Extract bits 7..4 of 0xAB -> 0xA (10)
  assert.equal(bvExtract(0xABn, 8, 7, 4), 0xAn);
  // Extract bits 3..0 of 0xAB -> 0xB (11)
  assert.equal(bvExtract(0xABn, 8, 3, 0), 0xBn);
  assert.throws(() => bvExtract(0xABn, 8, 8, 0), RangeError);
  assert.throws(() => bvExtract(0xABn, 8, 2, 4), RangeError);

  // Concat
  // Concat 0x12 (8-bit) and 0x34 (8-bit) -> 0x1234 (16-bit)
  assert.equal(bvConcat(0x12n, 8, 0x34n, 8), 0x1234n);
});
