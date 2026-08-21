import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DynamicTaskGraphHost, devAttemptTraceDurations } from '../../js/userscript/dev/task-graph/dynamic-task-graph.js';

function monotonicNow() {
  let tick = 0;
  const epoch = Date.UTC(2026, 0, 1);
  return () => new Date(epoch + tick++).toISOString();
}

class TracePool {
  constructor({ results = {} } = {}) {
    this.results = results;
    this.attempts = new Map();
    this.leases = new Map();
    this.sequence = 0;
  }

  async provision() { return { readyCount: 1 }; }
  status() { return { readyCount: 1 }; }

  async claim({ taskId } = {}) {
    const attempt = (this.attempts.get(taskId) || 0) + 1;
    this.attempts.set(taskId, attempt);
    const leaseId = `lease-${++this.sequence}`;
    this.leases.set(leaseId, { taskId, attempt, state: 'claimed', result: null, pending: null });
    return { leaseId, slot: 1, workerId: `worker-${this.sequence}` };
  }

  async createChat() { return { prepared: true }; }

  async start({ leaseId } = {}) {
    const lease = this.requireLease(leaseId);
    const configured = this.results[lease.taskId] || [{ status: 'completed' }];
    const result = configured[Math.min(lease.attempt - 1, configured.length - 1)] || { status: 'completed' };
    lease.state = 'working';
    lease.pending = new Promise((resolve) => {
      setTimeout(() => {
        lease.result = result;
        lease.state = 'terminal';
        resolve(result);
      }, lease.taskId === 'first' ? 5 : 0);
    });
    return { started: true };
  }

  async waitResult({ leaseId } = {}) {
    const lease = this.requireLease(leaseId);
    return lease.pending || lease.result;
  }

  async result({ leaseId } = {}) {
    const lease = this.requireLease(leaseId);
    return lease.state === 'working' ? { status: 'working' } : lease.result;
  }

  async stop({ leaseId } = {}) {
    const lease = this.requireLease(leaseId);
    if (lease.state === 'working') {
      lease.result = { status: 'cancelled', error: { code: 'cancelled', message: 'stopped' } };
      lease.state = 'terminal';
    }
    return { outcome: 'stopped' };
  }

  async release({ leaseId } = {}) {
    this.requireLease(leaseId);
    this.leases.delete(leaseId);
    return { claimed: false };
  }

  async discard({ leaseId } = {}) {
    this.leases.delete(leaseId);
    return { ready: true, slot: 1 };
  }

  requireLease(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      const error = new Error(`missing lease ${leaseId}`);
      error.code = 'lease-missing';
      throw error;
    }
    return lease;
  }
}

async function waitTerminal(host, graphId, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = host.status({ graphId });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`graph did not settle: ${graphId}`);
}

async function queueWaitBeginsAtReadyTransition() {
  const pool = new TracePool();
  const host = new DynamicTaskGraphHost({
    workerPool: pool,
    cryptoRef: webcrypto,
    now: monotonicNow(),
    pollMs: 1,
    cleanupTimeoutMs: 50,
  });

  await host.start({
    graphId: 'ready-queue',
    maxConcurrency: 1,
    tasks: [
      { id: 'first', dependencies: [], instruction: 'first', maxAttempts: 1 },
      { id: 'queued', dependencies: [], instruction: 'queued', maxAttempts: 1 },
    ],
  });
  const status = await waitTerminal(host, 'ready-queue');
  assert.equal(status.state, 'SUCCEEDED');

  const queued = host.taskResult({ graphId: 'ready-queue', taskId: 'queued' });
  assert.equal(queued.trace.length, 1);
  const trace = queued.trace[0];
  assert.ok(
    Date.parse(trace.readyAt) < Date.parse(queued.startedAt),
    'readyAt must be captured when the task first becomes READY, before it waits behind the concurrency limit',
  );
  assert.ok(
    devAttemptTraceDurations(trace).readyToLeaseMs > 0,
    'readyToLeaseMs must include time spent READY but not yet launched/leased',
  );
  host.close();
}

async function retryGetsAFreshReadyTimestamp() {
  const pool = new TracePool({
    results: {
      retried: [
        { status: 'failed', error: { code: 'fixture-failure', message: 'first attempt fails' } },
        { status: 'completed' },
      ],
    },
  });
  const host = new DynamicTaskGraphHost({
    workerPool: pool,
    cryptoRef: webcrypto,
    now: monotonicNow(),
    pollMs: 1,
    cleanupTimeoutMs: 50,
  });

  await host.start({
    graphId: 'retry-ready',
    maxConcurrency: 1,
    tasks: [{ id: 'retried', dependencies: [], instruction: 'retried', maxAttempts: 2 }],
  });
  const status = await waitTerminal(host, 'retry-ready');
  assert.equal(status.state, 'SUCCEEDED');

  const task = host.taskResult({ graphId: 'retry-ready', taskId: 'retried' });
  assert.equal(task.trace.length, 2);
  assert.ok(
    Date.parse(task.trace[1].readyAt) > Date.parse(task.trace[0].leaseReleasedAt),
    'a retry must record the new READY transition rather than reuse the original attempt timestamp',
  );
  host.close();
}

await queueWaitBeginsAtReadyTransition();
await retryGetsAFreshReadyTimestamp();
console.log('dynamic task graph READY trace: ok');
