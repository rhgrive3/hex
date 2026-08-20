/**
 * js/symbolic/solver/backend.js
 *
 * Base class for SolverBackend abstraction.
 */

export class SolverBackend {
  constructor({ id, version, isRemote = false, isWasm = false }) {
    if (!id || !version) {
      throw new TypeError('SolverBackend: id and version are required');
    }
    this.id = String(id);
    this.version = String(version);
    this.isRemote = Boolean(isRemote);
    this.isWasm = Boolean(isWasm);
  }

  capabilities() {
    return Object.freeze({
      supportedSorts: Object.freeze(['bool', 'bv']),
      maxBvWidth: 64,
      supportsQuantifiers: false,
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      isRemote: this.isRemote,
      isWasm: this.isWasm,
    });
  }

  createSession(options = {}) {
    throw new Error('createSession must be implemented by solver backend subclass');
  }
}
