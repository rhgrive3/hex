/**
 * js/symbolic/verify/preconditions.js
 *
 * Precondition consistency checker and Vacuous Proof Guard.
 * Proves that claim preconditions P are satisfiable before allowing
 * an UNSAT result to mint a verified fact or proof.
 */

import { EXPR_KIND, SORT_KIND } from '../expr/kinds.js';
import { SOLVER_STATUS } from '../solver/result.js';
import { VERIFICATION_QUERY_KIND, CLAIM_KIND, createVerificationQuery } from './query.js';
import { validateSatModel } from './validate-model.js';

export async function checkPreconditionsConsistency(preconditionsExpr, session, options = {}) {
  // 1. Trivial satisfiability for empty/null preconditions
  if (!preconditionsExpr) {
    return Object.freeze({
      consistent: true,
      status: SOLVER_STATUS.SAT,
      model: null,
      trivial: true,
    });
  }

  if (Array.isArray(preconditionsExpr) && preconditionsExpr.length === 0) {
    return Object.freeze({
      consistent: true,
      status: SOLVER_STATUS.SAT,
      model: null,
      trivial: true,
    });
  }

  // Check trivial constant boolean
  if (
    !Array.isArray(preconditionsExpr) &&
    preconditionsExpr.kind === EXPR_KIND.CONST &&
    preconditionsExpr.sort?.kind === SORT_KIND.BOOL
  ) {
    if (preconditionsExpr.value === true) {
      return Object.freeze({
        consistent: true,
        status: SOLVER_STATUS.SAT,
        model: null,
        trivial: true,
      });
    }
    if (preconditionsExpr.value === false) {
      return Object.freeze({
        consistent: false,
        status: SOLVER_STATUS.UNSAT,
        reason: 'inconsistent-preconditions',
      });
    }
  }

  if (!session || typeof session.check !== 'function') {
    throw new TypeError('checkPreconditionsConsistency: a valid SolverSession is required');
  }

  // 2. Build precondition query
  const constraints = Array.isArray(preconditionsExpr) ? preconditionsExpr : [preconditionsExpr];
  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'preconditions',
    constraints,
    assertion: null,
  });

  // 3. Solve precondition query using the session
  const result = await session.check(query, options);

  if (result.status === SOLVER_STATUS.UNSAT) {
    return Object.freeze({
      consistent: false,
      status: SOLVER_STATUS.UNSAT,
      reason: 'inconsistent-preconditions',
      result,
    });
  }

  if (result.status === SOLVER_STATUS.SAT) {
    if (result.model) {
      const validation = validateSatModel(query, result.model);
      if (!validation.valid) {
        return Object.freeze({
          consistent: false,
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason: 'invalid-precondition-sat-model',
          validation,
          result,
        });
      }
    }
    return Object.freeze({
      consistent: true,
      status: SOLVER_STATUS.SAT,
      model: result.model,
      result,
    });
  }

  // Non-conclusive solver status (timeout, cancelled, unsupported, etc.)
  return Object.freeze({
    consistent: false,
    status: result.status,
    reason: result.reason || 'unresolved-preconditions',
    result,
  });
}
