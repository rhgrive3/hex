import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort } from '../../../js/symbolic/expr/kinds.js';
import { createBool, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { HeuristicSolverBackend } from '../../../js/symbolic/solver/heuristic-backend.js';
import { PROOF_AUTHORITY, isExactProofBackend } from '../../../js/symbolic/solver/backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { defaultSolverRegistry, createProductionSolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { verifyConditionalEdgeFeasibility } from '../../../js/symbolic/verify/edge-feasibility.js';

async function verifyFalseEdge(backend) {
  return verifyConditionalEdgeFeasibility({
    fromBlock: 'entry',
    toBlock: 'dead',
    edgeCondition: createBool(false),
    preconditions: createBool(true),
    backend,
  });
}

test('FakeSolverBackend UNSAT cannot mint PROVED', async () => {
  const fake = new FakeSolverBackend({
    id: 'fake-unsat-regression',
    defaultStatus: SOLVER_STATUS.UNSAT,
  });

  const result = await verifyFalseEdge(fake);

  assert.equal(fake.proofAuthority, PROOF_AUTHORITY.TEST_ONLY);
  assert.equal(result.solverStatus, SOLVER_STATUS.UNSAT);
  assert.notEqual(result.verdict, VERDICT.PROVED);
  assert.equal(result.evidence ?? null, null);
});

test('mock/test and heuristic UNSAT results cannot mint PROVED', async () => {
  for (const backend of [
    new FakeSolverBackend({ id: 'mock-unsat', defaultStatus: SOLVER_STATUS.UNSAT }),
    new HeuristicSolverBackend({ id: 'heuristic-unsat', defaultStatus: SOLVER_STATUS.UNSAT }),
  ]) {
    const result = await verifyFalseEdge(backend);
    assert.equal(result.solverStatus, SOLVER_STATUS.UNSAT);
    assert.notEqual(result.verdict, VERDICT.PROVED);
    assert.notEqual(backend.proofAuthority, PROOF_AUTHORITY.EXACT);
  }
});

test('only an exact backend with a matching capability fingerprint is proof eligible', async () => {
  const backend = new ExhaustiveBvBackend();
  assert.equal(backend.proofAuthority, PROOF_AUTHORITY.EXACT);
  assert.equal(isExactProofBackend(backend), true);

  const result = await verifyFalseEdge(backend);
  assert.equal(result.verdict, VERDICT.PROVED);
  assert.equal(result.proofAuthority, PROOF_AUTHORITY.EXACT);
  assert.equal(result.capabilityFingerprint, backend.capabilityFingerprint());

  const fake = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.UNSAT });
  fake.proofAuthority = PROOF_AUTHORITY.EXACT;
  assert.equal(isExactProofBackend(fake), false, 'authority string alone cannot spoof exact capabilities');
});

test('production solver registry never silently selects FakeSolverBackend', () => {
  const backend = defaultSolverRegistry.getDefaultBackend();
  assert.ok(backend);
  assert.notEqual(backend.constructor.name, 'FakeSolverBackend');
  assert.equal(backend.proofAuthority, PROOF_AUTHORITY.EXACT);
  assert.equal(isExactProofBackend(backend), true);

  const registry = createProductionSolverRegistry({ preferWorker: false });
  registry.registerBackend(new FakeSolverBackend({ id: 'late-fake' }));
  assert.equal(registry.getDefaultBackend().proofAuthority, PROOF_AUTHORITY.EXACT);
  assert.throws(() => registry.setDefaultBackend('late-fake'), /exact production backend/);
  registry.unregisterBackend(backend.id);
  assert.equal(registry.getDefaultBackend(), null, 'removing the exact backend must not promote a test backend');
});
