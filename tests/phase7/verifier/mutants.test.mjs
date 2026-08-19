import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createAliasResult } from '../../../js/analysis/alias/result.js';
import {
  UNBOUNDED_RANGE,
  addRange,
  createOffsetRange,
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  rangeRelation,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { reachingConcreteStore } from '../../../js/semantics/memoryssa/queries.js';
import { scoreAliasQueries, scoreMemoryLinks } from '../../../tools/validation/phase7/scoring.mjs';
import { ALIAS_QUERIES, buildFixture, regionOf } from '../corpus/fixtures.mjs';

const status = createAnalysisStatus({
  snapshotId: 'snapshot_mutant', analyzerId: 'test.mutant', analyzerVersion: '1.0.0', completeness: 'complete',
});

/**
 * Verifier self-tests.
 *
 * A gate that only proves "the current implementation passes" proves nothing
 * about the failure class it was written for. Each test here installs a
 * deliberately unsound implementation and asserts the gate *rejects* it. If one
 * of these ever passes silently, the corresponding gate has stopped working
 * and every green result it produced afterwards is worthless (§5.3, §24.1).
 */

test('MUTANT: an optimistic NoAlias on distinct roots is caught by the score', () => {
  const optimistic = (query) => {
    const built = buildFixture(query.fixture);
    const left = regionOf(built, query.left);
    const right = regionOf(built, query.right);
    // The classic unsound shortcut: "different root, therefore different
    // storage". It is wrong without escape evidence.
    return left.id === right.id ? 'must' : 'no';
  };
  const score = scoreAliasQueries(optimistic);
  assert.ok(score.falseNoAlias > 0, 'the alias score failed to detect a false NoAlias');
});

test('MUTANT: an optimistic MustAlias on shared roots is caught by the score', () => {
  const optimistic = (query) => {
    const built = buildFixture(query.fixture);
    const left = regionOf(built, query.left);
    const right = regionOf(built, query.right);
    return left.functionId === right.functionId ? 'must' : 'may';
  };
  const score = scoreAliasQueries(optimistic);
  assert.ok(score.falseMustAlias > 0, 'the alias score failed to detect a false MustAlias');
});

test('MUTANT: an alias provider that separates unknown regions bypasses a barrier', () => {
  // The exact shape of FM-1: "different region, therefore different storage".
  // It makes the pseudocode cleaner and the analysis wrong, because an
  // unresolved pointer's region is different from every other region.
  const unsoundFactory = () => (left, right) => (left.id === right.id ? 'must' : 'no');
  const built = buildFixture('unknown-store-barrier', { providerId: 'mutant-unknown-noalias', queryAliasFactory: unsoundFactory });
  const use = built.memorySsa.uses.find((item) => item.sourceEntityId === 'node_ld');
  assert.notEqual(reachingConcreteStore(built.memorySsa, use), null,
    'the mutant did not actually bypass the barrier, so this self-test proves nothing');

  const score = scoreMemoryLinks({ providerId: 'mutant-unknown-noalias', queryAliasFactory: unsoundFactory });
  assert.ok(score.barrierBypasses > 0, 'the memory-link score failed to detect a barrier bypass');
});

test('MUTANT: a status claiming completeness while cancelled is rejected by the contract', () => {
  assert.throws(() => createAnalysisStatus({
    snapshotId: 's', analyzerId: 'a', analyzerVersion: '1', completeness: 'complete', stopReason: 'cancelled',
  }), /complete-cannot-stop-early/);
});

test('MUTANT: a strong alias relation without a proof reason is rejected', () => {
  assert.throws(() => createAliasResult({ relation: 'no', status, reasonCodes: [] }),
    /strong-relation-requires-proof/);
  assert.throws(() => createAliasResult({ relation: 'must', status, reasonCodes: [] }),
    /strong-relation-requires-proof/);
});

test('MUTANT: a strong relation citing the opposite proof class is rejected', () => {
  // Copy-pasting a reason code from the neighbouring branch is a realistic
  // mistake, and it would produce an answer that argues against itself.
  assert.throws(() => createAliasResult({ relation: 'no', status, reasonCodes: ['identical-region-identity'] }),
    /no-alias-requires-separation-proof/);
  assert.throws(() => createAliasResult({ relation: 'must', status, reasonCodes: ['disjoint-stack-interval'] }),
    /must-alias-requires-identity-proof/);
});

test('MUTANT: a strong relation produced by a cancelled run is rejected', () => {
  const cancelled = createAnalysisStatus({
    snapshotId: 's', analyzerId: 'a', analyzerVersion: '1', completeness: 'partial', stopReason: 'cancelled',
  });
  assert.throws(() => createAliasResult({ relation: 'no', status: cancelled, reasonCodes: ['disjoint-stack-interval'] }),
    /strong-relation-requires-sound-status/);
});

test('MUTANT: an empty points-to set must not be read as separation', () => {
  // Bottom means "nothing has flowed here yet", not "points to nothing". A
  // solver that leaked bottom into an answer would separate that value from
  // every other pointer in the program.
  const empty = createPointsToSet({ targets: [] });
  const populated = createPointsToSet({
    targets: [createPointsToTarget({ rootKind: 'rooted', rootEntityId: 'root_a', offsetRange: exactRange(0n) })],
  });
  const result = pointsToAlias(empty, populated, { status, widthBitsLeft: 32, widthBitsRight: 32 });
  assert.equal(result.relation, 'unknown');
});

test('MUTANT: an unbounded offset must not compare as a small interval', () => {
  const bounded = exactRange(0n);
  assert.equal(rangeRelation(bounded, 4n, UNBOUNDED_RANGE, 4n), 'may',
    'an unbounded range was treated as separable');
  assert.equal(rangeRelation(UNBOUNDED_RANGE, 4n, UNBOUNDED_RANGE, 4n), 'may');
});

test('MUTANT: pointer arithmetic that could wrap loses provenance instead of wrapping', () => {
  // A machine add at 64 bits can wrap. If the offset silently wrapped, a
  // pointer near the top of the space would compare as if it were near zero.
  const nearTop = createOffsetRange((1n << 62n), (1n << 62n));
  const wrapped = addRange(nearTop, (1n << 62n) * 3n, 64);
  assert.equal(wrapped.lost, 'width-overflow');
  assert.equal(wrapped.range.min, null);
  assert.equal(wrapped.range.max, null);

  const safe = addRange(exactRange(8n), 8n, 64);
  assert.equal(safe.lost, null);
  assert.equal(safe.range.min, 16n);
});

test('MUTANT: dropping a hard query from the denominator is visible', () => {
  // FM-16: a candidate must not look better by answering fewer questions.
  const answerAll = () => 'may';
  const full = scoreAliasQueries(answerAll);
  const trimmed = scoreAliasQueries(answerAll, { queries: ALIAS_QUERIES.slice(0, 3) });
  assert.notEqual(full.total, trimmed.total,
    'the score must record its denominator so a shrunken query set is detectable');
});
