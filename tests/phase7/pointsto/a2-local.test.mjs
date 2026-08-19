import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { pointsToDigest } from '../../../js/analysis/pointsto/lattice.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';

const run = (fixtureId, options = {}) => {
  const built = buildFixture(fixtureId);
  return { built, result: analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, options) };
};

test('exact frame offsets are recovered as singleton exact ranges', () => {
  const { result } = run('stack-disjoint');
  const zero = result.pointsTo.get('p0');
  const eight = result.pointsTo.get('p8');
  assert.equal(zero.top, false);
  assert.equal(zero.targets.length, 1);
  assert.equal(zero.targets[0].offsetRange.exact, true);
  assert.equal(zero.targets[0].offsetRange.min, 0n);
  assert.equal(eight.targets[0].offsetRange.min, 8n);
  assert.equal(zero.targets[0].rootKey, eight.targets[0].rootKey,
    'both offsets must resolve to the same canonical frame root');
});

test('field sensitivity proves separation the region floor cannot', () => {
  // The whole point of A2: region identity alone gives two different synthetic
  // roots here, so the floor can only say `may`.
  const built = buildFixture('stack-disjoint');
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa });
  const result = solver.alias(regionOf(built, 'node_st0'), regionOf(built, 'node_st8'), {
    leftAccess: memoryAccessOf(built, 'node_st0'),
    rightAccess: memoryAccessOf(built, 'node_st8'),
  });
  assert.equal(result.relation, 'no');
  assert.deepEqual(result.reasonCodes, ['disjoint-field-interval']);
});

test('the result is deterministic for a fixed snapshot and options', () => {
  const first = run('cyclic-pointer-phi').result;
  const second = run('cyclic-pointer-phi').result;
  for (const [id, set] of first.pointsTo) {
    assert.equal(pointsToDigest(set), pointsToDigest(second.pointsTo.get(id)), `nondeterministic result for ${id}`);
  }
  assert.equal(first.iterations, second.iterations);
});

test('a loop-carried pointer converges under widening', () => {
  const { result } = run('cyclic-pointer-phi');
  assert.equal(result.status.completeness, 'complete', 'the solve terminated on its own, not on the iteration cap');
  const current = result.pointsTo.get('cur');
  assert.ok(current, 'the loop pointer must have a points-to answer');
  if (!current.top) {
    // Whatever it converged to, it must not be a small exact interval: the
    // pointer really does advance without a proven bound.
    assert.ok(current.targets.every((target) => !target.offsetRange.exact || target.offsetRange.min === 0n),
      'a growing loop pointer must not converge to a false exact offset');
  }
});

test('an iteration cap reports truncated, never complete', () => {
  const { result } = run('cyclic-pointer-phi', { budget: { maxIterations: 1, widenAfterIterations: 99 } });
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'iteration-limit');
});

test('cancellation reports partial and never complete', () => {
  const controller = new AbortController();
  controller.abort();
  const { result } = run('stack-disjoint', { signal: controller.signal });
  assert.notEqual(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, 'cancelled');
});

test('a value the solve never reaches reports top, not an empty set', () => {
  const { result } = run('stack-disjoint');
  for (const [id, set] of result.pointsTo) {
    assert.ok(set.top || set.targets.length > 0, `bottom leaked into the published answer for ${id}`);
  }
});

test('a pointer read from memory is top with an explicit loss reason', () => {
  const { result } = run('load-derived-pointer');
  const loaded = result.pointsTo.get('loaded');
  assert.equal(loaded.top, true);
  assert.ok(loaded.lossReasons.includes('unresolved-load'));
});

test('a pointer narrowed and re-widened loses provenance explicitly', () => {
  const { result } = run('provenance-loss');
  const widened = result.pointsTo.get('widened');
  assert.equal(widened.top, true);
  assert.ok(widened.lossReasons.includes('integer-to-pointer'));
});

test('a displacement by an unbounded value unbounds the offset but keeps the root', () => {
  const { result } = run('uncertain-offset');
  const indexed = result.pointsTo.get('pn');
  if (!indexed.top) {
    assert.ok(indexed.targets.every((target) => target.offsetRange.min == null || target.offsetRange.max == null),
      'an unbounded displacement must not leave a bounded interval');
  }
});

test('a select over two roots merges both, never picks one', () => {
  const { result } = run('select-distinct-roots');
  const chosen = result.pointsTo.get('chosen');
  assert.ok(chosen.top || chosen.targets.length >= 2,
    'a runtime choice between two objects must keep both possibilities');
});

test('a budget that cannot hold the function reports unsupported', () => {
  const { result } = run('stack-disjoint', { budget: { maxValues: 1 } });
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.equal(result.pointsTo.size, 0);
});

test('the solve is demand-driven: no work happens until a query is asked', () => {
  // Opening a binary must not trigger a whole-program solve (P7-INV-009).
  const built = buildFixture('cyclic-pointer-phi');
  let solves = 0;
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: { onSolve: () => { solves += 1; } },
  });
  assert.equal(solves, 0);
  assert.equal(solver.pointsToRun() === solver.pointsToRun(), true,
    'the per-function solve must be computed once and reused');
});
