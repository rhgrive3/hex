/**
 * js/symbolic/verify/edge-feasibility.js
 *
 * Conditional Edge Feasibility verification.
 * Determines whether a conditional control flow edge is feasible or proved infeasible
 * under explicit, satisfiable source-entry preconditions.
 *
 * CRITICAL PROCESS SAFETY GUARD:
 * Local edge infeasibility is strictly distinguished from global unreachability.
 * This module NEVER claims or labels an edge as "globally unreachable".
 */

import { TRANSLATION_STATUS, COMPLETENESS_STATUS, createCompleteness } from '../translate/support-matrix.js';
import { translateSemanticIR } from '../translate/semantic-ir.js';
import { SOLVER_STATUS } from '../solver/result.js';
import {
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
  VERDICT,
  createVerificationQuery,
} from './query.js';
import { validateSatModel } from './validate-model.js';
import { checkProofEligibility } from './eligibility.js';
import { checkPreconditionsConsistency } from './preconditions.js';

export async function verifyConditionalEdgeFeasibility({
  ir = null,
  fromBlock = null,
  toBlock = null,
  edgeCondition = null,
  preconditions = null,
  backend = null,
  session = null,
  options = {},
} = {}) {
  if (!edgeCondition) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
      reasonCode: 'missing-edge-condition',
      proofStatement: 'Missing edge condition for verification',
      solverStatus: SOLVER_STATUS.INVALID_QUERY,
      assumptions: Object.freeze([]),
      completeness: createCompleteness({ translation: COMPLETENESS_STATUS.UNSUPPORTED }),
      queryHash: null,
      query: null,
      solverResult: null,
    });
  }

  const activeSession = session || (backend ? backend.createSession(options) : null);
  if (!activeSession || typeof activeSession.check !== 'function') {
    throw new TypeError('verifyConditionalEdgeFeasibility: a valid backend or session is required');
  }

  // 1. Translate edge condition if not already an Expr DAG node
  let edgeExpr = null;
  let translationRes = null;

  if (edgeCondition.kind && edgeCondition.sort) {
    // Already an Expr DAG node
    edgeExpr = edgeCondition;
    translationRes = {
      status: TRANSLATION_STATUS.EXACT,
      expression: edgeCondition,
      assumptions: [],
      unsupportedEntities: [],
      semanticUnknowns: 0,
      completeness: createCompleteness(),
    };
  } else {
    // IR instruction or value
    translationRes = translateSemanticIR(edgeCondition, {
      ir,
      fromBlock,
      ...options,
    });
    edgeExpr = translationRes.expression;
  }

  if (!edgeExpr) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
      reasonCode: 'translation-failed',
      proofStatement: 'Edge condition could not be translated into symbolic expression',
      solverStatus: SOLVER_STATUS.UNSUPPORTED,
      assumptions: Object.freeze(translationRes?.assumptions || []),
      completeness: translationRes?.completeness || createCompleteness({ translation: COMPLETENESS_STATUS.UNSUPPORTED }),
      queryHash: null,
      query: null,
      solverResult: null,
    });
  }

  // 2. Normalize preconditions P
  let pExpr = null;
  if (preconditions) {
    if (Array.isArray(preconditions)) {
      pExpr = preconditions;
    } else if (preconditions.kind && preconditions.sort) {
      pExpr = preconditions;
    } else {
      const pTrans = translateSemanticIR(preconditions, { ir, fromBlock, ...options });
      pExpr = pTrans.expression;
      if (pTrans.assumptions?.length) {
        translationRes.assumptions = [...(translationRes.assumptions || []), ...pTrans.assumptions];
      }
      if (pTrans.unsupportedEntities?.length) {
        translationRes.unsupportedEntities = [
          ...(translationRes.unsupportedEntities || []),
          ...pTrans.unsupportedEntities,
        ];
      }
      if (pTrans.semanticUnknowns) {
        translationRes.semanticUnknowns = (translationRes.semanticUnknowns || 0) + pTrans.semanticUnknowns;
      }
    }
  }

  // 3. Build query Q = P ∧ EdgeCondition
  const queryConstraints = [];
  if (Array.isArray(pExpr)) {
    queryConstraints.push(...pExpr.filter(Boolean));
  } else if (pExpr) {
    queryConstraints.push(pExpr);
  }
  queryConstraints.push(edgeExpr);

  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: { fromBlock, toBlock },
    constraints: queryConstraints,
    assertion: null,
    assumptions: translationRes.assumptions,
    completeness: translationRes.completeness,
  });

  // 4. Solve query Q
  const solverResult = await activeSession.check(query, options);

  // 5. Evaluate Solver Result
  // Case A: SAT -> Feasible counterexample found
  if (solverResult.status === SOLVER_STATUS.SAT) {
    const modelValidation = validateSatModel(query, solverResult.model);
    if (!modelValidation.valid) {
      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
        reasonCode: 'invalid-sat-model',
        proofStatement: 'Solver returned SAT model that failed independent validation',
        solverStatus: SOLVER_STATUS.PROVIDER_FAILURE,
        preconditionStatus: 'unknown',
        counterexample: solverResult.model,
        counterexampleValidation: modelValidation,
        assumptions: Object.freeze(translationRes.assumptions || []),
        completeness: translationRes.completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
      });
    }

    return Object.freeze({
      verdict: VERDICT.REFUTED,
      claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
      proofStatement: `Conditional edge from block ${fromBlock ?? 'unknown'} to ${toBlock ?? 'unknown'} is FEASIBLE under preconditions (witness found)`,
      solverStatus: solverResult.status,
      preconditionStatus: 'satisfiable',
      counterexample: solverResult.model,
      counterexampleValidation: Object.freeze({ valid: true }),
      assumptions: Object.freeze(translationRes.assumptions || []),
      completeness: translationRes.completeness,
      queryHash: query.queryHash,
      query,
      solverResult,
    });
  }

  // Case B: UNSAT -> Verify precondition consistency before granting proof
  if (solverResult.status === SOLVER_STATUS.UNSAT) {
    const pCheck = await checkPreconditionsConsistency(pExpr, activeSession, options);

    if (!pCheck.consistent) {
      if (pCheck.status === SOLVER_STATUS.UNSAT) {
        return Object.freeze({
          verdict: VERDICT.UNKNOWN,
          claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
          reasonCode: 'inconsistent-preconditions',
          proofStatement:
            'Preconditions are inconsistent (UNSAT); cannot prove edge infeasibility (vacuous proof rejected)',
          solverStatus: solverResult.status,
          preconditionStatus: 'inconsistent',
          assumptions: Object.freeze(translationRes.assumptions || []),
          completeness: translationRes.completeness,
          queryHash: query.queryHash,
          query,
          solverResult,
        });
      }

      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
        reasonCode: pCheck.reason || 'unresolved-preconditions',
        proofStatement: `Preconditions satisfiability could not be resolved (${pCheck.status})`,
        solverStatus: solverResult.status,
        preconditionStatus: 'unknown',
        assumptions: Object.freeze(translationRes.assumptions || []),
        completeness: translationRes.completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
      });
    }

    // Preconditions are satisfiable; check full proof eligibility
    const isRemote = activeSession.backend?.isRemote || backend?.isRemote || false;
    const eligibility = checkProofEligibility({
      queryValid: true,
      translationStatus: translationRes.status,
      scopeCompleteness: translationRes.completeness,
      semanticUnknowns: translationRes.semanticUnknowns,
      unsupportedEntities: translationRes.unsupportedEntities,
      assumptionsExplicit: true,
      preconditionsConsistent: true,
      backendCapabilityExact: !isRemote,
      solverResultStatus: solverResult.status,
      cancelled: activeSession.isCancelled?.() ?? false,
      budgetExceeded: options.budgetExceeded ?? false,
    });

    if (eligibility.eligible) {
      return Object.freeze({
        verdict: VERDICT.PROVED,
        claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
        proofStatement: `Conditional edge from block ${fromBlock ?? 'unknown'} to ${toBlock ?? 'unknown'} is PROVED INFEASIBLE under satisfiable preconditions`,
        solverStatus: solverResult.status,
        preconditionStatus: 'satisfiable',
        assumptions: Object.freeze(translationRes.assumptions || []),
        completeness: translationRes.completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
      });
    }

    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
      reasonCode: eligibility.reasons.join('; '),
      proofStatement: `Proof ineligible: ${eligibility.reasons.join(', ')}`,
      solverStatus: solverResult.status,
      preconditionStatus: 'satisfiable',
      assumptions: Object.freeze(translationRes.assumptions || []),
      completeness: translationRes.completeness,
      queryHash: query.queryHash,
      query,
      solverResult,
    });
  }

  // Case C: Non-conclusive solver statuses (TIMEOUT, CANCELLED, RESOURCE_LIMIT, UNSUPPORTED, etc.)
  return Object.freeze({
    verdict: VERDICT.UNKNOWN,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    reasonCode: solverResult.reason || solverResult.status,
    proofStatement: `Verification inconclusive: solver status ${solverResult.status}${
      solverResult.reason ? ` (${solverResult.reason})` : ''
    }`,
    solverStatus: solverResult.status,
    preconditionStatus: 'unknown',
    assumptions: Object.freeze(translationRes.assumptions || []),
    completeness: translationRes.completeness,
    queryHash: query.queryHash,
    query,
    solverResult,
  });
}
