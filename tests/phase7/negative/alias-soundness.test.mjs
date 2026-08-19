import assert from 'node:assert/strict';
import test from 'node:test';

import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { ALIAS_QUERIES, buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';

const solvers = new Map();
function answer(query) {
  const built = buildFixture(query.fixture);
  if (!solvers.has(built)) solvers.set(built, createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa }));
  return solvers.get(built).alias(regionOf(built, query.left), regionOf(built, query.right), {
    leftAccess: memoryAccessOf(built, query.left),
    rightAccess: memoryAccessOf(built, query.right),
  });
}

/**
 * The negative corpus. Every case here has a strong answer that is provably
 * wrong; returning it is a stop-the-line soundness failure, not a precision
 * miss (§24.1).
 */
test('no query in the frozen set produces a false NoAlias or MustAlias', () => {
  for (const query of ALIAS_QUERIES) {
    const result = answer(query);
    if (query.truth === 'may-or-weaker') {
      assert.ok(['may', 'unknown'].includes(result.relation),
        `${query.id}: strong answer ${result.relation} where no strong answer is true (${result.reasonCodes.join(',')})`);
    } else {
      assert.notEqual(result.relation, query.truth === 'no' ? 'must' : 'no',
        `${query.id}: answered the opposite strong relation`);
    }
  }
});

test('overlapping stack intervals are never separated', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-stack-overlapping'));
  assert.notEqual(result.relation, 'no', 'two 8-byte accesses 4 bytes apart overlap');
});

test('a same-root access at an unbounded offset stays weak in both directions', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-uncertain-offset'));
  assert.ok(['may', 'unknown'].includes(result.relation));
  assert.ok(result.reasonCodes.length > 0, 'even a weak answer must be explainable');
});

test('provenance lost through an integer round trip blocks separation', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-provenance-loss'));
  assert.ok(['may', 'unknown'].includes(result.relation));
});

test('a pointer phi over distinct offsets is not separated from either arm', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-pointer-phi'));
  assert.ok(['may', 'unknown'].includes(result.relation),
    `phi-merged pointer answered ${result.relation}`);
});

test('a cyclic pointer phi terminates and does not manufacture a small range', () => {
  const built = buildFixture('cyclic-pointer-phi');
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa });
  const run = solver.pointsToRun();
  assert.ok(run.iterations > 0 && run.iterations <= 32, `fixed point did not terminate cleanly: ${run.iterations}`);
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-cyclic-phi'));
  assert.ok(['may', 'unknown'].includes(result.relation),
    'a widened, unbounded offset must not wrap into a provably disjoint interval');
});

test('overlapping fields are not separated by their labels', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-overlapping-fields'));
  assert.notEqual(result.relation, 'no', 'a 2-byte field inside an 8-byte field overlaps it');
});

test('two similar-looking opaque roots are neither identified nor separated', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-similar-roots'));
  assert.ok(['may', 'unknown'].includes(result.relation));
  assert.ok(result.reasonCodes.includes('escape-unproven') || result.reasonCodes.includes('unresolved-root'),
    'distinct roots without escape evidence must say so');
});

test('a pointer read out of memory is an unresolved boundary', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-load-derived'));
  assert.ok(['may', 'unknown'].includes(result.relation));
});

test('the Phase 7 solver is never weaker than the conservative floor', () => {
  // Precision may be gained, never traded: if the floor could prove it, so
  // must the solver, or a supposedly better analyser is a regression.
  const strength = { unknown: 0, may: 1, must: 2, no: 2 };
  for (const query of ALIAS_QUERIES) {
    const built = buildFixture(query.fixture);
    const floor = aliasMemoryRegions(regionOf(built, query.left), regionOf(built, query.right));
    const candidate = answer(query).relation;
    assert.ok(strength[candidate] >= strength[floor],
      `${query.id}: solver (${candidate}) is weaker than the floor (${floor})`);
  }
});

test('every strong answer carries a proof reason of the matching class', () => {
  for (const query of ALIAS_QUERIES) {
    const result = answer(query);
    if (result.relation === 'no') {
      assert.ok(result.reasonCodes.some((code) => code.startsWith('disjoint-') || code.startsWith('distinct-')),
        `${query.id}: NoAlias without a separation proof`);
    }
    if (result.relation === 'must') {
      assert.ok(result.reasonCodes.some((code) => code.startsWith('identical-')),
        `${query.id}: MustAlias without an identity proof`);
    }
  }
});

test('a cancelled solve never yields a strong answer', () => {
  const built = buildFixture('stack-disjoint');
  const controller = new AbortController();
  controller.abort();
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa, options: { signal: controller.signal },
  });
  const query = ALIAS_QUERIES.find((item) => item.id === 'q-stack-disjoint');
  const result = solver.alias(regionOf(built, query.left), regionOf(built, query.right), {
    leftAccess: memoryAccessOf(built, query.left),
    rightAccess: memoryAccessOf(built, query.right),
  });
  assert.ok(['may', 'unknown'].includes(result.relation),
    'a cancelled run must not publish the separation it would have proven');
  assert.notEqual(result.status.completeness, 'complete');
});
