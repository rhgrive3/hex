/**
 * js/symbolic/solver/registry.js
 *
 * Central registry for SolverBackend providers.
 */

import { FakeSolverBackend } from './fake-backend.js';
import { PROOF_AUTHORITY } from './backend.js';
import { ExhaustiveBvBackend } from './exhaustive-backend.js';
import { WorkerSolverBackend } from './worker-backend.js';

export class SolverRegistry {
  constructor({ allowNonExactDefault = true } = {}) {
    this._backends = new Map();
    this._defaultBackendId = null;
    this._allowNonExactDefault = allowNonExactDefault;
  }

  registerBackend(backend) {
    if (!backend || !backend.id) {
      throw new TypeError('registerBackend: backend must have a valid id');
    }
    this._backends.set(backend.id, backend);
    if (!this._defaultBackendId && (this._allowNonExactDefault || backend.proofAuthority === PROOF_AUTHORITY.EXACT)) {
      this._defaultBackendId = backend.id;
    }
  }

  unregisterBackend(id) {
    this._backends.delete(id);
    if (this._defaultBackendId === id) {
      const replacement = [...this._backends.values()].find((backend) =>
        this._allowNonExactDefault || backend.proofAuthority === PROOF_AUTHORITY.EXACT
      );
      this._defaultBackendId = replacement?.id || null;
    }
  }

  getBackend(id = null) {
    const targetId = id || this._defaultBackendId;
    if (!targetId) return null;
    return this._backends.get(targetId) || null;
  }

  hasBackend(id) {
    return this._backends.has(id);
  }

  setDefaultBackend(id) {
    if (!this._backends.has(id)) {
      throw new Error(`setDefaultBackend: backend '${id}' is not registered`);
    }
    if (!this._allowNonExactDefault && this._backends.get(id).proofAuthority !== PROOF_AUTHORITY.EXACT) {
      throw new Error(`setDefaultBackend: backend '${id}' is not an exact production backend`);
    }
    this._defaultBackendId = id;
  }

  getDefaultBackend() {
    return this.getBackend(this._defaultBackendId);
  }

  listBackends() {
    return [...this._backends.values()].map((b) => ({
      id: b.id,
      version: b.version,
      proofAuthority: b.proofAuthority,
      isRemote: b.isRemote,
      isWasm: b.isWasm,
      capabilityFingerprint: b.capabilityFingerprint?.() || null,
      capabilities: b.capabilities(),
    }));
  }
}

export function createProductionSolverRegistry({ workerFactory = null, preferWorker = true } = {}) {
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const canUseWorker = preferWorker && (workerFactory || typeof globalThis.Worker === 'function');
  const backend = canUseWorker
    ? new WorkerSolverBackend({ workerFactory: workerFactory || undefined })
    : new ExhaustiveBvBackend();
  registry.registerBackend(backend);
  return registry;
}

export function createTestSolverRegistry() {
  const registry = new SolverRegistry();
  registry.registerBackend(new FakeSolverBackend({ id: 'test-fake-solver', version: '1.0.0' }));
  return registry;
}

// Production imports never receive a fake provider. Browser targets select the
// isolated worker transport; Node/CI uses the same exact finite-domain backend
// directly because Worker is not a browser primitive there.
export const defaultSolverRegistry = createProductionSolverRegistry();
