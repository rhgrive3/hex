/**
 * js/symbolic/solver/session.js
 *
 * Base class for SolverSession with lifecycle management, idempotency,
 * and stale result protection.
 */

import { SOLVER_STATUS, createSolverResult } from './result.js';

export const SESSION_STATE = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
  DISPOSED: 'disposed',
});

export class SolverSession {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = Object.freeze({ ...options });
    this.state = SESSION_STATE.ACTIVE;
    this.currentQueryToken = 0;
  }

  isDisposed() {
    return this.state === SESSION_STATE.DISPOSED;
  }

  isCancelled() {
    return this.state === SESSION_STATE.CANCELLED;
  }

  async check(query, options = {}) {
    if (this.isDisposed()) {
      return createSolverResult({
        status: SOLVER_STATUS.INVALID_QUERY,
        reason: 'session-already-disposed',
        backend: this.backend?.id || 'unknown',
        backendVersion: this.backend?.version || '0.0.0',
      });
    }

    if (this.isCancelled()) {
      return createSolverResult({
        status: SOLVER_STATUS.CANCELLED,
        reason: 'session-was-cancelled',
        backend: this.backend?.id || 'unknown',
        backendVersion: this.backend?.version || '0.0.0',
      });
    }

    const token = ++this.currentQueryToken;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 5000;

    let timer = null;
    let timedOut = false;

    const timeoutPromise = new Promise((resolve) => {
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(
            createSolverResult({
              status: SOLVER_STATUS.TIMEOUT,
              reason: `query execution timed out after ${timeoutMs}ms`,
              backend: this.backend?.id || 'unknown',
              backendVersion: this.backend?.version || '0.0.0',
            })
          );
        }, timeoutMs);
      }
    });

    try {
      const executionPromise = this._executeCheck(query, options, token);
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // Guard: Stale result rejection. If token does not match or session disposed, discard result
      if (token !== this.currentQueryToken) {
        return createSolverResult({
          status: SOLVER_STATUS.CANCELLED,
          reason: 'stale-query-token-discarded',
          backend: this.backend?.id || 'unknown',
          backendVersion: this.backend?.version || '0.0.0',
        });
      }

      if (this.isDisposed()) {
        return createSolverResult({
          status: SOLVER_STATUS.CANCELLED,
          reason: 'session-disposed-during-execution',
          backend: this.backend?.id || 'unknown',
          backendVersion: this.backend?.version || '0.0.0',
        });
      }

      if (this.isCancelled()) {
        return createSolverResult({
          status: SOLVER_STATUS.CANCELLED,
          reason: 'session-cancelled-during-execution',
          backend: this.backend?.id || 'unknown',
          backendVersion: this.backend?.version || '0.0.0',
        });
      }

      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Internal execution method to be overridden by subclasses.
   */
  async _executeCheck(query, options, token) {
    throw new Error('_executeCheck must be implemented by solver session subclass');
  }

  async cancel() {
    if (this.state === SESSION_STATE.CANCELLED || this.state === SESSION_STATE.DISPOSED) return;
    this.state = SESSION_STATE.CANCELLED;
    this.currentQueryToken++; // Invalidate any in-flight token
    await this._onCancel();
  }

  async dispose() {
    if (this.state === SESSION_STATE.DISPOSED) return;
    this.state = SESSION_STATE.DISPOSED;
    this.currentQueryToken++; // Invalidate any in-flight token
    await this._onDispose();
  }

  async _onCancel() {
    // Optional hook for subclasses
  }

  async _onDispose() {
    // Optional hook for subclasses
  }
}
