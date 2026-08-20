/**
 * js/symbolic/verify/global-reachability.js
 *
 * Global Edge Reachability query engine.
 * Strictly requires complete CFG path coverage, loop-unroll completeness,
 * and entry preconditions before minting a global unreachability proof.
 * Local edge infeasibility is never promoted to global unreachable when
 * incoming path completeness is partial.
 */

import {
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
  VERDICT,
} from './query.js';
import {
  COMPLETENESS_STATUS,
  createCompleteness,
} from '../translate/support-matrix.js';
import { SOLVER_STATUS } from '../solver/result.js';
import { verifyConditionalEdgeFeasibility } from './edge-feasibility.js';

export async function verifyGlobalEdgeReachability({
  ir = null,
  entryBlock = 0,
  targetBlock = null,
  targetEdge = null,
  pathCompleteness = 'partial',
  backend = null,
  session = null,
  options = {},
} = {}) {
  // If path coverage is not complete, fail closed immediately
  if (pathCompleteness !== COMPLETENESS_STATUS.COMPLETE) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
      reasonCode: 'incomplete-path-coverage',
      proofStatement: 'Global unreachability cannot be proved: CFG incoming path coverage or loop unrolling is incomplete (local infeasibility is not global unreachability)',
      solverStatus: SOLVER_STATUS.UNSUPPORTED,
      completeness: createCompleteness({
        pathCoverage: COMPLETENESS_STATUS.PARTIAL,
      }),
      queryHash: null,
      query: null,
      solverResult: null,
      evidence: null,
    });
  }

  // If path coverage is declared complete by upstream contract:
  return verifyConditionalEdgeFeasibility({
    ir,
    fromBlock: entryBlock,
    toBlock: targetBlock,
    edgeCondition: targetEdge,
    backend,
    session,
    options,
  });
}
