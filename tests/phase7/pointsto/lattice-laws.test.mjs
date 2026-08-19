import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOTTOM_POINTS_TO,
  POINTS_TO_DEFAULT_BUDGET,
  UNBOUNDED_RANGE,
  addRange,
  addRanges,
  createOffsetRange,
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  joinPointsTo,
  joinRange,
  pointsToDigest,
  pointsToEqual,
  pointsToLessOrEqual,
  rangeRelation,
  topPointsTo,
  widenPointsTo,
  widenRange,
} from '../../../js/analysis/pointsto/lattice.js';

const target = (root, min, max, widthBits = 64) => createPointsToTarget({
  rootKind: 'rooted', rootEntityId: root, offsetRange: createOffsetRange(min, max), widthBits,
});
const set = (...targets) => createPointsToSet({ targets });

/** Deterministic pseudo-random source: a fixed seed makes failures reproducible. */
function* seeded(seed, count) {
  let state = BigInt(seed);
  for (let index = 0; index < count; index += 1) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    yield BigInt.asIntN(32, state >> 16n);
  }
}

test('range join is commutative, associative and idempotent', () => {
  const values = [...seeded(7, 24)];
  for (let index = 0; index + 5 < values.length; index += 6) {
    const a = createOffsetRange(values[index], values[index] + 8n);
    const b = createOffsetRange(values[index + 1], values[index + 1] + 8n);
    const c = createOffsetRange(values[index + 2], values[index + 2] + 8n);
    assert.deepEqual(joinRange(a, b), joinRange(b, a));
    assert.deepEqual(joinRange(joinRange(a, b), c), joinRange(a, joinRange(b, c)));
    assert.deepEqual(joinRange(a, a), a);
  }
});

test('range join is monotone: the result contains both inputs', () => {
  for (const value of seeded(11, 16)) {
    const a = createOffsetRange(value, value + 4n);
    const b = createOffsetRange(value - 32n, value + 64n);
    const joined = joinRange(a, b);
    assert.ok(joined.min <= a.min && joined.max >= a.max);
    assert.ok(joined.min <= b.min && joined.max >= b.max);
  }
});

test('widening throws any end that moved outward to infinity', () => {
  const previous = createOffsetRange(0n, 8n);
  assert.deepEqual(widenRange(previous, createOffsetRange(0n, 8n)), previous, 'a stable range is not widened');
  assert.equal(widenRange(previous, createOffsetRange(0n, 16n)).max, null);
  assert.equal(widenRange(previous, createOffsetRange(-8n, 8n)).min, null);
});

test('widening terminates a growing loop-carried range', () => {
  // Simulates a pointer advanced by a constant stride on a back edge. Without
  // widening this never converges; with it, convergence must be reached in a
  // bounded number of steps and the result must be unbounded, not small.
  let current = exactRange(0n);
  let previous = null;
  let steps = 0;
  for (; steps < 64; steps += 1) {
    const next = joinRange(current, addRange(current, 8n, 64).range);
    const widened = steps >= 3 ? widenRange(previous ?? current, next) : next;
    if (widened.min === current.min && widened.max === current.max) break;
    previous = current;
    current = widened;
  }
  assert.ok(steps < 64, 'widening failed to converge');
  assert.equal(current.max, null, 'a growing range must end unbounded, not clamped to a small interval');
});

test('checked addition never wraps a signed offset', () => {
  const bounds = [63, 64, 32];
  for (const widthBits of bounds) {
    const half = 1n << BigInt(widthBits - 1);
    const nearMax = createOffsetRange(half - 4n, half - 4n);
    assert.equal(addRange(nearMax, 8n, widthBits).lost, 'width-overflow');
    assert.equal(addRange(nearMax, 8n, widthBits).range.max, null);
    const nearMin = createOffsetRange(-half + 4n, -half + 4n);
    assert.equal(addRange(nearMin, -8n, widthBits).lost, 'width-overflow');
  }
  assert.equal(addRange(exactRange(0n), 8n, 64).range.min, 8n);
});

test('adding two ranges is bounded by the same width check', () => {
  const half = 1n << 63n;
  assert.equal(addRanges(createOffsetRange(half - 2n, half - 1n), exactRange(4n), 64).lost, 'width-overflow');
  assert.deepEqual(addRanges(exactRange(4n), exactRange(8n), 64).range, exactRange(12n));
  assert.equal(addRanges(UNBOUNDED_RANGE, exactRange(8n), 64).range.min, null);
});

test('an unbounded range never yields a separation verdict', () => {
  assert.equal(rangeRelation(UNBOUNDED_RANGE, 4n, exactRange(1000n), 4n), 'may');
  assert.equal(rangeRelation(exactRange(0n), 4n, UNBOUNDED_RANGE, 4n), 'may');
});

test('interval relations follow byte extents, not labels', () => {
  assert.equal(rangeRelation(exactRange(0n), 4n, exactRange(4n), 4n), 'no');
  assert.equal(rangeRelation(exactRange(0n), 8n, exactRange(4n), 8n), 'may');
  assert.equal(rangeRelation(exactRange(0n), 4n, exactRange(0n), 4n), 'must');
  assert.equal(rangeRelation(exactRange(0n), 8n, exactRange(0n), 4n), 'may', 'same start, different width is not identity');
  assert.equal(rangeRelation(createOffsetRange(0n, 8n), 4n, createOffsetRange(64n, 72n), 4n), 'no');
  assert.equal(rangeRelation(createOffsetRange(0n, 64n), 4n, createOffsetRange(32n, 96n), 4n), 'may');
});

test('a zero or unknown access width never separates', () => {
  assert.equal(rangeRelation(exactRange(0n), 0n, exactRange(64n), 4n), 'unknown');
  assert.equal(rangeRelation(exactRange(0n), null, exactRange(64n), 4n), 'unknown');
});

test('set join is commutative and monotone', () => {
  const a = set(target('root_a', 0n, 0n));
  const b = set(target('root_b', 8n, 8n));
  assert.equal(pointsToDigest(joinPointsTo(a, b)), pointsToDigest(joinPointsTo(b, a)));
  assert.ok(pointsToLessOrEqual(a, joinPointsTo(a, b)));
  assert.ok(pointsToLessOrEqual(b, joinPointsTo(a, b)));
});

test('bottom is the join identity and top is absorbing', () => {
  const a = set(target('root_a', 0n, 0n));
  assert.ok(pointsToEqual(joinPointsTo(BOTTOM_POINTS_TO, a), a));
  assert.ok(joinPointsTo(a, topPointsTo('unresolved-load')).top);
  assert.ok(joinPointsTo(topPointsTo('unresolved-load'), a).top);
});

test('bottom and top are different things', () => {
  // Bottom means "nothing has flowed here yet"; top means "could be anywhere".
  // Conflating them would turn an unvisited value into a separation proof.
  assert.equal(BOTTOM_POINTS_TO.top, false);
  assert.equal(BOTTOM_POINTS_TO.targets.length, 0);
  assert.equal(topPointsTo('unresolved-load').top, true);
  assert.ok(!pointsToEqual(BOTTOM_POINTS_TO, topPointsTo('unresolved-load')));
});

test('same-root targets merge their ranges rather than accumulating', () => {
  const joined = joinPointsTo(set(target('root_a', 0n, 0n)), set(target('root_a', 32n, 32n)));
  assert.equal(joined.targets.length, 1);
  assert.equal(joined.targets[0].offsetRange.min, 0n);
  assert.equal(joined.targets[0].offsetRange.max, 32n);
});

test('exceeding the target cap collapses to top rather than dropping a target', () => {
  // Dropping a target would silently prove separation from whatever was
  // dropped. Collapsing to top loses precision instead.
  let accumulated = BOTTOM_POINTS_TO;
  for (let index = 0; index <= POINTS_TO_DEFAULT_BUDGET.maxTargetsPerSet + 1; index += 1) {
    accumulated = joinPointsTo(accumulated, set(target(`root_${index}`, 0n, 0n)));
  }
  assert.equal(accumulated.top, true);
  assert.ok(accumulated.lossReasons.includes('target-cap'));
});

test('set widening is idempotent once stable', () => {
  const stable = set(target('root_a', 0n, 8n));
  assert.ok(pointsToEqual(widenPointsTo(stable, stable), stable));
});

test('digests are stable across construction order', () => {
  const left = createPointsToSet({ targets: [target('root_b', 0n, 0n), target('root_a', 0n, 0n)] });
  const right = createPointsToSet({ targets: [target('root_a', 0n, 0n), target('root_b', 0n, 0n)] });
  assert.equal(pointsToDigest(left), pointsToDigest(right));
});

test('an inverted range is rejected rather than silently normalised', () => {
  assert.throws(() => createOffsetRange(8n, 0n), /invalid-offset-range/);
});
