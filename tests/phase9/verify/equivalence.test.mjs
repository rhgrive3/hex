import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_BINARY_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBv, createFreshSymbol, createBinary, createCompare } from '../../../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { VERDICT, CLAIM_KIND } from '../../../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../../../js/symbolic/verify/equivalence.js';

test('verifyBoundedEquivalence: proves equivalence when solver returns UNSAT on difference condition', async () => {
  // Before: x + x
  const x1 = createFreshSymbol(bvSort(32), 'x');
  const beforeExpr = createBinary(BV_BINARY_OP.ADD, x1, x1);

  // After: x << 1
  const x2 = createFreshSymbol(bvSort(32), 'x');
  const c1 = createBv(32, 1);
  const afterExpr = createBinary(BV_BINARY_OP.SHL, x2, c1);

  // Backend returns UNSAT (meaning no difference exists)
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.UNSAT,
  });

  const res = await verifyBoundedEquivalence({
    beforeTarget: beforeExpr,
    afterTarget: afterExpr,
    backend,
  });

  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.claimKind, CLAIM_KIND.EQUIVALENT);
  assert.equal(res.reasonCode, 'proved-equivalent');
  assert.ok(res.evidence);
  assert.equal(res.evidence.verdict, 'proved');
});

test('verifyBoundedEquivalence: refutes equivalence when solver produces valid counterexample', async () => {
  // Before: x + 1
  const x = createFreshSymbol(bvSort(32), 'x');
  const c1 = createBv(32, 1);
  const beforeExpr = createBinary(BV_BINARY_OP.ADD, x, c1);

  // After: x + 2
  const c2 = createBv(32, 2);
  const afterExpr = createBinary(BV_BINARY_OP.ADD, x, c2);

  // Backend returns SAT with model x = 0 (before: 1, after: 2, diff != 0)
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 0n },
  });

  const res = await verifyBoundedEquivalence({
    beforeTarget: beforeExpr,
    afterTarget: afterExpr,
    backend,
  });

  assert.equal(res.verdict, VERDICT.REFUTED);
  assert.equal(res.claimKind, CLAIM_KIND.EQUIVALENT);
  assert.equal(res.reasonCode, 'observable-difference-found');
  assert.deepEqual(res.counterexample, { x: 0n });
  assert.ok(res.evidence);
  assert.equal(res.evidence.verdict, 'refuted');
});

test('verifyBoundedEquivalence: vacuous proof guard rejects inconsistent preconditions', async () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const beforeExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 1));
  const afterExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 2));

  // Preconditions P: x == 10 AND x == 20 (contradictory / UNSAT)
  const c10 = createBv(32, 10);
  const c20 = createBv(32, 20);
  const p1 = createCompare(BV_COMPARE_OP.EQ, x, c10);
  const p2 = createCompare(BV_COMPARE_OP.EQ, x, c20);

  // Backend returns UNSAT for both the diff query and the precondition check
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.UNSAT,
  });

  const res = await verifyBoundedEquivalence({
    beforeTarget: beforeExpr,
    afterTarget: afterExpr,
    preconditions: [p1, p2],
    backend,
  });

  // Vacuous proof is blocked: result is UNKNOWN with inconsistent-preconditions
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'inconsistent-preconditions');
  assert.equal(res.evidence, null);
});

test('verifyBoundedEquivalence: rejects sort and width mismatches immediately', async () => {
  const bv8 = createBv(8, 42);
  const bv32 = createBv(32, 42);
  const backend = new FakeSolverBackend();

  const res = await verifyBoundedEquivalence({
    beforeTarget: bv8,
    afterTarget: bv32,
    backend,
  });

  assert.equal(res.verdict, VERDICT.REFUTED);
  assert.equal(res.reasonCode, 'sort-width-mismatch');
});
