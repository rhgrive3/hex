import { ChatGPTDOMAdapter } from '../../chatgpt-adapter.js';
import { WorkerChatController } from '../worker-host/worker-chat-controller.js';
import { DedicatedWorkerCoordinator } from './dedicated-worker-coordinator.js';
import { createTabNode, TAB_NODE_ROLE } from './tab-node.js';

export const DEV_WORKER_POOL_MAX = 6;
export const WORKER_FRAME_HOST_ID = 'hex-dev-worker-frames';
export const WORKER_FRAME_HOSTS = Object.freeze(['chatgpt.com', 'chat.openai.com']);

const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 250;
const FRAME_WIDTH = 1024;
const FRAME_HEIGHT = 900;
const DEFAULT_BASE = 'https://chatgpt.com/';

/* Safari blocks GM.openInTab/window.open unless a human taps, so a tab pool can
   never be provisioned from automation on iPad. ChatGPT answers with
   `x-frame-options: SAMEORIGIN`, so the same page may embed itself. Every Worker
   is therefore a same-origin iframe inside the one Supervisor tab: no popup, no
   cross-tab transport, and the parent drives each Worker document directly. */
export class IframeWorkerPool {
  constructor({
    maxWorkers = DEV_WORKER_POOL_MAX,
    createFrame = defaultCreateFrame,
    createWorkerRuntime = defaultCreateWorkerRuntime,
    documentRef = globalThis.document,
    cryptoRef = globalThis.crypto,
    location = globalThis.location,
    now = () => new Date().toISOString(),
    sleep = delay,
  } = {}) {
    this.maxWorkers = boundedInt(maxWorkers, 1, DEV_WORKER_POOL_MAX, DEV_WORKER_POOL_MAX);
    this.createFrame = createFrame;
    this.createWorkerRuntime = createWorkerRuntime;
    this.documentRef = documentRef;
    this.cryptoRef = cryptoRef;
    this.location = location;
    this.now = now;
    this.sleep = sleep;
    this.slots = new Map();
    this.leases = new Map();
    this.waiters = [];
    this.resultWaiters = new Set();
    this.generation = 0;
    this.closed = false;
    this.retirement = createRetirement();
  }

  async provision({ size = this.maxWorkers, projectUrl = null, timeoutMs = READY_TIMEOUT_MS } = {}) {
    /* close() retires one ownership generation; an explicit provision is the
       controlled reinitialization boundary for a fresh generation. */
    if (this.closed) {
      this.generation += 1;
      this.retirement = createRetirement();
    }
    this.closed = false;
    const generation = this.generation;
    const wanted = boundedInt(size, 1, this.maxWorkers, this.maxWorkers);
    const limit = boundedInt(timeoutMs, 50, 120000, READY_TIMEOUT_MS);
    let href = null;
    try { href = this.workerFrameUrl(projectUrl); }
    catch (error) { throw poolError(String(error?.code || 'worker-frame-origin'), String(error?.message || error)); }
    const pending = [];
    for (let index = 1; index <= wanted; index++) {
      if (this.slots.get(index)?.ready) continue;
      pending.push(index);
    }
    // Worker frames load concurrently: six sequential ChatGPT boots would cost
    // minutes before the first task can start.
    const created = (await Promise.all(pending.map((index) => this.provisionSlot(index, href, limit, generation)))).filter(Boolean);
    this.flushWaiters();
    return { maxWorkers: this.maxWorkers, requested: wanted, created, slots: this.status().slots, readyCount: this.readyCount() };
  }

  status() {
    return {
      maxWorkers: this.maxWorkers,
      readyCount: this.readyCount(),
      claimedCount: [...this.slots.values()].filter((slot) => slot.claimed).length,
      waiting: this.waiters.length,
      slots: [...this.slots.values()].sort((a, b) => a.index - b.index).map((slot) => this.publicSlot(slot)),
    };
  }

  async claim({ taskId = null, wait = true, signal = null } = {}) {
    if (this.closed) throw poolError('transport-failure', 'Worker pool is closed.');
    if (signal?.aborted) throw abortError(signal.reason);
    const slot = this.availableSlot();
    if (slot) return this.claimSlot(slot, taskId, signal);
    if (wait === false) throw poolError('worker-pool-full', 'All ready Worker slots are claimed.');
    return new Promise((resolve, reject) => {
      const waiter = { taskId: taskId == null ? null : String(taskId), resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(abortError(signal?.reason)); };
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async createChat({ leaseId } = {}) { const slot = this.requireLease(leaseId); return slot.client.createChat(this.identity(slot)); }

  async start({ leaseId, instruction } = {}) {
    const slot = this.requireLease(leaseId);
    if (slot.pending) throw poolError('worker-busy', 'Worker slot already has an active task.');
    const text = String(instruction || '').trim();
    if (!text) throw new TypeError('Worker instruction is required.');
    const pending = Promise.resolve().then(() => slot.client.send({ ...this.identity(slot), instruction: text }));
    slot.pending = pending;
    slot.lastResult = null;
    pending.then((result) => { slot.lastResult = result; slot.pending = null; }, (error) => { slot.lastResult = { status: 'failed', error: { code: String(error?.code || 'provider-error'), message: String(error?.message || error).slice(0, 512) } }; slot.pending = null; }).finally(() => this.flushWaiters());
    return { started: true, ...this.publicSlot(slot) };
  }

  async send({ leaseId, instruction } = {}) { const slot = this.requireLease(leaseId); return slot.client.send({ ...this.identity(slot), instruction: String(instruction || '') }); }
  async followup({ leaseId, text } = {}) { const slot = this.requireLease(leaseId); return slot.client.followup({ ...this.identity(slot), text: String(text || '') }); }
  async nudge({ leaseId } = {}) { const slot = this.requireLease(leaseId); return slot.client.nudge(this.identity(slot)); }
  async stop({ leaseId } = {}) { const slot = this.requireLease(leaseId); return slot.client.stop(this.identity(slot)); }
  async observe({ leaseId } = {}) { const slot = this.requireLease(leaseId); return slot.client.observe(this.identity(slot)); }
  async result({ leaseId } = {}) { const slot = this.requireLease(leaseId); if (slot.pending) return { status: 'working', ...this.publicSlot(slot) }; return slot.lastResult || slot.client.result(this.identity(slot)); }

  /* Awaits the turn the Pool already owns instead of re-reading it on a timer.
     The captured `pending` is the only wakeup, the retained `lastResult` is the
     only answer, and ownership is proven again after the await so a concurrent
     release/reclaim/discard can never hand this wait the next owner's result.
     Aborting cancels the wait alone: stop/release/discard stay with the caller
     that owns the lease. Internal to the host; not a public Worker tool. */
  async waitResult({ leaseId } = {}, { signal } = {}) {
    const expectedLeaseId = String(leaseId || '');
    const slot = this.requireLease(expectedLeaseId);
    const expected = { slot, index: slot.index, runId: slot.runId, workerId: slot.workerId };
    if (signal?.aborted) throw abortError(signal.reason);
    // Captured exactly once. A turn that finished before this call leaves
    // pending null, and the retained result below is already the answer.
    const pending = slot.pending;
    if (pending) await this.awaitSettlement(pending, expectedLeaseId, signal);
    const owner = this.ownedSlot(expectedLeaseId, expected);
    if (!owner.lastResult) {
      throw poolError('worker-result-missing', 'Worker lease has neither an active turn nor a retained result.');
    }
    return owner.lastResult;
  }

  /* Re-proves ownership through the live lease table, never through the slot
     captured before the await. A closed or reprovisioned pool holds no entry for
     the old lease, so a late settlement can never speak for a new pool, lease,
     slot owner, or task. */
  ownedSlot(expectedLeaseId, expected) {
    const index = this.leases.get(expectedLeaseId);
    const slot = index ? this.slots.get(index) : null;
    if (!slot || slot !== expected.slot || slot.index !== expected.index || slot.leaseId !== expectedLeaseId
      || slot.runId !== expected.runId || slot.workerId !== expected.workerId) {
      throw poolError('worker-lease-superseded', 'Worker lease ownership changed while its result was awaited.');
    }
    return slot;
  }

  /* Both settlement directions are the same wakeup: start() already installed
     the handlers that turn a rejected Worker send into the canonical retained
     failed result, so re-throwing the raw rejection here would invent a second,
     competing failure representation. The waiter is registered so that retiring
     its ownership domain wakes it instead of stranding it on a turn that can no
     longer settle. */
  awaitSettlement(pending, leaseId, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { leaseId, done: false, onAbort: null, reject: null };
      const finish = (settle) => {
        if (waiter.done) return;
        waiter.done = true;
        this.resultWaiters.delete(waiter);
        signal?.removeEventListener?.('abort', waiter.onAbort);
        settle();
      };
      waiter.onAbort = () => finish(() => reject(abortError(signal?.reason)));
      waiter.reject = (error) => finish(() => reject(error));
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      this.resultWaiters.add(waiter);
      pending.then(ignoreSettlement, ignoreSettlement).then(() => finish(resolve));
    });
  }

  /* A retired lease can never settle its turn, so its waiters are woken with the
     same typed staleness they would have seen had the turn settled late. */
  invalidateResultWaiters(leaseId = null) {
    for (const waiter of [...this.resultWaiters]) {
      if (leaseId != null && waiter.leaseId !== leaseId) continue;
      waiter.reject(poolError('worker-lease-superseded', 'Worker lease ownership ended while its result was awaited.'));
    }
  }

  async release({ leaseId } = {}) {
    const slot = this.requireLease(leaseId);
    if (slot.pending) throw poolError('worker-busy', 'Cannot release a Worker slot while its task is active.');
    try { await slot.client.release(this.identity(slot)); }
    catch (error) { if (String(error?.code || '') !== 'worker-not-claimed') throw error; }
    this.leases.delete(slot.leaseId);
    slot.claimed = false; slot.leaseId = null; slot.workerId = null; slot.runId = null; slot.taskId = null; slot.lastResult = null;
    this.flushWaiters();
    return this.publicSlot(slot);
  }

  /* Fail-closed cleanup for an ambiguously owned lease. The old iframe is
     physically retired before logical ownership is cleared, then the exact
     slot is reprovisioned from its same-origin URL. This prevents a retry from
     either reusing an ambiguously owned Worker or waiting forever for the only
     slot. If replacement cannot be proven ready, discard fails deterministically. */
  async discard({ leaseId, reason = 'worker-discarded', timeoutMs = READY_TIMEOUT_MS } = {}) {
    const slot = this.requireLease(leaseId);
    const index = slot.index;
    const href = slot.href;
    const generation = this.generation;
    const stopLimit = boundedInt(timeoutMs, 0, 60000, READY_TIMEOUT_MS);
    this.invalidateResultWaiters(slot.leaseId);
    const stop = Promise.resolve().then(() => slot.client?.stop?.(this.identity(slot)));
    await promiseSettlesWithin(stop, stopLimit);
    if (!this.isCurrentGeneration(generation) || this.slots.get(index) !== slot) {
      throw poolError('transport-failure', 'Worker pool closed while discarding a Worker slot.');
    }
    closeSlot(slot);
    this.leases.delete(slot.leaseId);
    slot.ready = false;
    slot.claimed = false;
    slot.reserving = false;
    slot.leaseId = null;
    slot.workerId = null;
    slot.runId = null;
    slot.taskId = null;
    slot.pending = null;
    slot.lastResult = null;
    slot.error = { code: 'worker-discarded', message: String(reason || 'worker-discarded').slice(0, 384) };
    this.flushWaiters();
    const replacement = await this.provisionSlot(index, href, READY_TIMEOUT_MS, generation);
    this.flushWaiters();
    if (!replacement) throw poolError('worker-reprovision-failed', `Discarded Worker slot ${index} could not be reprovisioned.`);
    return replacement;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.retirement.resolve();
    this.invalidateResultWaiters();
    for (const slot of this.slots.values()) closeSlot(slot);
    for (const waiter of this.waiters) waiter.reject(poolError('transport-failure', 'Worker pool closed.'));
    this.waiters = [];
    this.leases.clear();
    this.slots.clear();
  }

  /* Worker frames must stay inside the Supervisor's own ChatGPT origin. A
     cross-origin frame cannot be driven at all, so this fails closed instead of
     provisioning slots that can never become ready. */
  workerFrameUrl(projectUrl) {
    const base = normalizeBase(this.location);
    let url;
    try { url = new URL(String(projectUrl || base), base); }
    catch { throw poolError('worker-frame-origin', 'Worker iframe URL is invalid.'); }
    if (url.protocol !== 'https:' || !WORKER_FRAME_HOSTS.includes(url.hostname)) {
      throw poolError('worker-frame-origin', 'Worker iframes must stay on a ChatGPT HTTPS origin.');
    }
    const parentOrigin = String(this.location?.origin || '');
    if (parentOrigin && parentOrigin !== url.origin) {
      throw poolError('worker-frame-origin', 'Worker iframes must use the same ChatGPT origin as the Supervisor tab.');
    }
    url.hash = '';
    return url.href;
  }

  async provisionSlot(index, href, timeoutMs, generation = this.generation) {
    let handle = null;
    try { handle = await this.createFrame({ slot: index, documentRef: this.documentRef, href }); }
    catch (error) {
      if (this.isCurrentGeneration(generation)) this.slots.set(index, failedSlot(index, error, 'worker-frame-unavailable'));
      return null;
    }
    if (!this.isCurrentGeneration(generation)) {
      try { handle?.close?.(); } catch { /* the retired frame is already unusable */ }
      return null;
    }
    if (!handle?.frame) {
      this.slots.set(index, failedSlot(index, poolError('worker-frame-unavailable', 'The page could not host a Worker iframe.')));
      return null;
    }
    const slot = {
      index, href, handle, runtime: null, runtimeDocument: null, client: null, ready: false, claimed: false, reserving: false,
      leaseId: null, workerId: null, runId: null, taskId: null, pending: null, lastResult: null, error: null,
      createdAt: this.now(),
    };
    this.slots.set(index, slot);
    if (!this.isCurrentGeneration(generation)) {
      this.retireProvisionedSlot(slot);
      return null;
    }
    try { await handle.navigate(href); }
    catch (error) {
      if (this.slots.get(index) === slot) slot.error = errorRecord(error, 'worker-frame-navigation');
      this.retireProvisionedSlot(slot);
      return null;
    }
    const outcome = await this.awaitReady(slot, timeoutMs, generation);
    if (!this.isCurrentGeneration(generation)) {
      this.retireProvisionedSlot(slot);
      return null;
    }
    if (!outcome.ready) { slot.error = { code: outcome.code, message: outcome.message }; this.retireProvisionedSlot(slot, false); return null; }
    slot.ready = true;
    return this.publicSlot(slot);
  }

  /* Ready means the Worker document is same-origin reachable and ChatGPT has
     rendered a live composer in it. Anything else is reported as the concrete
     blocker instead of a generic timeout. */
  async awaitReady(slot, timeoutMs, generation = this.generation) {
    const started = Date.now();
    let sameOriginSeen = false;
    let lastError = null;
    while (this.isCurrentGeneration(generation) && Date.now() - started < timeoutMs) {
      let document = null;
      try { document = slot.handle.frame.contentDocument || slot.handle.frame.contentWindow?.document || null; }
      catch (error) { lastError = error; document = null; }
      if (document) {
        sameOriginSeen = true;
        // An iframe starts with an initial about:blank Document. Setting src
        // schedules a cross-document navigation, so the first reachable
        // contentDocument can be transient. Never keep a Worker runtime bound
        // to a Document that the frame has already replaced.
        if (slot.runtime && slot.runtimeDocument !== document) closeRuntime(slot);
        if (!slot.runtime) {
          try {
            slot.runtime = this.createWorkerRuntime({ slot: slot.index, frame: slot.handle.frame, document, now: this.now });
            slot.runtimeDocument = slot.runtime ? document : null;
            slot.client = slot.runtime?.coordinator || null;
          } catch (error) { lastError = error; closeRuntime(slot); }
        }
        try { if (slot.runtime && slot.client && slot.runtime.ready()) return { ready: true }; }
        catch (error) { lastError = error; }
      }
      await this.sleep(READY_POLL_MS);
    }
    if (!this.isCurrentGeneration(generation)) {
      return { ready: false, code: 'worker-pool-closed', message: 'Worker pool generation retired while the iframe was loading.' };
    }
    if (!sameOriginSeen) {
      return { ready: false, code: 'worker-frame-blocked', message: `ChatGPT did not allow the Worker iframe to be embedded${lastError ? `: ${String(lastError.message || lastError).slice(0, 200)}` : '.'}` };
    }
    return { ready: false, code: 'worker-frame-timeout', message: 'The Worker iframe loaded but ChatGPT never rendered a usable composer in it.' };
  }

  readyCount() { return [...this.slots.values()].filter((slot) => slot.ready).length; }
  availableSlot() { return [...this.slots.values()].sort((a, b) => a.index - b.index).find((slot) => slot.ready && !slot.claimed && !slot.reserving && !slot.error) || null; }

  async claimSlot(slot, taskId, signal = null) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (slot.claimed || slot.reserving) throw poolError('worker-pool-full', 'Worker slot is already claimed or reserved.');
    slot.reserving = true;
    const generation = this.generation;
    const client = slot.client;
    const leaseId = randomId('lease', this.cryptoRef);
    const runId = randomId('poolrun', this.cryptoRef);
    const workerId = randomId('worker', this.cryptoRef);
    const retirement = this.retirement;
    let claimRollbackCompleted = false;
    let reservationDeferred = false;
    try {
      const remoteClaim = Promise.resolve().then(() => client.claim({ runId, workerId }));
      let removeAbortListener = () => {};
      const abort = signal
        ? new Promise((resolve) => {
          const onAbort = () => resolve({ kind: 'cancelled' });
          removeAbortListener = () => signal.removeEventListener?.('abort', onAbort);
          if (signal.aborted) resolve({ kind: 'cancelled' });
          else signal.addEventListener?.('abort', onAbort, { once: true });
        })
        : null;
      const outcome = await Promise.race([
        remoteClaim.then((value) => ({ kind: 'claimed', value }), (error) => ({ kind: 'rejected', error })),
        retirement.promise.then(() => ({ kind: 'retired' })),
        ...(abort ? [abort] : []),
      ]);
      removeAbortListener();
      if (outcome.kind === 'retired') {
        /* The public claim must settle when close retires the generation, but a
           late remote acceptance still needs rollback on the captured client. */
        claimRollbackCompleted = true;
        void remoteClaim.then(
          () => this.rollbackClaim(slot, { runId, workerId }, {
            code: 'worker-claim-cleanup-failed',
            label: 'Worker claim after pool close',
            client,
          }),
          () => {},
        ).catch(() => {});
        throw poolError('transport-failure', 'Worker pool closed while a Worker claim was settling.');
      }
      if (outcome.kind === 'cancelled') {
        /* Abort settles the caller immediately, but the captured slot remains
           reserved until the remote claim answers and its rollback completes.
           Reusing it earlier could overlap an unknown remote owner. */
        reservationDeferred = true;
        claimRollbackCompleted = true;
        slot.error = { code: 'worker-claim-cancelled', message: 'Worker claim was cancelled before remote ownership settled.' };
        void remoteClaim
          .then(
            () => this.rollbackClaim(slot, { runId, workerId }, {
              code: 'worker-claim-cancel-cleanup-failed',
              label: 'Cancelled Worker claim',
              client,
            }),
            () => this.rollbackClaim(slot, { runId, workerId }, {
              code: 'worker-claim-cancel-cleanup-failed',
              label: 'Cancelled Worker claim',
              client,
            }),
          )
          .catch(() => {})
          .finally(() => {
            if (this.slots.get(slot.index) !== slot) return;
            if (slot.error?.code === 'worker-claim-cancelled') slot.error = null;
            slot.reserving = false;
            this.flushWaiters();
          });
        throw abortError(signal.reason);
      }
      if (outcome.kind === 'rejected') throw outcome.error;
      if (this.closed || generation !== this.generation || this.slots.get(slot.index) !== slot) {
        const rollback = this.rollbackClaim(slot, { runId, workerId }, {
          code: 'worker-claim-cleanup-failed',
          label: 'Worker claim after pool close',
          client,
        });
        claimRollbackCompleted = true;
        if (this.closed) void rollback;
        else await rollback;
        throw poolError('transport-failure', 'Worker pool closed while a Worker claim was settling.');
      }
      if (signal?.aborted) {
        await this.rollbackCancelledClaim(slot, { runId, workerId });
        claimRollbackCompleted = true;
        throw abortError(signal.reason);
      }
      slot.claimed = true; slot.leaseId = leaseId; slot.runId = runId; slot.workerId = workerId;
      slot.taskId = taskId == null ? null : String(taskId);
      this.leases.set(leaseId, slot.index);
      return { leaseId, ...this.publicSlot(slot) };
    } catch (error) {
      // A rejected claim RPC may have reached the Worker before its response
      // was lost. Roll back that remote claim before making the local slot
      // available again; if rollback is ambiguous, quarantine the slot.
      if (!claimRollbackCompleted) {
        await this.rollbackClaim(slot, { runId, workerId }, {
          code: 'worker-claim-cleanup-failed',
          label: 'Worker claim',
          client,
        });
      }
      throw error;
    } finally {
      if (!reservationDeferred) {
        slot.reserving = false;
        if (!slot.claimed) this.flushWaiters();
      }
    }
  }

  async rollbackCancelledClaim(slot, identity) {
    return this.rollbackClaim(slot, identity, {
      code: 'worker-claim-cancel-cleanup-failed',
      label: 'Cancelled Worker claim',
    });
  }

  async rollbackClaim(slot, identity, { code, label, client = slot.client } = {}) {
    try { await client.release(identity); }
    catch (error) {
      if (String(error?.code || '') === 'worker-not-claimed') return;
      slot.error = {
        code: String(code || 'worker-claim-cleanup-failed'),
        message: `${String(label || 'Worker claim')} cleanup failed: ${String(error?.message || error).slice(0, 384)}`,
      };
    }
  }

  requireLease(value) {
    const id = String(value || '');
    const index = this.leases.get(id);
    const slot = index ? this.slots.get(index) : null;
    if (!slot || slot.leaseId !== id) throw poolError('lease-missing', 'Worker pool lease is invalid or expired.');
    return slot;
  }
  identity(slot) { return { runId: slot.runId, workerId: slot.workerId }; }
  publicSlot(slot) {
    return {
      slot: slot.index, ready: !!slot.ready, claimed: !!slot.claimed, leaseId: slot.leaseId, workerId: slot.workerId,
      taskId: slot.taskId, working: !!slot.pending, chatgptConversationId: slot.lastResult?.chatgptConversationId || null,
      error: slot.error, createdAt: slot.createdAt || null,
    };
  }
  flushWaiters() {
    while (this.waiters.length) {
      const slot = this.availableSlot();
      if (!slot) return;
      const waiter = this.waiters.shift();
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      this.claimSlot(slot, waiter.taskId, waiter.signal).then(waiter.resolve, waiter.reject);
    }
  }

  isCurrentGeneration(generation) {
    return !this.closed && this.generation === generation;
  }

  retireProvisionedSlot(slot, remove = true) {
    closeSlot(slot);
    if (remove && this.slots.get(slot.index) === slot) this.slots.delete(slot.index);
  }
}

/* The frame is kept off-screen instead of `display:none`: a non-rendered iframe
   is not laid out, and ChatGPT then never mounts the composer the Worker drives. */
export function defaultCreateFrame({ slot, documentRef = globalThis.document } = {}) {
  const doc = documentRef;
  if (!doc?.createElement || !doc.documentElement) return null;
  const host = ensureFrameHost(doc);
  const frame = doc.createElement('iframe');
  frame.id = `hex-dev-worker-frame-${slot}`;
  frame.title = `Hex Dev Worker ${slot}`;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.style.cssText = `width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;border:0;background:#fff;`;
  host.append(frame);
  return {
    frame,
    async navigate(href) { frame.src = href; },
    close() {
      try { frame.remove(); } catch { /* already detached */ }
      try { if (!host.querySelector?.('iframe')) host.remove(); } catch { /* already detached */ }
    },
  };
}

export function defaultCreateWorkerRuntime({ slot, frame, document, now = () => new Date().toISOString() } = {}) {
  const view = frame?.contentWindow || document?.defaultView || null;
  const adapter = new ChatGPTDOMAdapter({
    document,
    view,
    location: view?.location || document?.location || null,
    history: view?.history || null,
  });
  const controller = new WorkerChatController({ adapter, document, now });
  const node = createTabNode({ role: TAB_NODE_ROLE.WORKER, now });
  const coordinator = new DedicatedWorkerCoordinator({ controller, tabNodeId: node.tabNodeId, now });
  return {
    slot, adapter, controller, coordinator, node,
    ready() { try { return !!adapter.composer(); } catch { return false; } },
    close() { try { coordinator.close(); } catch { /* already closed */ } },
  };
}

function ensureFrameHost(doc) {
  const existing = doc.getElementById?.(WORKER_FRAME_HOST_ID);
  if (existing) return existing;
  const host = doc.createElement('div');
  host.id = WORKER_FRAME_HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;top:0;left:-20000px;width:1px;height:1px;overflow:hidden;pointer-events:none;z-index:-1;';
  doc.documentElement.append(host);
  return host;
}

function closeRuntime(slot) {
  try { slot.runtime?.close?.(); } catch { /* already closed */ }
  slot.runtime = null;
  slot.runtimeDocument = null;
  slot.client = null;
}
function closeSlot(slot) {
  closeRuntime(slot);
  try { slot.handle?.close?.(); } catch { /* already detached */ }
}

function createRetirement() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function promiseSettlesWithin(promise, timeoutMs) {
  const safe = Promise.resolve(promise).then(() => true, () => true);
  const limit = Math.max(0, Number(timeoutMs) || 0);
  if (limit === 0) {
    void safe;
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), limit);
    safe.then(() => finish(true));
  });
}
function normalizeBase(locationRef) {
  const href = String(locationRef?.href || '');
  try { const url = new URL(href); return WORKER_FRAME_HOSTS.includes(url.hostname) ? url.href : DEFAULT_BASE; }
  catch { return DEFAULT_BASE; }
}
function failedSlot(index, error, fallbackCode = 'worker-frame-unavailable') {
  return {
    index, handle: null, runtime: null, runtimeDocument: null, client: null, ready: false, claimed: false, reserving: false,
    leaseId: null, workerId: null, runId: null, taskId: null, pending: null, lastResult: null,
    error: errorRecord(error, fallbackCode), createdAt: new Date().toISOString(),
  };
}
function errorRecord(error, fallbackCode) {
  return { code: String(error?.code || fallbackCode), message: String(error?.message || error).slice(0, 512) };
}
function randomId(prefix, cryptoRef) {
  if (!cryptoRef?.getRandomValues) throw new TypeError('WebCrypto is required for Worker pool identity.');
  const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
  return `${prefix}-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
function boundedInt(value, min, max, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('Expected finite numeric bound.');
  return Math.min(max, Math.max(min, Math.floor(number)));
}
function poolError(code, message) { const error = new Error(message); error.code = code; return error; }
function abortError(reason) { const error = poolError('cancelled', String(reason || 'cancelled')); error.name = 'AbortError'; return error; }
function ignoreSettlement() {}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
