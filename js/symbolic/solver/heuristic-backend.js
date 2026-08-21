/**
 * Non-authoritative heuristic provider used only to exercise trust-boundary
 * regressions. It deliberately cannot satisfy exact proof eligibility.
 */

import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

class HeuristicSession extends SolverSession {
  async _executeCheck(query) {
    return createSolverResult({
      status: this.backend.defaultStatus,
      model: this.backend.defaultModel,
      reason: 'heuristic-provider-result',
      backend: this.backend.id,
      backendVersion: this.backend.version,
      queryHash: query?.queryHash || null,
    });
  }
}

export class HeuristicSolverBackend extends SolverBackend {
  constructor({ id = 'heuristic-solver', version = '1.0.0', defaultStatus = SOLVER_STATUS.UNSAT, defaultModel = null } = {}) {
    super({ id, version, proofAuthority: PROOF_AUTHORITY.HEURISTIC, isRemote: false, isWasm: false });
    this.defaultStatus = defaultStatus;
    this.defaultModel = defaultModel;
  }

  baseCapabilities() {
    return { ...super.baseCapabilities(), exactProofs: false, executionIsolation: 'caller-selected' };
  }

  createSession(options = {}) { return new HeuristicSession(this, options); }
}
