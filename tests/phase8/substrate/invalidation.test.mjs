import assert from 'node:assert/strict';
import test from 'node:test';

import { ANALYSIS_KEYS, createPassDescriptor } from '../../../js/decompiler/phase8/contract.js';
import { createAnalysisState, invalidationFor, runPassTransaction, transactionDigest } from '../../../js/decompiler/phase8/transaction.js';
import { createPassResult } from '../../../js/decompiler/phase8/contract.js';

/**
 * Under-invalidation and over-invalidation are separate required regressions
 * (P8-1). They fail in opposite directions and a single "invalidation works"
 * test would catch neither reliably: too little invalidation serves stale facts,
 * too much throws away reuse the browser budget depends on.
 */

const FULL_STATE = Object.freeze(Object.fromEntries(ANALYSIS_KEYS.map((key) => [key, { key }])));

function pass(descriptorInput, { changed = true, stage: stageWrites = [] } = {}) {
  const descriptor = createPassDescriptor({ id: 'phase8.probe', version: '1.0.0', stage: 'scalar-optimization', ...descriptorInput });
  return {
    descriptor,
    run(_context, _budget, area) {
      for (const [key, value] of stageWrites) area.stage(key, value);
      return createPassResult({
        descriptor,
        status: changed ? 'changed' : 'unchanged',
        changed,
        transforms: changed ? [{ kind: 'probe', targets: ['value_1'], proof: 'probe' }] : [],
        invalidated: changed ? descriptor.invalidates : [],
        // What was staged and what is declared produced must agree, or the
        // ledger describes a different commit than the one that happened.
        produced: changed ? stageWrites.map(([key]) => key) : [],
      });
    },
  };
}

test('under-invalidation: an analysis the pass did not promise to preserve is invalidated anyway', () => {
  // This is the regression that fails against the obvious implementation, which
  // invalidates exactly what the descriptor declares. Here the pass declares it
  // invalidates nothing and preserves only the CFG — the ranges it silently
  // broke must still be dropped.
  const state = createAnalysisState(FULL_STATE);
  const outcome = runPassTransaction(state, pass({ consumes: ['ssa'], preserves: ['cfg'], invalidates: [] }), {}, {});
  assert.equal(outcome.committed, true);
  assert.ok(outcome.invalidated.includes('ranges'), 'ranges was neither preserved nor produced and must be invalidated');
  assert.ok(outcome.invalidated.includes('valueNumbers'));
  assert.equal(state.version('ranges'), 2, 'an invalidated analysis advances its version');
  assert.equal(state.get('ranges'), null, 'an invalidated analysis is dropped, not left stale');
});

test('over-invalidation: an analysis the pass promised to preserve keeps its version', () => {
  const state = createAnalysisState(FULL_STATE);
  const preserved = ANALYSIS_KEYS.filter((key) => key !== 'ranges');
  const outcome = runPassTransaction(state, pass({ consumes: ['ssa'], preserves: preserved, invalidates: ['ranges'] }), {}, {});
  assert.equal(outcome.committed, true);
  assert.deepEqual([...outcome.invalidated], ['ranges'], 'nothing beyond the one broken analysis may be discarded');
  for (const key of preserved) {
    assert.equal(state.version(key), 1, `preserved analysis lost its reuse: ${key}`);
    assert.notEqual(state.get(key), null);
  }
});

test('an unchanged pass invalidates nothing at all', () => {
  const state = createAnalysisState(FULL_STATE);
  const before = state.snapshot();
  const outcome = runPassTransaction(state, pass({ consumes: ['ssa'], preserves: ['cfg'] }, { changed: false }), {}, {});
  assert.equal(outcome.committed, true);
  assert.deepEqual([...outcome.invalidated], []);
  assert.deepEqual(state.snapshot(), before);
});

test('a produced analysis is written, not dropped', () => {
  const state = createAnalysisState(FULL_STATE);
  const outcome = runPassTransaction(
    state,
    pass({ consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] }, { stage: [['ranges', { computed: true }]] }),
    {}, {},
  );
  assert.equal(outcome.committed, true);
  assert.deepEqual([...outcome.staged], ['ranges']);
  assert.deepEqual(state.get('ranges'), { computed: true });
  assert.ok(!outcome.invalidated.includes('ranges'), 'a pass must not invalidate the analysis it just produced');
});

test('a pass cannot stage an analysis it did not declare it produces', () => {
  const state = createAnalysisState(FULL_STATE);
  const outcome = runPassTransaction(
    state,
    pass({ consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] }, { stage: [['types', { forged: true }]] }),
    {}, {},
  );
  assert.equal(outcome.committed, false, 'an undeclared production must not commit');
  assert.match(outcome.stopReason, /undeclared-production/);
  assert.deepEqual(state.get('types'), { key: 'types' }, 'the undeclared write must not have landed');
});

test('a cancelled pass leaves the state byte-identical', () => {
  const state = createAnalysisState(FULL_STATE);
  const before = state.snapshot();
  const outcome = runPassTransaction(
    state,
    pass({ consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] }, { stage: [['ranges', { computed: true }]] }),
    {}, { shouldAbort: () => true },
  );
  assert.equal(outcome.committed, false);
  assert.deepEqual(state.snapshot(), before);
  assert.deepEqual(state.get('ranges'), { key: 'ranges' }, 'the original analysis must survive a cancelled pass');
});

test('a staged write that the result does not declare as produced is refused', () => {
  // The staging area already refuses an undeclared *descriptor* production. This
  // is the other half: the result must also say what it produced, so the ledger
  // and the commit cannot disagree.
  const descriptor = createPassDescriptor({
    id: 'phase8.probe', version: '1.0.0', stage: 'scalar-optimization',
    consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'],
  });
  const silent = {
    descriptor,
    run(_context, _budget, area) {
      area.stage('ranges', { computed: true });
      return createPassResult({ descriptor, status: 'changed', transforms: [{ kind: 'probe', targets: ['value_1'], proof: 'probe' }] });
    },
  };
  const state = createAnalysisState(FULL_STATE);
  const outcome = runPassTransaction(state, silent, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /staged-production-mismatch/);
  assert.deepEqual(state.get('ranges'), { key: 'ranges' }, 'the mismatched write must not have landed');
});

test('deterministic replay: the same pass over the same state agrees on everything but time', () => {
  const digests = [0, 1].map(() => {
    const state = createAnalysisState(FULL_STATE);
    return transactionDigest(runPassTransaction(
      state,
      pass({ consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'] }, { stage: [['ranges', { computed: true }]] }),
      {}, {},
    ));
  });
  assert.equal(digests[0], digests[1]);
});

test('the invalidation rule is computable without running the pass', () => {
  const descriptor = createPassDescriptor({
    id: 'phase8.probe', version: '1.0.0', stage: 'loop-facts',
    consumes: ['ssa'], preserves: ['cfg', 'ssa'], produces: ['loops'],
  });
  const invalidated = invalidationFor(descriptor, { changed: true });
  assert.ok(!invalidated.includes('cfg'));
  assert.ok(!invalidated.includes('ssa'));
  assert.ok(!invalidated.includes('loops'));
  assert.ok(invalidated.includes('aggregates'));
  assert.deepEqual(invalidationFor(descriptor, { changed: false }), []);
});

test('an absent analysis is not reported as invalidated', () => {
  // Dropping something that was never there would inflate the invalidation
  // count and make over-invalidation impossible to measure honestly.
  const state = createAnalysisState({ cfg: {}, ssa: {} });
  const outcome = runPassTransaction(state, pass({ consumes: ['ssa'], preserves: ['ssa'] }), {}, {});
  assert.deepEqual([...outcome.invalidated], ['cfg']);
});
