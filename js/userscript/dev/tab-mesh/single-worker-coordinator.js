import { DEV_WORKER_FAILURE } from '../../../ai/dev/workers/contracts.js';

const EVENT_QUEUE_LIMIT = 128;

export class SingleWorkerCoordinator {
  constructor({ transport, now = () => new Date().toISOString() } = {}) {
    if (!transport || typeof transport.request !== 'function' || typeof transport.subscribe !== 'function') {
      throw new TypeError('SingleWorkerCoordinator requires a TabTransport.');
    }
    this.transport = transport;
    this.now = now;
    this.slot = null;
    this.claimed = null;
    this.events = [];
    this.waiters = new Set();
    this.unsubscribe = transport.subscribe((event) => this.onEvent(event));
  }

  async discover() {
    if (this.claimed) return Object.freeze([clone(this.claimed.tab)]);
    if (this.slot) {
      try {
        const found = await this.transport.request(this.slot.tabNodeId, 'mesh.discover', {}, { timeoutMs: 1500 });
        if (isAvailable(found)) this.slot = clone(found);
        else this.slot = null;
      } catch {
        this.slot = null;
      }
    }
    if (!this.slot) {
      try {
        const found = await this.transport.request('*', 'mesh.discover', {}, { timeoutMs: 1500 });
        if (isAvailable(found)) this.slot = clone(found);
      } catch (error) {
        if (error?.code !== DEV_WORKER_FAILURE.TRANSPORT_FAILURE) throw error;
      }
    }
    return Object.freeze(this.slot ? [clone(this.slot)] : []);
  }

  async claim({ runId, workerId } = {}) {
    const normalizedRun = required(runId, 'runId');
    const normalizedWorker = required(workerId, 'workerId');
    if (this.claimed) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The Round 2 Worker slot is already claimed.');
    }
    const available = (await this.discover())[0];
    if (!available) {
      throw workerError(DEV_WORKER_FAILURE.TAB_UNAVAILABLE, 'No registered Worker Tab is available.');
    }
    const result = await this.transport.request(available.tabNodeId, 'worker.claim', {
      runId: normalizedRun,
      workerId: normalizedWorker,
    }, { timeoutMs: 5000 });
    this.slot = null;
    this.claimed = Object.freeze({
      runId: normalizedRun,
      workerId: normalizedWorker,
      tab: clone(result),
    });
    return clone(result);
  }

  createChat(args = {}) { return this.callClaimed('worker.create_chat', args, 15000); }
  send(args = {}) { return this.callClaimed('worker.send', args, 20000); }
  observe(args = {}) { return this.callClaimed('worker.observe', args, 5000); }
  followup(args = {}) { return this.callClaimed('worker.followup', args, 20000); }
  nudge(args = {}) { return this.callClaimed('worker.nudge', args, 20000); }
  stop(args = {}) { return this.callClaimed('worker.stop', args, 10000); }
  result(args = {}) { return this.callClaimed('worker.result', args, 5000); }

  async release(args = {}) {
    const claim = this.assertClaim(args);
    const result = await this.transport.request(
      claim.tab.tabNodeId,
      'worker.release',
      this.withClaim(args, claim),
      { timeoutMs: 5000 },
    );
    this.claimed = null;
    this.slot = isAvailable(result) ? clone(result) : null;
    return result;
  }

  waitEvent({ events, runId = null } = {}, { signal } = {}) {
    const wanted = normalizeEvents(events);
    const normalizedRun = runId == null ? null : String(runId);
    const queuedIndex = this.events.findIndex((event) => matches(event, wanted, normalizedRun));
    if (queuedIndex >= 0) return Promise.resolve(this.events.splice(queuedIndex, 1)[0]);
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolve, reject) => {
      const waiter = { wanted, runId: normalizedRun, resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        this.waiters.delete(waiter);
        reject(abortError(signal?.reason));
      };
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  close() {
    this.unsubscribe?.();
    for (const waiter of this.waiters) {
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      waiter.reject(workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, 'Worker coordinator closed.'));
    }
    this.waiters.clear();
    this.events.length = 0;
    this.slot = null;
    this.claimed = null;
  }

  async callClaimed(method, args, timeoutMs) {
    const claim = this.assertClaim(args);
    return this.transport.request(claim.tab.tabNodeId, method, this.withClaim(args, claim), { timeoutMs });
  }

  assertClaim(args = {}) {
    if (!this.claimed) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_UNAVAILABLE, 'No Worker is currently claimed.');
    }
    if (args.workerId != null && String(args.workerId) !== this.claimed.workerId) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The requested workerId does not own the Round 2 Worker slot.');
    }
    if (args.runId != null && String(args.runId) !== this.claimed.runId) {
      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The requested runId does not own the Round 2 Worker slot.');
    }
    return this.claimed;
  }

  withClaim(args, claim) {
    return { ...clone(args || {}), runId: claim.runId, workerId: claim.workerId };
  }

  onEvent(event) {
    if (!event?.type) return;
    if (event.type === 'worker.registered' && isAvailable(event.data)) {
      if (!this.slot || this.slot.tabNodeId === event.data.tabNodeId) this.slot = clone(event.data);
    }
    const normalized = Object.freeze({
      type: String(event.type),
      data: clone(event.data || {}),
      from: String(event.from || ''),
      observedAt: String(event.observedAt || this.now()),
    });
    for (const waiter of [...this.waiters]) {
      if (!matches(normalized, waiter.wanted, waiter.runId)) continue;
      this.waiters.delete(waiter);
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      waiter.resolve(normalized);
      return;
    }
    this.events.push(normalized);
    while (this.events.length > EVENT_QUEUE_LIMIT) this.events.shift();
  }
}

function isAvailable(value) {
  return !!value?.tabNodeId && value.role === 'available' && value.claimed !== true;
}
function matches(event, wanted, runId) {
  return wanted.has(event.type) && (runId == null || String(event.data?.runId || '') === runId);
}
function normalizeEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    throw new TypeError('waitEvent.events must be a non-empty array.');
  }
  const out = new Set();
  for (const event of events) {
    const value = String(event || '').trim();
    if (!value) throw new TypeError('waitEvent event names must be non-empty.');
    out.add(value);
  }
  return out;
}
function required(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function abortError(reason) {
  const error = new Error(String(reason || 'cancelled'));
  error.name = 'AbortError';
  error.code = DEV_WORKER_FAILURE.CANCELLED;
  return error;
}
