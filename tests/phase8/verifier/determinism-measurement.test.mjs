/**
 * The determinism metric must compare like with like.
 *
 * `transformDeterminismFailureCount` is a hard-zero exit gate, so what it
 * measures has to be the transform, not the clock. It was measuring both: the
 * caller supplied a run made with the 5000 ms measurement allowance and the
 * metric made its own comparison run at 400 ms, so any function heavy enough to
 * truncate at the lower budget was reported as a non-deterministic transform.
 *
 * This pins the invariant rather than the symptom: a run at a different budget
 * is a different observation, and the metric's own run must use the caller's
 * budget.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { observeCorpus } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { MEASUREMENT_TIME_BUDGET_MS, determinismFailures } from '../../../tools/validation/phase8/metrics.mjs';

// A few functions rather than the whole corpus: the point is the comparison
// rule, and one truncatable function proves it as well as forty-five do.
const corpus = loadCorpus();
const sample = {
  ...corpus,
  functions: corpus.functions.filter((entry) => ['quality.loop_nested.O2', 'quality.aggregate_array_stride.O2', 'quality.loop_counted_sum.O0'].includes(entry.id)),
};

test('a truncated run and a complete run are different observations', () => {
  const tight = observeCorpus({ corpus: sample, decompilerTimeBudgetMs: 1 });
  const generous = observeCorpus({ corpus: sample, decompilerTimeBudgetMs: MEASUREMENT_TIME_BUDGET_MS });
  assert.notDeepEqual(tight, generous,
    'if these were equal the budget would not matter and this whole check would be pointless');
});

test('comparing runs made at different budgets reports failures that are not transform failures', () => {
  const tight = observeCorpus({ corpus: sample, decompilerTimeBudgetMs: 1 });
  const failures = determinismFailures({ corpus: sample, first: tight });
  assert.ok(failures.length > 0,
    'a mismatched budget must be visible; if it is not, the metric is not comparing what it claims to');
});

test('the metric reports nothing when both runs share the measurement allowance', () => {
  const generous = observeCorpus({ corpus: sample, decompilerTimeBudgetMs: MEASUREMENT_TIME_BUDGET_MS });
  assert.deepEqual(determinismFailures({ corpus: sample, first: generous }), []);
});
