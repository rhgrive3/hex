import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, VK, MK } from '../../../js/ir-base.js';
import { bvSort, boolSort, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createBv,
  createFreshSymbol,
  createCompare,
} from '../../../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { VERDICT, CLAIM_KIND } from '../../../js/symbolic/verify/query.js';
import { verifyConditionalEdgeFeasibility } from '../../../js/symbolic/verify/edge-feasibility.js';

test('edge feasibility: feasible edge with valid witness refutes infeasibility claim', async () => {
  const x = createFreshSymbol(bvSort(64), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(64, 42n));

  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { arg_x0: 42n },
  });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: edgeCond,
    backend,
  });

  assert.equal(res.verdict, VERDICT.REFUTED);
  assert.equal(res.claimKind, CLAIM_KIND.EDGE_INFEASIBLE);
  assert.equal(res.preconditionStatus, 'satisfiable');
  assert.equal(res.counterexampleValidation.valid, true);
  assert.equal(res.counterexample.arg_x0, 42n);
  assert.ok(res.proofStatement.includes('is FEASIBLE'));
  // Safety guard: Must not claim global unreachability
  assert.ok(!res.proofStatement.toLowerCase().includes('global'));
  assert.ok(!res.proofStatement.toLowerCase().includes('unreachable'));
});

test('edge feasibility: rejects invalid SAT model as provider failure', async () => {
  const x = createFreshSymbol(bvSort(64), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(64, 42n));

  // Model provides wrong value (x = 999 instead of 42)
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { arg_x0: 999n },
  });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: edgeCond,
    backend,
  });

  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'invalid-sat-model');
  assert.equal(res.solverStatus, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(res.counterexampleValidation.valid, false);
});

test('edge feasibility: proves infeasible edge under satisfiable preconditions', async () => {
  const x = createFreshSymbol(bvSort(4), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 0n));
  const preconditions = createCompare(BV_COMPARE_OP.UGT, x, createBv(4, 10n));

  const backend = new ExhaustiveBvBackend();

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 'B0',
    toBlock: 'B1',
    edgeCondition: edgeCond,
    preconditions,
    backend,
  });

  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.claimKind, CLAIM_KIND.EDGE_INFEASIBLE);
  assert.equal(res.preconditionStatus, 'satisfiable');
  assert.ok(res.proofStatement.includes('is PROVED INFEASIBLE under satisfiable preconditions'));
  // Safety guard: Must not claim global unreachability
  assert.ok(!res.proofStatement.toLowerCase().includes('global'));
  assert.ok(!res.proofStatement.toLowerCase().includes('unreachable'));
});

test('edge feasibility: translates and verifies Semantic IR instructions directly', async () => {
  const arg0 = { kind: VK.ARG, id: 'v0', reg: 'x0', origin: '0x1000' };
  const c0 = { const: 0n, id: 'v1', origin: '0x1004' };
  const cmpInst = {
    id: 'i_cmp',
    op: OP.CMP,
    cond: '==',
    signed: false,
    origin: '0x1008',
    args: [{ value: arg0 }, { value: c0 }],
  };

  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { arg_x0: 0n },
  });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 'entry',
    toBlock: 'zero_handler',
    edgeCondition: cmpInst,
    backend,
  });

  assert.equal(res.verdict, VERDICT.REFUTED);
  assert.equal(res.counterexampleValidation.valid, true);
  assert.ok(res.query.constraints.length > 0);
});

test('edge feasibility: fails closed on unsupported operations or semantic unknowns', async () => {
  // Unknown load instruction produces UnknownSemantic
  const unkLoad = {
    id: 'i_unk_load',
    op: OP.LOAD,
    loc: { kind: MK.UNKNOWN },
    origin: '0x2000',
  };

  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.UNSAT });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: unkLoad,
    backend,
  });

  // Since translation is unsupported / has semantic unknowns, eligibility MUST fail closed
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.ok(res.reasonCode.includes('unsupported') || res.reasonCode.includes('semantic-unknowns') || res.reasonCode.includes('incomplete-translation'));
});

test('edge feasibility: handles timeout and cancellation safely', async () => {
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, createFreshSymbol(bvSort(32), 'x'), createBv(32, 1n));
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.TIMEOUT });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: edgeCond,
    backend,
  });

  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.solverStatus, SOLVER_STATUS.TIMEOUT);
  assert.ok(!res.proofStatement.includes('PROVED'));
  assert.ok(!res.proofStatement.includes('FEASIBLE'));
});
