import assert from 'node:assert/strict';
import { DynamicTaskGraph } from '../../js/userscript/dev/task-graph/task-graph-scheduler.js';

await testParallelDependenciesAndRetry();
testCycleAndMissingDependency();
console.log('dynamic task graph: ok');

async function testParallelDependenciesAndRetry() {
  const pool = new FakePool(6);
  const graph = new DynamicTaskGraph({ pool, sleep: tick, now: monotonicNow() });
  graph.create({ tasks: [
    { id: 'A', instruction: 'alpha', maxAttempts: 1, ownership: ['file:a'] },
    { id: 'B', instruction: 'beta', maxAttempts: 1, ownership: ['file:b'] },
    { id: 'C', instruction: 'combine', dependsOn: ['A', 'B'], maxAttempts: 1, integrationHint: 'merge A+B' },
    { id: 'D', instruction: 'retry-once', maxAttempts: 2 },
  ] });
  graph.start();
  const final = await graph.awaitCompletion();
  assert.equal(final.terminal, true);
  assert.equal(final.counts.completed, 4);
  assert.ok(pool.maxActive >= 3, 'independent ready tasks must execute concurrently rather than serially');

  const startA = pool.events.indexOf('start:A:1');
  const startB = pool.events.indexOf('start:B:1');
  const doneA = pool.events.indexOf('done:A:1');
  const doneB = pool.events.indexOf('done:B:1');
  const startC = pool.events.indexOf('start:C:1');
  assert.ok(startA >= 0 && startB >= 0 && doneA >= 0 && doneB >= 0 && startC > doneA && startC > doneB, 'dependent C must start only after A and B complete');

  assert.deepEqual(pool.taskLeases.get('D').length, 2, 'failed task must receive a fresh lease for bounded retry');
  assert.notEqual(pool.taskLeases.get('D')[0], pool.taskLeases.get('D')[1]);
  const taskD = final.tasks.find((task) => task.id === 'D');
  assert.equal(taskD.attempt, 2);
  assert.equal(taskD.status, 'completed');
  assert.deepEqual(final.tasks.find((task) => task.id === 'A').ownership, ['file:a']);
  assert.equal(final.tasks.find((task) => task.id === 'C').integrationHint, 'merge A+B');

  const before = graph.status().tasks.length;
  graph.add({ tasks: [{ id: 'E', instruction: 'post-graph', dependsOn: ['C'] }] });
  const extended = await graph.awaitCompletion();
  assert.equal(extended.tasks.length, before + 1, 'completed graph must accept a dynamically added dependent task');
  assert.equal(extended.tasks.find((task) => task.id === 'E').status, 'completed');
}

function testCycleAndMissingDependency() {
  const graph = new DynamicTaskGraph({ pool: new FakePool(2), sleep: tick });
  assert.throws(() => graph.create({ tasks: [{ id: 'x', instruction: 'x', dependsOn: ['missing'] }] }), (error) => error.code === 'dependency-missing');
  assert.throws(() => graph.create({ tasks: [
    { id: 'x', instruction: 'x', dependsOn: ['y'] },
    { id: 'y', instruction: 'y', dependsOn: ['x'] },
  ] }), (error) => error.code === 'dependency-cycle');
}

class FakePool {
  constructor(capacity) {
    this.capacity = capacity;
    this.leases = new Map();
    this.sequence = 0;
    this.events = [];
    this.maxActive = 0;
    this.attempts = new Map();
    this.taskLeases = new Map();
  }
  status() { return { readyCount: this.capacity, claimedCount: this.leases.size }; }
  async claim({ taskId, wait }) {
    if (this.leases.size >= this.capacity) { const error = new Error('full'); error.code = 'worker-pool-full'; throw error; }
    assert.equal(wait, false);
    const attempt = (this.attempts.get(taskId) || 0) + 1;
    this.attempts.set(taskId, attempt);
    const leaseId = `lease-${++this.sequence}`;
    const lease = { leaseId, taskId, attempt, remaining: taskId === 'A' || taskId === 'B' ? 2 : 1, started: false, terminal: null };
    this.leases.set(leaseId, lease);
    const history = this.taskLeases.get(taskId) || [];
    history.push(leaseId); this.taskLeases.set(taskId, history);
    this.maxActive = Math.max(this.maxActive, this.leases.size);
    return { leaseId, slot: this.leases.size, workerId: `worker-${leaseId}` };
  }
  async createChat({ leaseId }) { assert.ok(this.leases.has(leaseId)); return { prepared: true }; }
  async start({ leaseId }) {
    const lease = this.leases.get(leaseId); assert.ok(lease); lease.started = true;
    this.events.push(`start:${lease.taskId}:${lease.attempt}`);
    return { started: true };
  }
  async result({ leaseId }) {
    const lease = this.leases.get(leaseId); assert.ok(lease?.started);
    if (lease.terminal) return lease.terminal;
    if (lease.remaining-- > 0) return { status: 'working' };
    if (lease.taskId === 'D' && lease.attempt === 1) {
      lease.terminal = { status: 'failed', error: { code: 'synthetic', message: 'retry me' } };
      this.events.push('failed:D:1');
      return lease.terminal;
    }
    lease.terminal = { status: 'completed', responseText: `done:${lease.taskId}:${lease.attempt}` };
    this.events.push(`done:${lease.taskId}:${lease.attempt}`);
    return lease.terminal;
  }
  async stop({ leaseId }) { assert.ok(this.leases.has(leaseId)); return { outcome: 'stopped' }; }
  async release({ leaseId }) { assert.ok(this.leases.delete(leaseId)); return { released: true }; }
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function monotonicNow() { let n = 0; return () => `2026-08-18T00:00:${String(n++).padStart(2, '0')}.000Z`; }
