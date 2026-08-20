import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bvSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBv,
  createBinary,
  createCompare,
} from '../../../js/symbolic/expr/factory.js';
import {
  evaluateExpr,
  EVAL_STATUS,
} from '../../../js/symbolic/expr/evaluate.js';
import {
  bvAdd,
  bvSub,
  bvMul,
  bvUdiv,
  bvSdiv,
  bvShl,
  bvLshr,
  bvAshr,
  toSigned,
  toUnsigned,
} from '../../../js/symbolic/expr/bitvector.js';

test('adversarial small-width exhaustive verification (BV1..BV4)', () => {
  // Exhaustive check for BV2 all binary ops (4 x 4 = 16 pairs)
  for (let a = 0n; a < 4n; a++) {
    for (let b = 0n; b < 4n; b++) {
      // Add
      const sum = (a + b) % 4n;
      assert.equal(bvAdd(a, b, 2), sum);

      // Sub
      const sub = (a - b + 4n) % 4n;
      assert.equal(bvSub(a, b, 2), sub);

      // Mul
      const mul = (a * b) % 4n;
      assert.equal(bvMul(a, b, 2), mul);

      // Shl
      const shl = b >= 2n ? 0n : (a << b) % 4n;
      assert.equal(bvShl(a, b, 2), shl);

      // Lshr
      const lshr = b >= 2n ? 0n : (a >> b) % 4n;
      assert.equal(bvLshr(a, b, 2), lshr);
    }
  }

  // Exhaustive check for BV3 signed min / -1 overflow
  // For BV3, min signed is -4 (which is 4n unsigned in BV3: 100_2 = 4)
  // -1 is 7n unsigned in BV3 (111_2 = 7)
  const minIntBv3 = 4n;
  const minusOneBv3 = 7n;
  assert.equal(toSigned(minIntBv3, 3), -4n);
  assert.equal(toSigned(minusOneBv3, 3), -1n);
  assert.equal(bvSdiv(minIntBv3, minusOneBv3, 3), minIntBv3); // wraps to minInt (-4)
});

test('adversarial width distinction: BV8(0xFF) vs BV32(0xFF)', () => {
  const bv8 = createBv(8, 0xFF);
  const bv32 = createBv(32, 0xFF);

  // Semantics are completely different:
  // In signed interpretation: BV8(0xFF) is -1, BV32(0xFF) is +255
  assert.equal(toSigned(bv8.value, bv8.sort.width), -1n);
  assert.equal(toSigned(bv32.value, bv32.sort.width), 255n);

  // Type system forbids mixing them directly without explicit cast
  assert.throws(() => createBinary(BV_BINARY_OP.ADD, bv8, bv32), TypeError);
  assert.throws(() => createCompare(BV_COMPARE_OP.EQ, bv8, bv32), TypeError);
});

test('adversarial division by zero: pure evaluator and bitvector helper return deterministic safe results', () => {
  const cZero8 = createBv(8, 0);
  const cFive8 = createBv(8, 5);

  const udivByZero = createBinary(BV_BINARY_OP.UDIV, cFive8, cZero8);
  const sdivByZero = createBinary(BV_BINARY_OP.SDIV, cFive8, cZero8);
  const uremByZero = createBinary(BV_BINARY_OP.UREM, cFive8, cZero8);
  const sremByZero = createBinary(BV_BINARY_OP.SREM, cFive8, cZero8);

  const resUdiv = evaluateExpr(udivByZero);
  const resSdiv = evaluateExpr(sdivByZero);
  const resUrem = evaluateExpr(uremByZero);
  const resSrem = evaluateExpr(sremByZero);

  assert.equal(resUdiv.status, EVAL_STATUS.VALUE);
  assert.equal(resUdiv.value, 255n); // mask(8)

  assert.equal(resSdiv.status, EVAL_STATUS.VALUE);
  assert.equal(resSdiv.value, 255n); // -1 (mask) for positive / 0

  assert.equal(resUrem.status, EVAL_STATUS.VALUE);
  assert.equal(resUrem.value, 5n);

  assert.equal(resSrem.status, EVAL_STATUS.VALUE);
  assert.equal(resSrem.value, 5n);
});
