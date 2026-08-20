/**
 * js/symbolic/solver/registry.js
 *
 * Central registry for SolverBackend providers.
 */

import { FakeSolverBackend } from './fake-backend.js';

export class SolverRegistry {
  constructor() {
    this._backends = new Map();
    this._defaultBackendId = null;
  }

  registerBackend(backend) {
    if (!backend || !backend.id) {
      throw new TypeError('registerBackend: backend must have a valid id');
    }
    this._backends.set(backend.id, backend);
    if (!this._defaultBackendId) {
      this._defaultBackendId = backend.id;
    }
  }

  unregisterBackend(id) {
    this._backends.delete(id);
    if (this._defaultBackendId === id) {
      this._defaultBackendId = this._backends.keys().next().value || null;
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
    this._defaultBackendId = id;
  }

  getDefaultBackend() {
    return this.getBackend(this._defaultBackendId);
  }

  listBackends() {
    return [...this._backends.values()].map((b) => ({
      id: b.id,
      version: b.version,
      isRemote: b.isRemote,
      isWasm: b.isWasm,
      capabilities: b.capabilities(),
    }));
  }
}

export const defaultSolverRegistry = new SolverRegistry();
defaultSolverRegistry.registerBackend(new FakeSolverBackend({ id: 'default-solver', version: '1.0.0' }));
