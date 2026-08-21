/**
 * js/symbolic/solver/fake-backend.js
 *
 * Configurable mock SolverBackend for contract testing, lifecycle validation,
 * and status taxonomy verification.
 */

import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { SolverSession } from './session.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';

export class FakeSolverSession extends SolverSession {
  constructor(backend, options = {}) {
    super(backend, options);
    this.cancelCount = 0;
    this.disposeCount = 0;
    this.queriesHandled = 0;
  }

  async _executeCheck(query, options, token, signal) {
    this.queriesHandled++;

    const delayMs = options.delayMs ?? this.options.delayMs ?? this.backend.defaultDelayMs ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          fn(value);
        };
        const timer = setTimeout(() => finish(resolve), delayMs);
        const onAbort = () => {
          finish(reject, new Error('fake-provider-aborted'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }

    // Check if handler is configured on backend or session options
    const handler = options.handler || this.options.handler || this.backend.handler;
    if (typeof handler === 'function') {
      const custom = await handler(query, options, this);
      return createSolverResult({
        ...custom,
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
      });
    }

    // Map lookup
    const queryMap = options.queryMap || this.options.queryMap || this.backend.queryMap;
    if (queryMap && query?.queryHash && queryMap.has(query.queryHash)) {
      const hit = queryMap.get(query.queryHash);
      return createSolverResult({
        ...hit,
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query.queryHash,
      });
    }

    const defaultStatus = options.defaultStatus || this.options.defaultStatus || this.backend.defaultStatus || SOLVER_STATUS.UNKNOWN;
    const defaultModel = options.defaultModel || this.options.defaultModel || this.backend.defaultModel || null;

    return createSolverResult({
      status: defaultStatus,
      model: defaultModel,
      reason: options.defaultReason || this.options.defaultReason || null,
      stats: { solveTimeMs: delayMs, nodesEvaluated: 10 },
      backend: this.backend.id,
      backendVersion: this.backend.version,
      queryHash: query?.queryHash || null,
    });
  }

  async _onCancel() {
    this.cancelCount++;
  }

  async _onDispose() {
    this.disposeCount++;
  }
}

export class FakeSolverBackend extends SolverBackend {
  constructor({
    id = 'fake-solver',
    version = '1.0.0',
    defaultStatus = SOLVER_STATUS.UNKNOWN,
    defaultModel = null,
    defaultDelayMs = 0,
    handler = null,
    queryMap = null,
  } = {}) {
    // A fake/test provider is never allowed to opt into proof authority.
    super({ id, version, proofAuthority: PROOF_AUTHORITY.TEST_ONLY, isRemote: false, isWasm: false });
    this.defaultStatus = defaultStatus;
    this.defaultModel = defaultModel;
    this.defaultDelayMs = defaultDelayMs;
    this.handler = handler;
    this.queryMap = queryMap;
    this.createdSessions = [];
  }

  createSession(options = {}) {
    const session = new FakeSolverSession(this, options);
    this.createdSessions.push(session);
    return session;
  }
}
