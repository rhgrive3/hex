import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, boolSort, BV_COMPARE_OP, BOOL_CONNECTIVE_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createBv,
  createBool,
  createFreshSymbol,
  createCompare,
  createConnective,
} from '../../../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { checkPreconditionsConsistency } from '../../../js/symbolic/verify/preconditions.js';
import { verifyConditionalEdgeFeasibility } from '../../../js/symbolic/verify/edge-feasibility.js';

test('vacuous proof guard: trivial preconditions are consistently satisfiable', async () => {
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.SAT });
  const session = backend.createSession();

  // Null / empty preconditions
  const resNull = await checkPreconditionsConsistency(null, session);
  assert.equal(resNull.consistent, true);
  assert.equal(resNull.status, SOLVER_STATUS.SAT);
  assert.equal(resNull.trivial, true);

  const resEmptyArr = await checkPreconditionsConsistency([], session);
  assert.equal(resEmptyArr.consistent, true);
  assert.equal(resEmptyArr.status, SOLVER_STATUS.SAT);
  assert.equal(resEmptyArr.trivial, true);

  // Constant True
  const resTrue = await checkPreconditionsConsistency(createBool(true), session);
  assert.equal(resTrue.consistent, true);
  assert.equal(resTrue.status, SOLVER_STATUS.SAT);
  assert.equal(resTrue.trivial, true);

  // Constant False is unsatisfiable without solver call
  const resFalse = await checkPreconditionsConsistency(createBool(false), session);
  assert.equal(resFalse.consistent, false);
  assert.equal(resFalse.status, SOLVER_STATUS.UNSAT);
  assert.equal(resFalse.reason, 'inconsistent-preconditions');
});

test('vacuous proof guard: solver verifies non-trivial precondition consistency', async () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const c10 = createBv(32, 10n);
  const pExpr = createCompare(BV_COMPARE_OP.UGT, x, c10);

  // 1. Satisfiable preconditions
  const satBackend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 15n },
  });
  const satSession = satBackend.createSession();
  const satRes = await checkPreconditionsConsistency(pExpr, satSession);
  assert.equal(satRes.consistent, true);
  assert.equal(satRes.status, SOLVER_STATUS.SAT);
  assert.ok(satRes.model);

  // 2. Unsatisfiable (contradictory) preconditions
  const unsatBackend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.UNSAT });
  const unsatSession = unsatBackend.createSession();
  const unsatRes = await checkPreconditionsConsistency(pExpr, unsatSession);
  assert.equal(unsatRes.consistent, false);
  assert.equal(unsatRes.status, SOLVER_STATUS.UNSAT);
  assert.equal(unsatRes.reason, 'inconsistent-preconditions');

  // 3. Timeout on preconditions fails closed to unresolved
  const timeoutBackend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.TIMEOUT });
  const timeoutSession = timeoutBackend.createSession();
  const timeoutRes = await checkPreconditionsConsistency(pExpr, timeoutSession);
  assert.equal(timeoutRes.consistent, false);
  assert.equal(timeoutRes.status, SOLVER_STATUS.TIMEOUT);
});

test('vacuous proof guard: contradictory preconditions block edge infeasibility proof', async () => {
  const x = createFreshSymbol(bvSort(32), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(32, 999n));

  // Preconditions P: x > 100 AND x < 50 (impossible)
  const p1 = createCompare(BV_COMPARE_OP.UGT, x, createBv(32, 100n));
  const p2 = createCompare(BV_COMPARE_OP.ULT, x, createBv(32, 50n));
  const pContradictory = createConnective(BOOL_CONNECTIVE_OP.AND, p1, p2);

  // Backend returns UNSAT for all queries (both Q and P)
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.UNSAT,
  });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 0,
    toBlock: 1,
    edgeCondition: edgeCond,
    preconditions: pContradictory,
    backend,
  });

  // MUST be UNKNOWN with reason 'inconsistent-preconditions', NEVER PROVED!
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'inconsistent-preconditions');
  assert.equal(res.preconditionStatus, 'inconsistent');
  assert.ok(!res.proofStatement.includes('PROVED INFEASIBLE'));
  assert.ok(res.proofStatement.includes('vacuous proof rejected'));
});

test('vacuous proof guard: satisfiable preconditions allow genuine infeasibility proof', async () => {
  const x = createFreshSymbol(bvSort(4), 'arg_x0');
  // Edge condition: x == 42
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 10n));
  // Preconditions P: x > 100
  const p = createCompare(BV_COMPARE_OP.UGT, x, createBv(4, 11n));
  const backend = new ExhaustiveBvBackend();

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 0,
    toBlock: 1,
    edgeCondition: edgeCond,
    preconditions: p,
    backend,
  });

  // Preconditions are SAT and Q is UNSAT -> PROVED infeasible under P
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.preconditionStatus, 'satisfiable');
  assert.ok(res.proofStatement.includes('PROVED INFEASIBLE'));
});
