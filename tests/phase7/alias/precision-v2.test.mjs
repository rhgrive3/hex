import assert from 'node:assert/strict';
import test from 'node:test';

import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf, regionOf, scoreAliasQueriesV2 } from '../../../tools/validation/phase7/scoring.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';

test('alias v2 solver achieves 100% exact precision and recall on v2 ground truth corpus', () => {
  const solverCache = new Map();
  function candidateAnswer(query) {
    const built = buildFixture(query.fixture);
    if (!solverCache.has(built)) {
      solverCache.set(built, createPhase7AliasSolver({
        ir: built.ir,
        cfg: built.cfg,
        ssa: built.ssa,
        options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
      }));
    }
    const solver = solverCache.get(built);
    return solver.alias(regionOf(built, query.left), regionOf(built, query.right), {
      leftAccess: memoryAccessOf(built, query.left),
      rightAccess: memoryAccessOf(built, query.right),
    });
  }

  const score = scoreAliasQueriesV2(candidateAnswer, { queries: ALIAS_QUERIES_V2 });

  assert.equal(score.queryCount, 30);
  assert.equal(score.exactAvailable, 15);
  assert.equal(score.exactClaimed, 15);
  assert.equal(score.exactCorrect, 15);
  assert.equal(score.exactPrecision, 1.0);
  assert.equal(score.exactRecall, 1.0);
  assert.equal(score.falseMustAlias, 0);
  assert.equal(score.falseNoAlias, 0);
  assert.equal(score.unknownCount, 0);
});
