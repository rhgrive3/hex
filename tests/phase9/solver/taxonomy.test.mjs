import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLVER_STATUS,
  createSolverResult,
  isSat,
  isUnsat,
  isSolverFailure,
} from '../../../js/symbolic/solver/result.js';

test('solver status taxonomy covers all 9 mandatory statuses distinctly', () => {
  const mandatoryStatuses = [
    'sat',
    'unsat',
    'unknown',
    'timeout',
    'resource-limit',
    'unsupported',
    'cancelled',
    'provider-failure',
    'invalid-query',
  ];

  for (const status of mandatoryStatuses) {
    assert.ok(Object.values(SOLVER_STATUS).includes(status), `Status '${status}' must be in SOLVER_STATUS`);
    const res = createSolverResult({
      status,
      backend: 'test-solver',
      backendVersion: '1.0.0',
    });
    assert.equal(res.status, status);
  }

  // Reject unknown status
  assert.throws(() => createSolverResult({ status: 'maybe' }), TypeError);
});

test('SAT and UNSAT predicates and failure classification', () => {
  const satRes = createSolverResult({
    status: SOLVER_STATUS.SAT,
    model: { x: 42n },
    backend: 'test',
  });
  assert.equal(isSat(satRes), true);
  assert.equal(isUnsat(satRes), false);
  assert.equal(isSolverFailure(satRes), false);
  assert.deepEqual(satRes.model, { x: 42n });

  const unsatRes = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'test',
  });
  assert.equal(isSat(unsatRes), false);
  assert.equal(isUnsat(unsatRes), true);
  assert.equal(isSolverFailure(unsatRes), false);
  assert.equal(unsatRes.model, null);

  // Failure statuses must not be treated as UNSAT
  const timeoutRes = createSolverResult({ status: SOLVER_STATUS.TIMEOUT, backend: 'test' });
  const unsupportedRes = createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, backend: 'test' });
  const resourceRes = createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, backend: 'test' });

  assert.equal(isUnsat(timeoutRes), false);
  assert.equal(isUnsat(unsupportedRes), false);
  assert.equal(isUnsat(resourceRes), false);

  assert.equal(isSolverFailure(timeoutRes), true);
  assert.equal(isSolverFailure(unsupportedRes), true);
  assert.equal(isSolverFailure(resourceRes), true);
});
