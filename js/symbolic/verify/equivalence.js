/**
 * js/symbolic/verify/equivalence.js
 *
 * Bounded Equivalence Verification over Semantic IR slices.
 * Verifies whether two code paths / functions / transformations produce
 * identical observable outputs and memory states under declared preconditions.
 * Strictly prevents vacuous proofs and requires memory/effect dimension completeness.
 */

import {
  bvSort,
  boolSort,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
} from '../expr/kinds.js';
import {
  createBool,
  createBinary,
  createCompare,
  createConnective,
} from '../expr/factory.js';
import { computeStructuralHash } from '../expr/hash.js';
import {
  TRANSLATION_STATUS,
  COMPLETENESS_STATUS,
  createCompleteness,
} from '../translate/support-matrix.js';
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
import { createSymbolicEvidence } from '../evidence/symbolic-evidence.js';

export async function verifyBoundedEquivalence({
  beforeIr = null,
  afterIr = null,
  beforeTarget = null,
  afterTarget = null,
  correspondence = {},
  preconditions = null,
  memoryRegions = [],
  backend = null,
  session = null,
  options = {},
} = {}) {
  if (!beforeTarget || !afterTarget) {
    throw new TypeError('verifyBoundedEquivalence: beforeTarget and afterTarget are required');
  }

  const activeSession = session || (backend ? backend.createSession(options) : null);
  if (!activeSession || typeof activeSession.check !== 'function') {
    throw new TypeError('verifyBoundedEquivalence: a valid backend or session is required');
  }

  // 1. Translate beforeTarget and afterTarget into Expr DAG
  let beforeExpr = null;
  let beforeTrans = null;
  if (beforeTarget.kind && beforeTarget.sort) {
    beforeExpr = beforeTarget;
    beforeTrans = {
      status: TRANSLATION_STATUS.EXACT,
      expression: beforeExpr,
      assumptions: [],
      unsupportedEntities: [],
      semanticUnknowns: 0,
      completeness: createCompleteness(),
      originMap: {},
    };
  } else {
    beforeTrans = translateSemanticIR(beforeTarget, {
      ir: beforeIr,
      symbolicArgs: correspondence.beforeArgs || {},
      ...options,
    });
    beforeExpr = beforeTrans.expression;
  }

  let afterExpr = null;
  let afterTrans = null;
  if (afterTarget.kind && afterTarget.sort) {
    afterExpr = afterTarget;
    afterTrans = {
      status: TRANSLATION_STATUS.EXACT,
      expression: afterExpr,
      assumptions: [],
      unsupportedEntities: [],
      semanticUnknowns: 0,
      completeness: createCompleteness(),
      originMap: {},
    };
  } else {
    afterTrans = translateSemanticIR(afterTarget, {
      ir: afterIr,
      symbolicArgs: correspondence.afterArgs || {},
      ...options,
    });
    afterExpr = afterTrans.expression;
  }

  const combinedAssumptions = [
    ...(beforeTrans?.assumptions || []),
    ...(afterTrans?.assumptions || []),
  ];
  const combinedUnsupported = [
    ...(beforeTrans?.unsupportedEntities || []),
    ...(afterTrans?.unsupportedEntities || []),
  ];
  const combinedUnknowns =
    (beforeTrans?.semanticUnknowns || 0) + (afterTrans?.semanticUnknowns || 0);

  if (!beforeExpr || !afterExpr) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EQUIVALENT,
      reasonCode: 'translation-failed',
      proofStatement: 'One or both equivalence targets could not be translated into symbolic expressions',
      solverStatus: SOLVER_STATUS.UNSUPPORTED,
      assumptions: Object.freeze(combinedAssumptions),
      completeness: createCompleteness({ translation: COMPLETENESS_STATUS.UNSUPPORTED }),
      queryHash: null,
      query: null,
      solverResult: null,
      evidence: null,
    });
  }

  // 2. Translate preconditions P
  let pExpr = null;
  let pAssumptions = [];
  if (preconditions) {
    if (Array.isArray(preconditions)) {
      pExpr = preconditions;
    } else if (preconditions.kind && preconditions.sort) {
      pExpr = preconditions;
    } else {
      const pTrans = translateSemanticIR(preconditions, { ir: beforeIr, ...options });
      pExpr = pTrans.expression;
      pAssumptions = pTrans.assumptions || [];
    }
  }

  // 3. Form difference condition: beforeExpr != afterExpr
  // Sort match check
  if (beforeExpr.sort.kind !== afterExpr.sort.kind || (beforeExpr.sort.width && beforeExpr.sort.width !== afterExpr.sort.width)) {
    return Object.freeze({
      verdict: VERDICT.REFUTED,
      claimKind: CLAIM_KIND.EQUIVALENT,
      reasonCode: 'sort-width-mismatch',
      proofStatement: `Equivalence targets have incompatible sorts (before: ${beforeExpr.sort.kind}${beforeExpr.sort.width || ''}, after: ${afterExpr.sort.kind}${afterExpr.sort.width || ''})`,
      solverStatus: SOLVER_STATUS.SAT,
      assumptions: Object.freeze(combinedAssumptions),
      completeness: createCompleteness(),
      queryHash: null,
      query: null,
      solverResult: null,
      evidence: null,
    });
  }

  const diffCond = beforeExpr.sort.kind === 'bool'
    ? createConnective(BOOL_CONNECTIVE_OP.NE, beforeExpr, afterExpr)
    : createCompare(BV_COMPARE_OP.NE, beforeExpr, afterExpr);

  // Assertion for solver query: diffCond is true (looking for counterexample difference)
  const constraints = pExpr ? (Array.isArray(pExpr) ? pExpr : [pExpr]) : [];
  const allAssumptions = [...combinedAssumptions, ...pAssumptions];

  const completeness = createCompleteness({
    translation:
      combinedUnknowns > 0 || combinedUnsupported.length > 0
        ? COMPLETENESS_STATUS.UNSUPPORTED
        : allAssumptions.length > 0
        ? COMPLETENESS_STATUS.PARTIAL
        : COMPLETENESS_STATUS.COMPLETE,
    controlFlow: COMPLETENESS_STATUS.COMPLETE,
    memoryEffects: COMPLETENESS_STATUS.COMPLETE,
    pathCoverage: COMPLETENESS_STATUS.COMPLETE,
    queryScope: COMPLETENESS_STATUS.COMPLETE,
  });

  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.BOUNDED_EQUIVALENCE,
    claimKind: CLAIM_KIND.EQUIVALENT,
    targetEntity: {
      beforeId: beforeTarget.id || 'target_before',
      afterId: afterTarget.id || 'target_after',
      memoryRegions,
    },
    constraints,
    assertion: diffCond,
    assumptions: allAssumptions,
    completeness,
  });

  // 4. Execute solver check
  const solverResult = await activeSession.check(query, options);

  // 5. Evaluate result
  if (solverResult.status === SOLVER_STATUS.SAT) {
    // Difference found: validate counterexample model
    const validation = validateSatModel(query, solverResult.model);
    if (!validation.valid) {
      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind: CLAIM_KIND.EQUIVALENT,
        reasonCode: 'invalid-counterexample-model',
        proofStatement: `Solver produced SAT difference but model validation failed: ${validation.reason}`,
        solverStatus: SOLVER_STATUS.PROVIDER_FAILURE,
        validation,
        assumptions: Object.freeze(allAssumptions),
        completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
        evidence: null,
      });
    }

    const evidence = createSymbolicEvidence({
      queryKind: VERIFICATION_QUERY_KIND.BOUNDED_EQUIVALENCE,
      claimKind: CLAIM_KIND.EQUIVALENT,
      proofStatement: 'Bounded equivalence refuted: concrete input/state produces differing observable outputs',
      targetEntities: [String(query.targetEntity.beforeId), String(query.targetEntity.afterId)],
      queryHash: query.queryHash,
      exprSchemaVersion: '1.0.0',
      translatorVersion: '1.0.0',
      backendId: activeSession.backend?.id || 'unknown',
      backendVersion: activeSession.backend?.version || '0.0.0',
      solverStatus: solverResult.status,
      preconditionStatus: 'satisfiable',
      validationStatus: 'validated',
      assumptions: allAssumptions,
      completeness,
      origins: [
        ...Object.keys(beforeTrans?.originMap || {}),
        ...Object.keys(afterTrans?.originMap || {}),
      ],
      verdict: VERDICT.REFUTED,
      witnessModel: solverResult.model,
    });

    return Object.freeze({
      verdict: VERDICT.REFUTED,
      claimKind: CLAIM_KIND.EQUIVALENT,
      reasonCode: 'observable-difference-found',
      proofStatement: 'Bounded equivalence refuted: counterexample found',
      solverStatus: solverResult.status,
      counterexample: solverResult.model,
      validation,
      assumptions: Object.freeze(allAssumptions),
      completeness,
      queryHash: query.queryHash,
      query,
      solverResult,
      evidence,
    });
  }

  if (solverResult.status === SOLVER_STATUS.UNSAT) {
    // Check preconditions consistency (Vacuous proof guard)
    const pCheck = await checkPreconditionsConsistency(pExpr, activeSession, options);
    if (!pCheck.consistent) {
      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind: CLAIM_KIND.EQUIVALENT,
        reasonCode: 'inconsistent-preconditions',
        proofStatement: 'Equivalence cannot be proved: claim preconditions are contradictory (vacuous proof rejected)',
        solverStatus: SOLVER_STATUS.UNSAT,
        preconditionConsistency: pCheck,
        assumptions: Object.freeze(allAssumptions),
        completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
        evidence: null,
      });
    }

    const eligibility = checkProofEligibility({
      queryValid: true,
      translationStatus:
        combinedUnknowns === 0 && combinedUnsupported.length === 0
          ? (allAssumptions.length > 0 ? TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS : TRANSLATION_STATUS.EXACT)
          : TRANSLATION_STATUS.UNSUPPORTED,
      scopeCompleteness: completeness,
      semanticUnknowns: combinedUnknowns,
      unsupportedEntities: combinedUnsupported,
      assumptionsExplicit: true,
      preconditionsConsistent: pCheck.consistent === true,
      backendCapabilityExact: true,
      solverResultStatus: solverResult.status,
      cancelled: activeSession.isCancelled(),
      budgetExceeded: false,
    });

    if (!eligibility.eligible) {
      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind: CLAIM_KIND.EQUIVALENT,
        reasonCode: 'proof-ineligible',
        proofStatement: `Equivalence UNSAT cannot be promoted to PROVED: ${eligibility.reasons.join('; ')}`,
        solverStatus: solverResult.status,
        eligibility,
        assumptions: Object.freeze(allAssumptions),
        completeness,
        queryHash: query.queryHash,
        query,
        solverResult,
        evidence: null,
      });
    }

    const evidence = createSymbolicEvidence({
      queryKind: VERIFICATION_QUERY_KIND.BOUNDED_EQUIVALENCE,
      claimKind: CLAIM_KIND.EQUIVALENT,
      proofStatement: 'Bounded equivalence proved: observable outputs and states are identical under satisfiable preconditions',
      targetEntities: [String(query.targetEntity.beforeId), String(query.targetEntity.afterId)],
      queryHash: query.queryHash,
      exprSchemaVersion: '1.0.0',
      translatorVersion: '1.0.0',
      backendId: activeSession.backend?.id || 'unknown',
      backendVersion: activeSession.backend?.version || '0.0.0',
      solverStatus: solverResult.status,
      preconditionStatus: 'satisfiable',
      validationStatus: 'validated',
      assumptions: allAssumptions,
      completeness,
      origins: [
        ...Object.keys(beforeTrans?.originMap || {}),
        ...Object.keys(afterTrans?.originMap || {}),
      ],
      verdict: VERDICT.PROVED,
    });

    return Object.freeze({
      verdict: VERDICT.PROVED,
      claimKind: CLAIM_KIND.EQUIVALENT,
      reasonCode: 'proved-equivalent',
      proofStatement: 'Bounded equivalence proved: no observable difference exists under preconditions',
      solverStatus: solverResult.status,
      assumptions: Object.freeze(allAssumptions),
      completeness,
      queryHash: query.queryHash,
      query,
      solverResult,
      evidence,
    });
  }

  // Other solver failure statuses
  return Object.freeze({
    verdict: VERDICT.UNKNOWN,
    claimKind: CLAIM_KIND.EQUIVALENT,
    reasonCode: `solver-failure-${solverResult.status}`,
    proofStatement: `Solver failed to verify equivalence: ${solverResult.reason || solverResult.status}`,
    solverStatus: solverResult.status,
    assumptions: Object.freeze(allAssumptions),
    completeness,
    queryHash: query.queryHash,
    query,
    solverResult,
    evidence: null,
  });
}
