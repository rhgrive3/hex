import assert from 'node:assert/strict';
import test from 'node:test';

import { runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

/**
 * iPad/WebKit responsiveness is a release constraint, not a final-lane
 * afterthought (§8), so the cost of the Phase 8 stage is measured from the first
 * checkpoint rather than discovered at cutover.
 *
 * These are cheap in-process checks. The release budget lives in the frozen
 * profile and is enforced by the verifier; what is proved here is that the stage
 * is bounded and that cancellation is observed promptly.
 */

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const LARGE = Object.freeze({
  ir: {
    values: Array.from({ length: 20000 }, (_unused, index) => ({ id: index })),
    blocks: Array.from({ length: 2000 }, (_unused, index) => ({ id: `block_${index}` })),
  },
  opts: {},
});

test('the Phase 8 stage stays inside its declared budget on a large function', () => {
  const samples = Array.from({ length: 5 }, () => {
    const started = performance.now();
    runPhase8Stage(LARGE, { timeBudgetMs: 15 });
    return performance.now() - started;
  });
  assert.ok(median(samples) < 15, `Phase 8 stage median ${median(samples).toFixed(2)} ms exceeded its 15 ms allowance`);
});

test('cancellation is observed before any pass work, not after it', () => {
  const started = performance.now();
  const outcome = runPhase8Stage(LARGE, { timeBudgetMs: 15, shouldAbort: () => true });
  const elapsed = performance.now() - started;
  assert.equal(outcome.ledger.published, false);
  assert.ok(elapsed < 5, `cancellation latency ${elapsed.toFixed(2)} ms is too high for an interactive stage`);
});

test('the Phase 8 stage is a small fraction of whole-function decompilation', () => {
  // The stage must not become the reason a function is slow. This compares the
  // stage against the cost of the function it runs inside, so the check stays
  // meaningful on a fast or a slow machine.
  const corpus = loadCorpus();
  const entry = corpus.functions.find((item) => item.function === 'loop_nested' && item.optimization === '-O2')
    ?? corpus.functions[0];
  const started = performance.now();
  const outcome = decompileEntry(entry, { deterministicTransforms: false });
  const wholeFunctionMs = performance.now() - started;
  assert.ok(!outcome.failure, outcome.failure);
  const stageStarted = performance.now();
  runPhase8Stage({ ir: outcome.result?.ir ?? { values: [] }, opts: {} }, { timeBudgetMs: 15 });
  const stageMs = performance.now() - stageStarted;
  assert.ok(stageMs <= Math.max(1, wholeFunctionMs * 0.25),
    `Phase 8 stage ${stageMs.toFixed(2)} ms is disproportionate to the ${wholeFunctionMs.toFixed(2)} ms function`);
});
