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
import { isValidSolverResult, SOLVER_STATUS } from '../solver/result.js';
import {
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
  VERDICT,
  createVerificationQuery,
} from './query.js';
import { validateSatModel } from './validate-model.js';
import { checkProofEligibility } from './eligibility.js';
import { checkPreconditionsConsistency } from './preconditions.js';
import { createSymbolicEvidence } from '../evidence/symbolic-evidence.js';

export async function verifyConditionalEdgeFeasibility({
  ir = null,
  fromBlock = null,
  toBlock = null,
  edgeCondition = null,
  preconditions = null,
  backend = null,
  session = null,
  options = {},
  queryKind = VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
  claimKind = CLAIM_KIND.EDGE_INFEASIBLE,
} = {}) {
  if (!edgeCondition) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind,
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
      claimKind,
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
      if (pTrans.completeness) {
        translationRes.completeness = createCompleteness(Object.fromEntries(
          Object.keys(translationRes.completeness || {}).map((key) => [
            key,
            pTrans.completeness[key] === COMPLETENESS_STATUS.COMPLETE
              ? translationRes.completeness?.[key] || COMPLETENESS_STATUS.COMPLETE
              : pTrans.completeness[key],
          ])
        ));
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
    kind: queryKind,
    claimKind,
    targetEntity: { fromBlock, toBlock },
    constraints: queryConstraints,
    assertion: null,
    assumptions: translationRes.assumptions,
    completeness: translationRes.completeness,
    semanticIrVersion: options.semanticIrVersion,
    translatorVersion: options.translatorVersion,
    architecture: options.architecture,
    bitWidth: options.bitWidth ?? edgeExpr.sort?.width ?? null,
    proofScope: options.proofScope || {
      kind: queryKind,
      fromBlock,
      toBlock,
      global: queryKind === VERIFICATION_QUERY_KIND.GLOBAL_EDGE_REACHABILITY,
    },
  });

  // 4. Solve query Q
  const solverResult = await activeSession.check(query, options);

  const lifecycle = solverResult?.lifecycle || {};
  if (lifecycle.publishable === false || lifecycle.timedOut || lifecycle.cancelled || lifecycle.stale || lifecycle.disposed) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind,
      reasonCode: lifecycle.timedOut ? 'timeout' : lifecycle.stale ? 'stale-result' : lifecycle.disposed ? 'disposed-session' : 'cancelled',
      proofStatement: 'Solver result was invalidated by timeout, cancellation, disposal, or stale query replacement',
      solverStatus: solverResult.status,
      preconditionStatus: 'unknown',
      assumptions: Object.freeze(translationRes.assumptions || []),
      completeness: translationRes.completeness,
      queryHash: query.queryHash,
      query,
      solverResult,
      evidence: null,
    });
  }

  // 5. Evaluate Solver Result
  // Case A: SAT -> Feasible counterexample found
  if (solverResult.status === SOLVER_STATUS.SAT) {
    const modelValidation = validateSatModel(query, solverResult.model);
    if (!modelValidation.valid) {
      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind,
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
      claimKind,
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
          claimKind,
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
        claimKind,
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
    const eligibility = checkProofEligibility({
      queryValid: true,
      query,
      translationStatus: translationRes.status,
      scopeCompleteness: translationRes.completeness,
      semanticUnknowns: translationRes.semanticUnknowns,
      unsupportedEntities: translationRes.unsupportedEntities,
      assumptionsExplicit: true,
      preconditionsConsistent: true,
      backend: activeSession.backend || backend,
      solverResult,
      validSolverResult: isValidSolverResult(solverResult, { query, backend: activeSession.backend || backend }),
      solverResultStatus: solverResult.status,
      cancelled: activeSession.isCancelled?.() ?? false,
      timedOut: lifecycle.timedOut === true,
      stale: lifecycle.stale === true,
      disposed: lifecycle.disposed === true,
      budgetExceeded: options.budgetExceeded ?? false,
      budgetFailure: lifecycle.budgetExceeded === true,
    });

    if (eligibility.eligible) {
      const proofBackend = activeSession.backend || backend;
      const evidence = createSymbolicEvidence({
        queryKind: query.kind,
        claimKind,
        proofStatement: `Conditional edge from block ${fromBlock ?? 'unknown'} to ${toBlock ?? 'unknown'} is PROVED INFEASIBLE under satisfiable preconditions`,
        targetEntities: [String(fromBlock ?? 'unknown'), String(toBlock ?? 'unknown')],
        queryHash: query.queryHash,
        exprSchemaVersion: '1.0.0',
        translatorVersion: query.translatorVersion,
        semanticIrVersion: query.semanticIrVersion,
        backendId: proofBackend.id,
        backendVersion: proofBackend.version,
        proofAuthority: proofBackend.proofAuthority,
        capabilityFingerprint: proofBackend.capabilityFingerprint(),
        solverStatus: solverResult.status,
        preconditionStatus: 'satisfiable',
        validationStatus: 'not-applicable',
        assumptions: translationRes.assumptions || [],
        completeness: translationRes.completeness,
        architecture: query.architecture,
        bitWidth: query.bitWidth,
        proofScope: query.proofScope,
        verdict: VERDICT.PROVED,
      });
      return Object.freeze({
        verdict: VERDICT.PROVED,
        claimKind,
        proofStatement: `Conditional edge from block ${fromBlock ?? 'unknown'} to ${toBlock ?? 'unknown'} is PROVED INFEASIBLE under satisfiable preconditions`,
        solverStatus: solverResult.status,
        preconditionStatus: 'satisfiable',
        assumptions: Object.freeze(translationRes.assumptions || []),
        completeness: translationRes.completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
        proofAuthority: proofBackend.proofAuthority,
        capabilityFingerprint: proofBackend.capabilityFingerprint(),
        evidence,
      });
    }

    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind,
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
    claimKind,
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
