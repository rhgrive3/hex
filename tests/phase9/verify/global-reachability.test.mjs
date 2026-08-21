import assert from 'node:assert/strict';
import test from 'node:test';

import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { verifyGlobalEdgeReachability } from '../../../js/symbolic/verify/global-reachability.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { bvSort, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';

test('verifyGlobalEdgeReachability: fails closed to UNKNOWN when CFG path coverage is partial', async () => {
  const backend = new FakeSolverBackend();

  const res = await verifyGlobalEdgeReachability({
    entryBlock: 0,
    targetBlock: 5,
    pathCompleteness: 'partial', // Incomplete incoming path coverage
    backend,
  });

  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'incomplete-path-coverage');
  assert.ok(res.proofStatement.includes('local infeasibility is not global unreachability'));
});

test('a caller string complete without a path certificate cannot mint global proof', async () => {
  const backend = new FakeSolverBackend();
  const res = await verifyGlobalEdgeReachability({
    entryBlock: 0,
    targetBlock: 5,
    pathCompleteness: 'complete',
    backend,
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'missing-global-path-evidence');
});

test('global reachability proves only from explicit complete incoming-path evidence', async () => {
  const x = createFreshSymbol(bvSort(2), 'global_x');
  const incoming = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 1n));
  const targetEdge = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 0n));
  const res = await verifyGlobalEdgeReachability({
    entryBlock: 0,
    targetBlock: 5,
    targetEdge,
    pathCompleteness: 'complete',
    backend: new ExhaustiveBvBackend(),
    globalScope: {
      entryBlock: 0,
      targetBlock: 5,
      incomingPaths: [{ id: 'entry-path', fromBlock: 0, toBlock: 5, complete: true, condition: incoming }],
      phiChoices: [],
      loopBounds: { complete: true, bounds: [] },
      pathCoverageEvidence: { complete: true, coveredPaths: 1, totalPaths: 1 },
      entryPreconditions: [],
      branchPredicates: [],
    },
  });
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.claimKind, 'global_edge_unreachable');
  assert.match(res.proofStatement, /Global edge/);
  assert.equal(res.evidence.proofAuthority, 'exact');
});
