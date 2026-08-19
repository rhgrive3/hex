import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { collectPhase7Metrics } from '../../../tools/validation/phase7/metrics.mjs';
import { buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase7/profile.json'), 'utf8'));

/**
 * The measurement procedure is versioned in the profile — fixture identity,
 * repetition count, aggregate statistic, environment class and tolerated
 * variance are all fixed there rather than chosen after the numbers are known
 * (§16). These tests assert the budgets hold, and that the demand-driven
 * property the budgets depend on is real.
 */

test('the performance procedure is frozen in the profile, not chosen ad hoc', () => {
  assert.ok(PROFILE.performance.procedureVersion >= 1);
  assert.equal(PROFILE.performance.aggregate, 'median');
  assert.ok(PROFILE.performance.repetitions >= 3);
  assert.ok(PROFILE.performance.environmentClass);
});

test('cold, warm and pathological latencies stay inside their budgets', async () => {
  const metrics = await collectPhase7Metrics({ repetitions: PROFILE.performance.repetitions });
  for (const [name, result] of Object.entries(metrics.performance)) {
    const budget = PROFILE.performance.budgetsMs[name];
    if (budget == null) continue;
    assert.ok(result.medianMs <= budget, `${name}: ${result.medianMs} ms exceeds the ${budget} ms budget`);
    assert.equal(result.samples.length, PROFILE.performance.repetitions);
  }
});

test('warm queries are cheaper than cold ones, so the per-function solve is reused', () => {
  const built = buildFixture('cyclic-pointer-phi');
  const query = () => {
    const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa });
    solver.pointsToRun();
    return solver;
  };
  const cold = process.hrtime.bigint();
  const solver = query();
  const coldNs = Number(process.hrtime.bigint() - cold);
  const warm = process.hrtime.bigint();
  solver.pointsToRun();
  const warmNs = Number(process.hrtime.bigint() - warm);
  assert.ok(warmNs < coldNs, 'the fixed point was recomputed on a warm query');
});

test('constructing a solver performs no analysis', () => {
  // Opening a large binary must not trigger a whole-program solve, so the
  // solver has to be inert until something actually asks a question.
  const built = buildFixture('cyclic-pointer-phi');
  const started = process.hrtime.bigint();
  createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5, `constructing the solver took ${elapsedMs} ms, which means it solved something`);
});

test('a per-query budget bounds the work rather than the answer quality floor', () => {
  const built = buildFixture('cyclic-pointer-phi');
  const bounded = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: { budget: { maxIterations: 2, widenAfterIterations: 1 } },
  });
  const result = bounded.alias(regionOf(built, 'node_st_cur'), regionOf(built, 'node_st_far'), {
    leftAccess: memoryAccessOf(built, 'node_st_cur'),
    rightAccess: memoryAccessOf(built, 'node_st_far'),
  });
  // Cutting the budget may only make the answer weaker, never stronger.
  assert.ok(['may', 'unknown'].includes(result.relation));
});
