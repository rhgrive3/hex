import assert from 'node:assert/strict';
import test from 'node:test';

import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { verifyGlobalEdgeReachability } from '../../../js/symbolic/verify/global-reachability.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';

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
