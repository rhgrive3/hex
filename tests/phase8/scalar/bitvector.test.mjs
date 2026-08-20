import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bitvector, evaluateBinary, evaluateUnary, extractField, insertField,
  maxSigned, maxUnsigned, minSigned, signExtend, signedOf, truncate, unsignedOf, zeroExtend,
} from '../../../js/decompiler/phase8/bitvector.js';

/**
 * A decompiler that folds `0xFFFFFFF0 + 0x20` into `0x100000010` has invented a
 * 33-bit register. These are the cases where JavaScript numbers, C's undefined
 * behaviour and the machine all disagree, and the machine is right.
 */

test('arithmetic wraps at the declared width', () => {
  assert.equal(evaluateBinary('add', bitvector(0xFFFFFFF0n, 32), bitvector(0x20n, 32)).value, 0x10n);
  assert.equal(evaluateBinary('sub', bitvector(0n, 32), bitvector(1n, 32)).value, 0xFFFFFFFFn);
  assert.equal(evaluateBinary('mul', bitvector(0x10000n, 32), bitvector(0x10000n, 32)).value, 0n);
  assert.equal(evaluateBinary('add', bitvector(maxUnsigned(8), 8), bitvector(1n, 8)).value, 0n);
});

test('signed and unsigned comparison of the same bits disagree, and both are available', () => {
  const negative = bitvector(0xFFFFFFFFn, 32);
  const one = bitvector(1n, 32);
  assert.equal(evaluateBinary('ult', negative, one).value, 0n, '0xFFFFFFFF is the largest unsigned value');
  assert.equal(evaluateBinary('slt', negative, one).value, 1n, 'as signed it is -1');
  assert.equal(signedOf(0xFFFFFFFFn, 32), -1n);
  assert.equal(unsignedOf(-1n, 32), 0xFFFFFFFFn);
});

test('truncation, zero extension and sign extension are distinct', () => {
  const narrow = bitvector(0x80n, 8);
  assert.equal(zeroExtend(narrow, 32).value, 0x80n);
  assert.equal(signExtend(narrow, 32).value, 0xFFFFFF80n);
  assert.equal(truncate(bitvector(0x1234n, 32), 8).value, 0x34n);
  // Widening a value to a narrower width is a caller error, not a wrap.
  assert.equal(zeroExtend(bitvector(1n, 32), 8), null);
  assert.equal(truncate(bitvector(1n, 8), 32), null);
});

test('a shift at or past the width is refused, not guessed', () => {
  // Masked on some targets, zero on others, undefined in C. Generic code does
  // not get to pick, so it declines to fold.
  assert.equal(evaluateBinary('shl', bitvector(1n, 32), bitvector(32n, 32)), null);
  assert.equal(evaluateBinary('lshr', bitvector(1n, 32), bitvector(64n, 32)), null);
  assert.equal(evaluateBinary('ashr', bitvector(1n, 32), bitvector(32n, 32)), null);
  assert.equal(evaluateBinary('shl', bitvector(1n, 32), bitvector(31n, 32)).value, 0x80000000n);
});

test('arithmetic shift right preserves the sign, logical shift right does not', () => {
  const negative = bitvector(0xFFFFFFF0n, 32);
  assert.equal(evaluateBinary('ashr', negative, bitvector(4n, 32)).value, 0xFFFFFFFFn);
  assert.equal(evaluateBinary('lshr', negative, bitvector(4n, 32)).value, 0x0FFFFFFFn);
});

test('division that traps or overflows is refused', () => {
  assert.equal(evaluateBinary('udiv', bitvector(1n, 32), bitvector(0n, 32)), null);
  assert.equal(evaluateBinary('sdiv', bitvector(1n, 32), bitvector(0n, 32)), null);
  // INT_MIN / -1 is not representable at the width.
  assert.equal(evaluateBinary('sdiv', bitvector(minSigned(32), 32), bitvector(-1n, 32)), null);
  assert.equal(evaluateBinary('srem', bitvector(minSigned(32), 32), bitvector(-1n, 32)), null);
  assert.equal(evaluateBinary('sdiv', bitvector(-8n, 32), bitvector(2n, 32)).value, unsignedOf(-4n, 32));
});

test('mixed-width operands are refused rather than silently promoted', () => {
  assert.equal(evaluateBinary('add', bitvector(1n, 32), bitvector(1n, 64)), null);
  assert.equal(evaluateBinary('and', bitvector(1n, 8), bitvector(1n, 32)), null);
});

test('comparisons produce one bit, whatever the operand width', () => {
  for (const bits of [8, 16, 32, 64]) {
    const result = evaluateBinary('eq', bitvector(1n, bits), bitvector(1n, bits));
    assert.equal(result.bits, 1);
    assert.equal(result.value, 1n);
  }
});

test('unary operations respect the width', () => {
  assert.equal(evaluateUnary('not', bitvector(0n, 8)).value, 0xFFn);
  assert.equal(evaluateUnary('neg', bitvector(1n, 16)).value, 0xFFFFn);
  assert.equal(evaluateUnary('is-zero', bitvector(0n, 64)).value, 1n);
  assert.equal(evaluateUnary('is-zero', bitvector(1n, 64)).value, 0n);
  assert.equal(evaluateUnary('rotate-somehow', bitvector(1n, 32)), null);
});

test('bit fields are exact and out-of-range requests are refused', () => {
  assert.equal(extractField(bitvector(0xABCDn, 32), 8, 8).value, 0xABn);
  assert.equal(extractField(bitvector(0xABCDn, 32), 28, 8), null, 'a field past the end must not be clamped');
  assert.equal(insertField(bitvector(0n, 32), bitvector(0xFFn, 8), 8).value, 0xFF00n);
  assert.equal(insertField(bitvector(0n, 32), bitvector(0xFFn, 8), 28), null);
});

test('an unsupported width is an error, not a silent default', () => {
  assert.throws(() => bitvector(1n, 24), /unsupported-width:24/);
  assert.throws(() => unsignedOf(1n, 0), /unsupported-width:0/);
});

test('the signed boundaries are the ones the machine uses', () => {
  assert.equal(maxSigned(8), 127n);
  assert.equal(minSigned(8), -128n);
  assert.equal(maxUnsigned(8), 255n);
  assert.equal(signedOf(0x80n, 8), -128n);
});
