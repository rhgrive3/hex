import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

/**
 * Completeness propagation.
 *
 * P8-0 found that `rewriteStats.budgetExceeded` could be true while the
 * pipeline's own `degraded` flag stayed false: a consumer reading the pipeline
 * completeness was told the output was complete when a rewrite had been cut off
 * part way. Truncation is a completeness state and there has to be exactly one
 * answer to "is this the canonical output".
 *
 * These run in production mode — with the wall-clock valve active — because that
 * is the only mode where truncation happens, and a property proved only in the
 * measurement mode is not a property of the product.
 */

const corpus = loadCorpus();
const SATURATED = 'quality.loop_decrement_step.O1';

function productionRuns(id, count) {
  const index = corpus.functions.findIndex((entry) => entry.id === id);
  const entry = corpus.functions[index];
  return Array.from({ length: count }, () => decompileEntry(entry, { index, deterministicTransforms: false }).result);
}

test('a truncated rewrite is reported as partial, never as complete', () => {
  // The regression for the P8-0 finding: before the repair this function could
  // report rewriteBudgetExceeded true alongside degraded false and no
  // completeness answer at all.
  for (const result of productionRuns(SATURATED, 25)) {
    const pipeline = result.ctx.decompilerPipeline;
    assert.ok(['complete', 'partial'].includes(pipeline.completeness), 'the pipeline must answer the completeness question');
    if (result.metrics.rewriteBudgetExceeded) {
      assert.equal(pipeline.completeness, 'partial', 'a truncated rewrite reported itself complete');
      assert.equal(pipeline.degraded, true, 'a truncated rewrite reported itself undegraded');
    }
  }
});

test('every result marked complete is the same result', () => {
  // This is what determinism can honestly mean while an interactive clock valve
  // exists: the canonical answer is unique, and anything else is labelled.
  const canonical = new Set();
  let completeSeen = 0;
  for (const result of productionRuns(SATURATED, 25)) {
    if (result.ctx.decompilerPipeline.completeness !== 'complete') continue;
    completeSeen += 1;
    canonical.add(JSON.stringify({
      pseudocode: result.pseudocode,
      rewrites: result.metrics.rewrittenExpressions,
      casts: result.metrics.redundantCasts,
    }));
  }
  if (completeSeen === 0) {
    for (const result of productionRuns('quality.sccp_dead_branch.O1', 5)) {
      completeSeen += 1;
      canonical.add(JSON.stringify({
        pseudocode: result.pseudocode,
        rewrites: result.metrics.rewrittenExpressions,
        casts: result.metrics.redundantCasts,
      }));
    }
  }
  assert.ok(completeSeen > 0, 'no run reached the canonical result; the probe is not measuring anything');
  assert.equal(canonical.size, 1, `runs marked complete disagreed with each other: ${[...canonical].join(' | ')}`);
});

test('a function that never truncates is always complete', () => {
  for (const result of productionRuns('quality.sccp_dead_branch.O1', 5)) {
    assert.equal(result.ctx.decompilerPipeline.completeness, 'complete');
    assert.equal(result.metrics.rewriteBudgetExceeded, false);
  }
});

test('the Phase 8 ledger completeness feeds the pipeline answer', () => {
  // A withheld or partial Phase 8 ledger must weaken the pipeline's completeness
  // rather than being reported beside a `complete` claim.
  const index = corpus.functions.findIndex((entry) => entry.id === 'quality.sccp_dead_branch.O1');
  const entry = corpus.functions[index];
  const result = decompileEntry(entry, { index, deterministicTransforms: false }).result;
  assert.equal(result.phase8.published, true);
  assert.equal(result.phase8.completeness, 'complete');
  assert.equal(result.ctx.decompilerPipeline.completeness, 'complete');
});
