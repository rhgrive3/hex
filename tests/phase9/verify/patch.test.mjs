import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_BINARY_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBv, createFreshSymbol, createBinary } from '../../../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { VERDICT, CLAIM_KIND } from '../../../js/symbolic/verify/query.js';
import { verifyPatchEquivalence } from '../../../js/symbolic/verify/patch.js';

test('verifyPatchEquivalence: links patch metadata and proves patch equivalence', async () => {
  const x = createFreshSymbol(bvSort(4), 'r0');
  const originalExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(4, 0));
  const patchedExpr = x;

  const backend = new ExhaustiveBvBackend();

  const res = await verifyPatchEquivalence({
    originalBinaryId: 'bin_v1_0_0',
    patchedPatchSetId: 'patch_optimization_01',
    originalTarget: originalExpr,
    patchedTarget: patchedExpr,
    backend,
  });

  assert.equal(res.originalBinaryId, 'bin_v1_0_0');
  assert.equal(res.patchedPatchSetId, 'patch_optimization_01');
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.claimKind, CLAIM_KIND.EQUIVALENT);
  assert.ok(res.evidence);
  assert.equal(res.evidence.verdict, 'proved');
});
