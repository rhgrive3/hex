import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, MK } from '../../../js/ir-base.js';
import { createBool } from '../../../js/symbolic/expr/factory.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { verifyConditionalEdgeFeasibility } from '../../../js/symbolic/verify/edge-feasibility.js';

function edgeOptions(session) {
  return {
    session,
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: createBool(false),
    preconditions: createBool(true),
  };
}

test('timeout result cannot mint proof even when provider eventually returns UNSAT', async () => {
  const session = new FakeSolverBackend({
    defaultDelayMs: 40,
    defaultStatus: SOLVER_STATUS.UNSAT,
  }).createSession();
  const result = await verifyConditionalEdgeFeasibility({ ...edgeOptions(session), options: { timeoutMs: 5 } });
  assert.equal(result.verdict, VERDICT.UNKNOWN);
  assert.equal(result.solverStatus, SOLVER_STATUS.TIMEOUT);
  assert.equal(result.solverResult.lifecycle.publishable, false);
  assert.equal(result.solverResult.lifecycle.timedOut, true);
});

test('cancellation and disposal result cannot mint proof', async () => {
  const cancelledSession = new FakeSolverBackend({ defaultDelayMs: 40, defaultStatus: SOLVER_STATUS.UNSAT }).createSession();
  const cancelledPromise = verifyConditionalEdgeFeasibility(edgeOptions(cancelledSession));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await cancelledSession.cancel();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.verdict, VERDICT.UNKNOWN);
  assert.equal(cancelled.solverStatus, SOLVER_STATUS.CANCELLED);
  assert.equal(cancelled.solverResult.lifecycle.publishable, false);

  const disposedSession = new FakeSolverBackend({ defaultDelayMs: 40, defaultStatus: SOLVER_STATUS.UNSAT }).createSession();
  const disposedPromise = verifyConditionalEdgeFeasibility(edgeOptions(disposedSession));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await disposedSession.dispose();
  const disposed = await disposedPromise;
  assert.equal(disposed.verdict, VERDICT.UNKNOWN);
  assert.equal(disposed.solverResult.lifecycle.disposed, true);
  assert.equal(disposed.solverResult.lifecycle.publishable, false);
});

test('stale query-token result cannot mint proof', async () => {
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.UNSAT,
    handler: async (query) => {
      await new Promise((resolve) => setTimeout(resolve, query.targetEntity.toBlock === 2 ? 25 : 1));
      return { status: SOLVER_STATUS.UNSAT };
    },
  });
  const session = backend.createSession();
  const first = verifyConditionalEdgeFeasibility(edgeOptions(session));
  const second = verifyConditionalEdgeFeasibility({ ...edgeOptions(session), toBlock: 3 });
  const firstResult = await first;
  const secondResult = await second;
  assert.equal(firstResult.verdict, VERDICT.UNKNOWN);
  assert.equal(firstResult.reasonCode, 'stale-result');
  assert.equal(firstResult.solverResult.lifecycle.stale, true);
  assert.equal(firstResult.solverResult.lifecycle.publishable, false);
  assert.notEqual(secondResult.verdict, VERDICT.PROVED, 'test provider remains non-authoritative');
});

test('incomplete memory semantics and unsupported entities remain UNKNOWN', async () => {
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.UNSAT });
  for (const op of [OP.LOAD, OP.STORE, OP.CALL, OP.CLOBBER]) {
    const target = op === OP.LOAD
      ? { id: `load-${op}`, op, loc: { kind: MK.STACK, key: 'sp+8' } }
      : { id: `effect-${op}`, op };
    const result = await verifyConditionalEdgeFeasibility({
      fromBlock: 1,
      toBlock: 2,
      edgeCondition: target,
      backend,
    });
    assert.equal(result.verdict, VERDICT.UNKNOWN, `${op} must not be exact without effect evidence`);
  }
});
