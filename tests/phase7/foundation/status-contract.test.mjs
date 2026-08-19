import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_COMPLETENESS,
  createAnalysisStatus,
  isCompleteStatus,
  isFailClosedStatus,
  mergeAnalysisStatus,
  satisfiesRequirement,
  weakestCompleteness,
} from '../../../js/analysis/status.js';

const base = (overrides = {}) => createAnalysisStatus({
  snapshotId: 'snapshot_1', analyzerId: 'test.analyzer', analyzerVersion: '1.0.0',
  completeness: 'complete', ...overrides,
});

test('a complete status cannot carry a stop reason', () => {
  assert.throws(() => createAnalysisStatus({
    snapshotId: 's', analyzerId: 'a', analyzerVersion: '1', completeness: 'complete', stopReason: 'cancelled',
  }), /analysis-status-complete-cannot-stop-early/);
});

test('an incomplete status must say why it stopped', () => {
  assert.throws(() => createAnalysisStatus({
    snapshotId: 's', analyzerId: 'a', analyzerVersion: '1', completeness: 'partial',
  }), /analysis-status-incomplete-requires-stop-reason/);
});

test('an aborted run cannot be reported as deliberately bounded', () => {
  // `bounded` promises soundness within a declared bound. A cancelled run makes
  // no such promise, so the two must not be spellable together (P7-INV-010).
  for (const reason of ['cancelled', 'timeout', 'budget-exhausted', 'memory-limit', 'dependency-missing', 'dependency-mismatch']) {
    assert.throws(() => createAnalysisStatus({
      snapshotId: 's', analyzerId: 'a', analyzerVersion: '1', completeness: 'bounded', stopReason: reason,
    }), /analysis-status-aborted-cannot-be-bounded/, `stop reason must not be bounded: ${reason}`);
  }
});

test('cancellation and budget exhaustion never satisfy a complete requirement', () => {
  for (const reason of ['cancelled', 'timeout', 'budget-exhausted', 'memory-limit']) {
    const status = base({ completeness: 'partial', stopReason: reason });
    assert.equal(isCompleteStatus(status), false);
    assert.equal(isFailClosedStatus(status), true);
    assert.equal(satisfiesRequirement(status, 'complete'), false);
    // Fail-closed means fail-closed at every requirement level, not just the
    // strictest one: a cancelled run cannot even satisfy `truncated`.
    assert.equal(satisfiesRequirement(status, 'truncated'), false, `must not satisfy any requirement: ${reason}`);
  }
});

test('a partial artifact never satisfies a lookup requiring complete', () => {
  const partial = base({ completeness: 'partial', stopReason: 'evidence-missing' });
  assert.equal(satisfiesRequirement(partial, 'complete'), false);
  assert.equal(satisfiesRequirement(partial, 'partial'), true);
  assert.equal(satisfiesRequirement(base(), 'complete'), true);
});

test('completeness ordering is weakest-last and total', () => {
  assert.deepEqual([...ANALYSIS_COMPLETENESS], ['complete', 'bounded', 'partial', 'truncated', 'unsupported']);
  assert.equal(weakestCompleteness('complete', 'partial', 'bounded'), 'partial');
  assert.equal(weakestCompleteness('complete', 'complete'), 'complete');
  assert.equal(weakestCompleteness('truncated', 'unsupported'), 'unsupported');
});

test('merging statuses never strengthens the result', () => {
  const merged = mergeAnalysisStatus(base(), base({ completeness: 'truncated', stopReason: 'iteration-limit' }));
  assert.equal(merged.completeness, 'truncated');
  assert.equal(merged.stopReason, 'iteration-limit');
  assert.equal(isCompleteStatus(merged), false);
});

test('a fail-closed stop reason wins over a benign one when merging', () => {
  const merged = mergeAnalysisStatus(
    base({ completeness: 'truncated', stopReason: 'iteration-limit' }),
    base({ completeness: 'partial', stopReason: 'cancelled' }),
  );
  assert.equal(merged.stopReason, 'cancelled');
  assert.equal(isFailClosedStatus(merged), true);
});
