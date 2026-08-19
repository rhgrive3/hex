import assert from 'node:assert/strict';
import test from 'node:test';

import { bitvector } from '../../../js/decompiler/phase8/bitvector.js';
import {
  cardinality, contains, describeRange, emptyRange, evaluateBinaryRange, fullRange,
  isFull, join, rangeOf, sameRange, signExtendRange, singleton, truncateRange, widen, zeroExtendRange,
} from '../../../js/decompiler/phase8/range.js';

/**
 * The rule under test everywhere: when the domain cannot represent an answer
 * exactly it widens, and it never invents a tighter one. False precision in a
 * decompiler becomes a confident wrong claim in the interface.
 */

test('a wrapped range is a real set, not an empty one', () => {
  const wrapped = rangeOf(0xFFFFFFF0n, 0x0Fn, 32);
  assert.equal(wrapped.kind, 'wrapped');
  assert.equal(cardinality(wrapped), 32n);
  assert.equal(contains(wrapped, 0xFFFFFFF8n), true);
  assert.equal(contains(wrapped, 0x00n), true);
  assert.equal(contains(wrapped, 0x10n), false);
  assert.equal(contains(wrapped, 0x8000_0000n), false);
});

test('an interval covering the whole width is full however it is spelled', () => {
  assert.equal(isFull(rangeOf(0n, 0xFFFFFFFFn, 32)), true);
  assert.equal(isFull(rangeOf(5n, 4n, 32)), true, 'a wrapped range that meets itself is everything');
  assert.equal(cardinality(fullRange(8)), 256n);
});

test('the empty range contains nothing and is not the full range', () => {
  const empty = emptyRange(32);
  assert.equal(cardinality(empty), 0n);
  assert.equal(contains(empty, 0n), false);
  assert.equal(sameRange(empty, fullRange(32)), false);
});

test('join covers both operands and prefers the smaller hull', () => {
  const left = rangeOf(0n, 10n, 32);
  const right = rangeOf(20n, 30n, 32);
  const united = join(left, right);
  for (const point of [0n, 10n, 20n, 30n]) assert.equal(contains(united, point), true);
  assert.equal(cardinality(united) <= cardinality(fullRange(32)), true);
  // Joining with the full range is the full range; joining with empty is a no-op.
  assert.equal(isFull(join(left, fullRange(32))), true);
  assert.equal(sameRange(join(left, emptyRange(32)), left), true);
});

test('join is idempotent, which is what makes the ascending chain finite', () => {
  const range = rangeOf(0xFFFFFFF0n, 0x0Fn, 32);
  assert.equal(sameRange(join(range, range), range), true);
  assert.equal(sameRange(join(join(range, range), range), range), true);
});

test('widening goes to full rather than climbing forever', () => {
  const previous = rangeOf(0n, 10n, 32);
  assert.equal(sameRange(widen(previous, previous), previous), true, 'a stable range is not widened');
  assert.equal(isFull(widen(previous, rangeOf(0n, 11n, 32))), true);
});

test('zero extension is exact for an interval and honest about a wrapped source', () => {
  const exact = zeroExtendRange(rangeOf(1n, 100n, 32), 64);
  assert.equal(exact.exact, true);
  assert.equal(exact.range.lower, 1n);
  assert.equal(exact.range.upper, 100n);

  // A wrapped 32-bit range becomes two disjoint intervals at 64 bits, which this
  // domain cannot represent. The bound that survives is the source width.
  const wrapped = zeroExtendRange(rangeOf(0xFFFFFFF0n, 0x0Fn, 32), 64);
  assert.equal(wrapped.exact, false);
  assert.ok(wrapped.reason);
  assert.equal(contains(wrapped.range, 0xFFFFFFF0n), true);
  assert.equal(contains(wrapped.range, 0x1_0000_0000n), false, 'the extension must not claim values above the source width');
});

test('sign extension refuses a range that straddles the sign boundary', () => {
  const positive = signExtendRange(rangeOf(1n, 100n, 32), 64);
  assert.equal(positive.exact, true);
  assert.equal(positive.range.lower, 1n);

  const negative = signExtendRange(rangeOf(0xFFFFFF00n, 0xFFFFFFF0n, 32), 64);
  assert.equal(negative.exact, true);
  assert.equal(contains(negative.range, 0xFFFFFFFF_FFFFFF00n), true);

  const straddling = signExtendRange(rangeOf(0x7FFFFFFFn, 0x80000000n, 32), 64);
  assert.equal(straddling.exact, false);
  assert.equal(isFull(straddling.range), true);
});

test('truncation is exact only when the range fits the narrower width', () => {
  const fits = truncateRange(rangeOf(1n, 100n, 32), 8);
  assert.equal(fits.exact, true);
  assert.equal(fits.range.upper, 100n);

  const overflows = truncateRange(rangeOf(1n, 1000n, 32), 8);
  assert.equal(overflows.exact, false);
  assert.equal(isFull(overflows.range), true);
});

test('addition is exact while the result fits one interval and unknown after', () => {
  const exact = evaluateBinaryRange('add', rangeOf(1n, 10n, 32), rangeOf(2n, 3n, 32));
  assert.equal(exact.exact, true);
  assert.equal(exact.range.lower, 3n);
  assert.equal(exact.range.upper, 13n);

  // Two halves of the space still sum to one interval: [0,0x7FFFFFFF] twice
  // cannot reach 0xFFFFFFFF, and saying so is exact, not optimistic.
  const halves = evaluateBinaryRange('add', rangeOf(0n, 0x7FFFFFFFn, 32), rangeOf(0n, 0x7FFFFFFFn, 32));
  assert.equal(halves.exact, true);
  assert.equal(halves.range.upper, 0xFFFFFFFEn);

  // Once the operands together cover more than the width, the sum is every
  // value; claiming an interval there would exclude values the program reaches.
  const wide = evaluateBinaryRange('add', rangeOf(0n, 0x80000000n, 32), rangeOf(0n, 0x80000000n, 32));
  assert.equal(wide.exact, false);
  assert.equal(isFull(wide.range), true);
  assert.ok(wide.reason);
});

test('addition wraps rather than growing the width', () => {
  // 0xFFFFFFF0..0xFFFFFFF8 plus 0x10 lands on 0x00..0x08. A domain that grew the
  // width instead would claim 0x1_0000_0000, which no 32-bit register holds.
  const wrapped = evaluateBinaryRange('add', rangeOf(0xFFFFFFF0n, 0xFFFFFFF8n, 32), rangeOf(0x10n, 0x10n, 32));
  assert.equal(wrapped.exact, true);
  assert.equal(wrapped.range.lower, 0n);
  assert.equal(wrapped.range.upper, 8n);
  assert.equal(contains(wrapped.range, 0n), true);
  assert.equal(contains(wrapped.range, 9n), false);
  assert.equal(contains(wrapped.range, 0xFFFFFFF0n), false);
});

test('operations with no exact model report full and say why', () => {
  for (const operator of ['mul', 'or', 'xor', 'udiv', 'shl', 'lshr']) {
    const result = evaluateBinaryRange(operator, rangeOf(1n, 10n, 32), rangeOf(1n, 10n, 32));
    assert.equal(isFull(result.range), true, `${operator} must not invent precision`);
    assert.ok(result.reason, `${operator} must record why nothing was proven`);
  }
});

test('masking by a constant bounds the result', () => {
  const masked = evaluateBinaryRange('and', fullRange(32), singleton(bitvector(0xFFn, 32)));
  assert.equal(masked.range.upper, 0xFFn);
  assert.equal(contains(masked.range, 0x100n), false);
});

test('an empty operand produces an empty result, not a full one', () => {
  const result = evaluateBinaryRange('add', emptyRange(32), rangeOf(1n, 2n, 32));
  assert.equal(cardinality(result.range), 0n);
});

test('the description distinguishes the three shapes', () => {
  assert.match(describeRange(fullRange(32)), /^full:32$/);
  assert.match(describeRange(emptyRange(32)), /^empty:32$/);
  assert.match(describeRange(rangeOf(1n, 2n, 32)), /^interval:32/);
  assert.match(describeRange(rangeOf(0xFFFFFFF0n, 1n, 32)), /^wrapped:32/);
});
