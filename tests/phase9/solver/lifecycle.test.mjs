import assert from 'node:assert/strict';
import test from 'node:test';

import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { SolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';

test('FakeSolverBackend execution and result normalization', async () => {
  const backend = new FakeSolverBackend({
    id: 'mock-solver',
    version: '2.1.0',
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 100n },
  });

  const session = backend.createSession();
  const res = await session.check({ queryHash: 'q1' });

  assert.equal(res.status, SOLVER_STATUS.SAT);
  assert.equal(res.backend, 'mock-solver');
  assert.equal(res.backendVersion, '2.1.0');
  assert.deepEqual(res.model, { x: 100n });
});

test('session timeout properly returns TIMEOUT without hanging', async () => {
  const backend = new FakeSolverBackend({
    defaultDelayMs: 200,
    defaultStatus: SOLVER_STATUS.SAT,
  });

  const session = backend.createSession();
  // Set short timeout
  const res = await session.check({ queryHash: 'q_slow' }, { timeoutMs: 20 });

  assert.equal(res.status, SOLVER_STATUS.TIMEOUT);
  assert.ok(res.reason.includes('timed out'));
});

test('session cancellation is idempotent and rejects in-flight / subsequent queries', async () => {
  const backend = new FakeSolverBackend({
    defaultDelayMs: 50,
  });

  const session = backend.createSession();

  // Trigger check and cancel almost immediately
  const checkPromise = session.check({ queryHash: 'q_cancel' });
  await session.cancel();
  // Cancel again (idempotent)
  await session.cancel();
  assert.equal(session.cancelCount, 1);

  const res = await checkPromise;
  assert.equal(res.status, SOLVER_STATUS.CANCELLED);

  // Subsequent check on cancelled session returns CANCELLED
  const nextRes = await session.check({ queryHash: 'q_next' });
  assert.equal(nextRes.status, SOLVER_STATUS.CANCELLED);
});

test('session disposal is idempotent and prevents subsequent queries', async () => {
  const backend = new FakeSolverBackend({
    defaultDelayMs: 50,
  });

  const session = backend.createSession();

  // Trigger check and dispose immediately
  const checkPromise = session.check({ queryHash: 'q_dispose' });
  await session.dispose();
  // Dispose again (idempotent)
  await session.dispose();
  assert.equal(session.disposeCount, 1);

  const res = await checkPromise;
  assert.equal(res.status, SOLVER_STATUS.CANCELLED);

  // Query after disposal returns INVALID_QUERY
  const postDisposeRes = await session.check({ queryHash: 'q_after' });
  assert.equal(postDisposeRes.status, SOLVER_STATUS.INVALID_QUERY);
  assert.equal(postDisposeRes.reason, 'session-already-disposed');
});

test('SolverRegistry registers, retrieves, and lists backends', () => {
  const registry = new SolverRegistry();
  const b1 = new FakeSolverBackend({ id: 'b1', version: '1.0' });
  const b2 = new FakeSolverBackend({ id: 'b2', version: '2.0' });

  registry.registerBackend(b1);
  registry.registerBackend(b2);

  assert.equal(registry.hasBackend('b1'), true);
  assert.equal(registry.hasBackend('b2'), true);
  assert.equal(registry.hasBackend('b3'), false);

  assert.equal(registry.getBackend('b1').id, 'b1');
  assert.equal(registry.getDefaultBackend().id, 'b1');

  registry.setDefaultBackend('b2');
  assert.equal(registry.getDefaultBackend().id, 'b2');

  const list = registry.listBackends();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'b1');
  assert.equal(list[1].id, 'b2');
});
