/**
 * Dedicated Worker transport for the browser-safe exhaustive exact backend.
 * The host owns the timeout and lifecycle; the worker is terminated on
 * timeout/cancel/dispose so a late provider result cannot re-enter Hex.
 */

import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { ExhaustiveBvBackend } from './exhaustive-backend.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const WORKER_BACKEND_ID = 'hex-exhaustive-bv-worker';
export const WORKER_BACKEND_VERSION = '1.0.0';

function defaultWorkerFactory() {
  if (typeof globalThis.Worker !== 'function') throw new Error('solver-worker-unavailable');
  return new globalThis.Worker(new URL('./worker-entry.js', import.meta.url), { type: 'module' });
}

class WorkerSolverSession extends SolverSession {
  constructor(backend, options = {}) {
    super(backend, options);
    this.requestSequence = 0;
    this.pending = new Map();
    this.worker = null;
    this.terminated = false;
    this._createWorker();
  }

  _createWorker() {
    try {
      this.worker = this.backend.workerFactory();
      this._attachWorker(this.worker);
      this.terminated = false;
    } catch (error) {
      this.initializationError = error;
    }
  }

  _attachWorker(worker) {
    const onMessage = (event) => {
      const message = event?.data ?? event;
      if (!message || message.type !== 'solver-result') return;
      const pending = this.pending.get(String(message.requestId));
      if (!pending) return;
      this.pending.delete(String(message.requestId));
      pending.resolve(message.result);
    };
    const onError = (event) => {
      const reason = event?.message || 'solver-worker-failure';
      for (const pending of this.pending.values()) {
        pending.resolve(createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason,
          backend: this.backend.id,
          backendVersion: this.backend.version,
          lifecycle: { publishable: false },
        }));
      }
      this.pending.clear();
    };
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.removeWorkerListeners = () => {
        worker.removeEventListener?.('message', onMessage);
        worker.removeEventListener?.('error', onError);
      };
    } else {
      worker.onmessage = onMessage;
      worker.onerror = onError;
      this.removeWorkerListeners = () => {
        worker.onmessage = null;
        worker.onerror = null;
      };
    }
  }

  async _executeCheck(query, options = {}, token, signal) {
    if (!this.worker) {
      return createSolverResult({
        status: SOLVER_STATUS.PROVIDER_FAILURE,
        reason: this.initializationError?.message || 'solver-worker-unavailable',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
        lifecycle: { publishable: false },
      });
    }
    if (signal?.aborted) {
      return createSolverResult({
        status: SOLVER_STATUS.CANCELLED,
        reason: 'solver-worker-aborted',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
        lifecycle: { cancelled: true, publishable: false },
      });
    }

    const requestId = String(++this.requestSequence);
    const workerOptions = {
      maxBvWidth: options.maxBvWidth ?? this.backend.maxBvWidth,
      maxAssignments: options.maxAssignments ?? this.backend.maxAssignments,
      maxConstraints: options.maxConstraints ?? this.backend.maxConstraints,
      maxExprNodes: options.maxExprNodes ?? this.backend.maxExprNodes,
      yieldEvery: options.yieldEvery,
      timeoutMs: 0,
    };
    return new Promise((resolve) => {
      const pending = { resolve };
      this.pending.set(requestId, pending);
      try {
        this.worker.postMessage({ type: 'solver-check', requestId, query, options: workerOptions, token });
      } catch (error) {
        this.pending.delete(requestId);
        resolve(createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason: error?.message || 'solver-worker-post-failed',
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: query?.queryHash || null,
          lifecycle: { publishable: false },
        }));
      }
    });
  }

  _terminateWorker() {
    if (this.terminated) return;
    this.terminated = true;
    this.removeWorkerListeners?.();
    for (const pending of this.pending.values()) {
      pending.resolve(createSolverResult({
        status: SOLVER_STATUS.CANCELLED,
        reason: 'solver-worker-terminated',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        lifecycle: { cancelled: true, disposed: true, late: true, publishable: false },
      }));
    }
    this.pending.clear();
    try { this.worker?.terminate?.(); } catch { /* idempotent best effort */ }
    this.worker = null;
  }

  async _onCancel() {
    try { this.worker?.postMessage?.({ type: 'solver-cancel' }); } catch { /* termination is authoritative */ }
    this._terminateWorker();
  }

  async _onStale() {
    // A stale request may still be computing inside the old worker. Terminate
    // that worker and create a fresh one before the replacement query starts.
    this._terminateWorker();
    if (this.state === 'active') this._createWorker();
  }

  async _onTimeout() {
    this._terminateWorker();
  }

  async _onDispose() {
    this._terminateWorker();
  }
}

export class WorkerSolverBackend extends SolverBackend {
  constructor({
    id = WORKER_BACKEND_ID,
    version = WORKER_BACKEND_VERSION,
    maxBvWidth = 8,
    maxAssignments = 1 << 20,
    maxConstraints = 4096,
    maxExprNodes = 100000,
    workerFactory = defaultWorkerFactory,
  } = {}) {
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    this.maxBvWidth = Math.max(1, Math.floor(Number(maxBvWidth)));
    this.maxAssignments = Math.max(1, Math.floor(Number(maxAssignments)));
    this.maxConstraints = Math.max(1, Math.floor(Number(maxConstraints)));
    this.maxExprNodes = Math.max(1, Math.floor(Number(maxExprNodes)));
    this.workerFactory = workerFactory;
  }

  baseCapabilities() {
    return {
      ...new ExhaustiveBvBackend({
        maxBvWidth: this.maxBvWidth,
        maxAssignments: this.maxAssignments,
        maxConstraints: this.maxConstraints,
        maxExprNodes: this.maxExprNodes,
      }).baseCapabilities(),
      executionIsolation: 'dedicated-worker',
      memoryBudgetClass: 'measured-only',
    };
  }

  createSession(options = {}) {
    return new WorkerSolverSession(this, {
      maxBvWidth: this.maxBvWidth,
      maxAssignments: this.maxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      ...options,
    });
  }
}
