const COMPLETION_SOURCE = 'iframe-worker-pool';

export class IframeWorkerCompletionBridge {
  constructor({ workerPool, coordinator, now = () => new Date().toISOString() } = {}) {
    if (!workerPool || typeof workerPool.start !== 'function' || typeof workerPool.requireLease !== 'function') {
      throw new TypeError('IframeWorkerCompletionBridge requires an IframeWorkerPool.');
    }
    if (!coordinator || typeof coordinator.enqueue !== 'function' || typeof coordinator.waitEvent !== 'function') {
      throw new TypeError('IframeWorkerCompletionBridge requires the canonical Worker event coordinator.');
    }
    this.workerPool = workerPool;
    this.coordinator = coordinator;
    this.now = now;
    this.sequence = 0;
    this.runByLease = new Map();
    this.currentBySlot = new Map();
    this.originalStart = workerPool.start.bind(workerPool);
    workerPool.start = (args) => this.start(args);
  }

  async claim(args = {}, options = {}) {
    const runId = args.runId == null ? null : requiredIdentity(args.runId, 'runId');
    const claim = await this.workerPool.claim({ ...args, signal: options.signal });
    if (runId) this.runByLease.set(String(claim.leaseId), runId);
    return claim;
  }

  async release(args = {}) {
    const leaseId = String(args.leaseId || '');
    this.assertRunOwnership(leaseId, args.runId);
    const result = await this.workerPool.release(args);
    this.runByLease.delete(leaseId);
    for (const [slot, occurrence] of this.currentBySlot) {
      if (occurrence.leaseId === leaseId) this.currentBySlot.delete(slot);
    }
    return result;
  }

  async start(args = {}) {
    const slot = this.workerPool.requireLease(args.leaseId);
    const leaseId = String(slot.leaseId);
    const runId = this.assertRunOwnership(leaseId, args.runId);

    /* Do not replace the current occurrence until the canonical Pool accepts
       this start. A duplicate start that fails with worker-busy must not erase
       tracking for the already-running turn. */
    const started = await this.originalStart(args);
    const occurrence = {
      completionId: `pool-completion-${++this.sequence}`,
      slot: slot.index,
      slotRef: slot,
      leaseId,
      runId,
      poolRunId: String(slot.runId || ''),
      workerId: String(slot.workerId || ''),
      taskId: slot.taskId == null ? null : String(slot.taskId),
      pending: slot.pending,
      published: false,
      delivered: false,
      event: null,
    };
    this.currentBySlot.set(slot.index, occurrence);

    if (occurrence.pending) {
      occurrence.pending.then(
        () => this.publishAfterRetention(occurrence),
        () => this.publishAfterRetention(occurrence),
      );
    } else {
      /* An immediately-settled Worker may have retained its result before the
         async start continuation runs. The retained Pool state is authoritative. */
      this.publishAfterRetention(occurrence);
    }
    return started;
  }

  publishAfterRetention(occurrence) {
    queueMicrotask(() => {
      if (occurrence.published || !occurrence.runId || !this.isCurrentRetainedCompletion(occurrence)) return;
      const event = this.completionEvent(occurrence);
      occurrence.published = true;
      occurrence.event = event;
      this.coordinator.enqueue(event);
    });
  }

  async waitEvent(args = {}, options = {}) {
    while (true) {
      /* Case B: completion can predate the wait by arbitrarily long. The
         coordinator queue is intentionally bounded, so consult the canonical
         retained Pool result before registering a new waiter. This is a single
         state check, not polling. If completion races this check, enqueue/wait
         closes the gap because coordinator.waitEvent retains or registers. */
      const retained = this.takeRetainedCompletion(args);
      if (retained) return retained;

      const event = await this.coordinator.waitEvent(args, options);
      if (!isPoolCompletion(event)) return event;
      const occurrence = this.currentOccurrenceForEvent(event);
      if (!occurrence || occurrence.delivered || !this.isCurrentRetainedCompletion(occurrence)) continue;
      occurrence.delivered = true;
      return event;
    }
  }

  takeRetainedCompletion(args = {}) {
    if (!wantsCompletion(args.events)) return null;
    const runId = args.runId == null ? null : String(args.runId);
    for (const occurrence of this.currentBySlot.values()) {
      if (!occurrence.runId || (runId != null && occurrence.runId !== runId)) continue;
      if (occurrence.delivered || !this.isCurrentRetainedCompletion(occurrence)) continue;
      const event = occurrence.event || this.completionEvent(occurrence);
      occurrence.event = event;
      /* If delivery wins the race against the publication microtask, suppress
         the later queue copy. The retained result remains untouched. */
      occurrence.published = true;
      occurrence.delivered = true;
      return event;
    }
    return null;
  }

  currentOccurrenceForEvent(event) {
    const completionId = String(event.data?.completionId || '');
    if (!completionId) return null;
    const occurrence = this.currentBySlot.get(Number(event.data?.slot));
    return occurrence?.completionId === completionId ? occurrence : null;
  }

  completionEvent(occurrence) {
    return Object.freeze({
      type: 'worker.completed',
      data: Object.freeze({
        source: COMPLETION_SOURCE,
        runId: occurrence.runId,
        poolRunId: occurrence.poolRunId,
        taskId: occurrence.taskId,
        workerId: occurrence.workerId,
        leaseId: occurrence.leaseId,
        slot: occurrence.slot,
        completionId: occurrence.completionId,
      }),
      observedAt: this.now(),
    });
  }

  assertRunOwnership(leaseId, suppliedRunId) {
    const ownerRunId = this.runByLease.get(String(leaseId)) || null;
    const requestedRunId = suppliedRunId == null ? null : requiredIdentity(suppliedRunId, 'runId');
    if (!ownerRunId) {
      if (requestedRunId) {
        throw ownershipError(leaseId, 'is not associated with a Supervisor run');
      }
      return null;
    }
    if (requestedRunId !== ownerRunId) {
      throw ownershipError(leaseId, `is owned by Supervisor run ${ownerRunId}`);
    }
    return ownerRunId;
  }

  isCurrentRetainedCompletion(occurrence) {
    if (this.currentBySlot.get(occurrence.slot) !== occurrence) return false;
    let slot;
    try { slot = this.workerPool.requireLease(occurrence.leaseId); }
    catch { return false; }
    return slot === occurrence.slotRef
      && String(slot.leaseId || '') === occurrence.leaseId
      && String(slot.runId || '') === occurrence.poolRunId
      && String(slot.workerId || '') === occurrence.workerId
      && (slot.taskId == null ? null : String(slot.taskId)) === occurrence.taskId
      && slot.pending == null
      && slot.lastResult != null;
  }

  close() {
    if (this.workerPool.start !== this.originalStart) this.workerPool.start = this.originalStart;
    this.runByLease.clear();
    this.currentBySlot.clear();
  }
}

function isPoolCompletion(event) {
  return event?.type === 'worker.completed' && event?.data?.source === COMPLETION_SOURCE;
}

function wantsCompletion(events) {
  return Array.isArray(events) && events.some((event) => String(event) === 'worker.completed');
}

function ownershipError(leaseId, detail) {
  const error = new Error(`Iframe Worker lease ${String(leaseId || '')} ${detail}.`);
  error.code = 'worker-lease-run-mismatch';
  return error;
}

function requiredIdentity(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`Iframe Worker completion ${field} must be non-empty.`);
  return text;
}
