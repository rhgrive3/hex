/**
 * js/symbolic/verify/equivalence.js
 *
 * Bounded Equivalence Verification over Semantic IR slices.
 * Verifies whether two code paths / functions / transformations produce
 * identical observable outputs and memory states under declared preconditions.
 * Strictly prevents vacuous proofs and requires memory/effect dimension completeness.
 */

import {
  EXPR_KIND,
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

function collectFreshSymbols(expr, out = [], seen = new Set()) {
  if (!expr || typeof expr !== 'object' || seen.has(expr)) return out;
  seen.add(expr);
  if (expr.kind === EXPR_KIND.FRESH_SYMBOL) out.push(expr);
  if (expr.kind === EXPR_KIND.UNARY || expr.kind === EXPR_KIND.EXTRACT || expr.kind === EXPR_KIND.CAST) collectFreshSymbols(expr.arg, out, seen);
  else if (expr.kind === EXPR_KIND.BINARY || expr.kind === EXPR_KIND.COMPARE || expr.kind === EXPR_KIND.CONCAT) {
    collectFreshSymbols(expr.left, out, seen); collectFreshSymbols(expr.right, out, seen);
  } else if (expr.kind === EXPR_KIND.CONNECTIVE) {
    for (const arg of expr.args || []) collectFreshSymbols(arg, out, seen);
  } else if (expr.kind === EXPR_KIND.ITE) {
    collectFreshSymbols(expr.cond, out, seen); collectFreshSymbols(expr.thenExpr, out, seen); collectFreshSymbols(expr.elseExpr, out, seen);
  }
  return out;
}

function resolveSymbol(symbols, key) {
  if (!key) return null;
  return symbols.find((symbol) => symbol === key || symbol.symbolId === String(key) || symbol.name === String(key)) || null;
}

function replaceSymbols(expr, replacements, seen = new Map()) {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.kind === EXPR_KIND.FRESH_SYMBOL) {
    const direct = replacements.get(expr);
    if (direct) return direct;
    const byName = [...replacements.entries()].find(([candidate]) => candidate.name === expr.name && candidate.sort.kind === expr.sort.kind && candidate.sort.width === expr.sort.width);
    return byName?.[1] || expr;
  }
  if (seen.has(expr)) return seen.get(expr);
  const children = {};
  if (expr.kind === EXPR_KIND.UNARY || expr.kind === EXPR_KIND.EXTRACT || expr.kind === EXPR_KIND.CAST) children.arg = replaceSymbols(expr.arg, replacements, seen);
  else if (expr.kind === EXPR_KIND.BINARY || expr.kind === EXPR_KIND.COMPARE || expr.kind === EXPR_KIND.CONCAT) {
    children.left = replaceSymbols(expr.left, replacements, seen);
    children.right = replaceSymbols(expr.right, replacements, seen);
  } else if (expr.kind === EXPR_KIND.CONNECTIVE) children.args = Object.freeze((expr.args || []).map((arg) => replaceSymbols(arg, replacements, seen)));
  else if (expr.kind === EXPR_KIND.ITE) {
    children.cond = replaceSymbols(expr.cond, replacements, seen);
    children.thenExpr = replaceSymbols(expr.thenExpr, replacements, seen);
    children.elseExpr = replaceSymbols(expr.elseExpr, replacements, seen);
  }
  if (Object.keys(children).length === 0) return expr;
  const replaced = Object.freeze({ ...expr, ...children });
  seen.set(expr, replaced);
  return replaced;
}

function correspondAfterSymbols(beforeExpr, afterExpr, correspondence = {}) {
  const beforeSymbols = collectFreshSymbols(beforeExpr);
  const afterSymbols = collectFreshSymbols(afterExpr);
  const replacements = new Map();
  for (const symbol of afterSymbols) if (beforeSymbols.includes(symbol)) replacements.set(symbol, symbol);

  const addPair = (afterKey, beforeKey) => {
    const after = resolveSymbol(afterSymbols, afterKey);
    const before = resolveSymbol(beforeSymbols, beforeKey);
    if (after && before && after.sort.kind === before.sort.kind && after.sort.width === before.sort.width) replacements.set(after, before);
  };
  for (const pair of Array.isArray(correspondence.inputs) ? correspondence.inputs : []) {
    addPair(pair?.after ?? pair?.afterSymbol ?? pair?.afterName, pair?.before ?? pair?.beforeSymbol ?? pair?.beforeName);
  }
  for (const [afterKey, beforeKey] of Object.entries(correspondence.symbols || {})) addPair(afterKey, beforeKey);

  const beforeArgs = correspondence.beforeArgs || {};
  const afterArgs = correspondence.afterArgs || {};
  for (const [index, beforeKey] of Object.entries(beforeArgs)) {
    if (afterArgs[index] !== undefined) addPair(afterArgs[index], beforeKey);
  }

  const unresolved = afterSymbols.filter((symbol) => !replacements.has(symbol));
  if (unresolved.length > 0) {
    return { ok: false, reason: 'missing-input-state-correspondence', symbols: unresolved.map((symbol) => symbol.name) };
  }
  return { ok: true, expression: replaceSymbols(afterExpr, replacements), replacements };
}

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

  const correspondenceResult = correspondAfterSymbols(beforeExpr, afterExpr, correspondence);
  if (!correspondenceResult.ok) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EQUIVALENT,
      reasonCode: correspondenceResult.reason,
      proofStatement: 'Equivalence requires an explicit correspondence for every symbolic input/state value',
      solverStatus: SOLVER_STATUS.UNSUPPORTED,
      assumptions: Object.freeze(combinedAssumptions),
      completeness: createCompleteness({ queryScope: COMPLETENESS_STATUS.PARTIAL }),
      queryHash: null,
      query: null,
      solverResult: null,
      evidence: null,
      unresolvedSymbols: Object.freeze(correspondenceResult.symbols),
    });
  }
  afterExpr = correspondenceResult.expression;
  const symbolReplacements = correspondenceResult.replacements;

  // 2. Translate preconditions P
  let pExpr = null;
  let pAssumptions = [];
  let pUnsupported = [];
  let pUnknowns = 0;
  let pTrans = null;
  if (preconditions) {
    if (Array.isArray(preconditions)) {
      pExpr = preconditions;
    } else if (preconditions.kind && preconditions.sort) {
      pExpr = preconditions;
    } else {
      pTrans = translateSemanticIR(preconditions, { ir: beforeIr, ...options });
      pExpr = pTrans.expression;
      pAssumptions = pTrans.assumptions || [];
      pUnsupported = pTrans.unsupportedEntities || [];
      pUnknowns = pTrans.semanticUnknowns || 0;
    }
  }
  if (Array.isArray(pExpr)) pExpr = pExpr.map((expr) => replaceSymbols(expr, symbolReplacements));
  else if (pExpr) pExpr = replaceSymbols(pExpr, symbolReplacements);

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
  const allUnsupported = [...combinedUnsupported, ...pUnsupported];
  const allUnknowns = combinedUnknowns + pUnknowns;

  const translationResults = [beforeTrans, afterTrans, pTrans].filter(Boolean);
  const mergeCompleteness = (key) => {
    const statuses = translationResults.map((item) => item.completeness?.[key] || COMPLETENESS_STATUS.PARTIAL);
    if (statuses.includes(COMPLETENESS_STATUS.UNSUPPORTED)) return COMPLETENESS_STATUS.UNSUPPORTED;
    if (statuses.includes(COMPLETENESS_STATUS.PARTIAL)) return COMPLETENESS_STATUS.PARTIAL;
    return COMPLETENESS_STATUS.COMPLETE;
  };
  const completeness = createCompleteness({
    translation: allUnknowns > 0 || allUnsupported.length > 0 ? COMPLETENESS_STATUS.UNSUPPORTED : mergeCompleteness('translation'),
    controlFlow: mergeCompleteness('controlFlow'),
    memoryEffects: mergeCompleteness('memoryEffects'),
    pathCoverage: mergeCompleteness('pathCoverage'),
    queryScope: mergeCompleteness('queryScope'),
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
    semanticIrVersion: options.semanticIrVersion,
    translatorVersion: options.translatorVersion,
    architecture: options.architecture,
    bitWidth: options.bitWidth ?? beforeExpr.sort?.width ?? null,
    proofScope: options.proofScope || {
      kind: VERIFICATION_QUERY_KIND.BOUNDED_EQUIVALENCE,
      memoryRegions,
    },
  });

  // 4. Execute solver check
  const solverResult = await activeSession.check(query, options);

  const lifecycle = solverResult?.lifecycle || {};
  if (lifecycle.publishable === false || lifecycle.timedOut || lifecycle.cancelled || lifecycle.stale || lifecycle.disposed) {
    return Object.freeze({
      verdict: VERDICT.UNKNOWN,
      claimKind: CLAIM_KIND.EQUIVALENT,
      reasonCode: lifecycle.timedOut ? 'timeout' : lifecycle.stale ? 'stale-result' : lifecycle.disposed ? 'disposed-session' : 'cancelled',
      proofStatement: 'Solver result was invalidated by timeout, cancellation, disposal, or stale query replacement',
      solverStatus: solverResult.status,
      assumptions: Object.freeze(allAssumptions),
      completeness,
      queryHash: query.queryHash,
      query,
      solverResult,
      evidence: null,
    });
  }

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
      translatorVersion: query.translatorVersion,
      semanticIrVersion: query.semanticIrVersion,
      backendId: activeSession.backend?.id || 'unknown',
      backendVersion: activeSession.backend?.version || '0.0.0',
      proofAuthority: activeSession.backend?.proofAuthority || 'none',
      capabilityFingerprint: activeSession.backend?.capabilityFingerprint?.() || null,
      solverStatus: solverResult.status,
      preconditionStatus: 'satisfiable',
      validationStatus: 'validated',
      assumptions: allAssumptions,
      completeness,
      architecture: query.architecture,
      bitWidth: query.bitWidth,
      proofScope: query.proofScope,
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
      const inconsistent = pCheck.status === SOLVER_STATUS.UNSAT;
      return Object.freeze({
        verdict: VERDICT.UNKNOWN,
        claimKind: CLAIM_KIND.EQUIVALENT,
        reasonCode: inconsistent ? 'inconsistent-preconditions' : (pCheck.reason || 'unresolved-preconditions'),
        proofStatement: inconsistent
          ? 'Equivalence cannot be proved: claim preconditions are contradictory (vacuous proof rejected)'
          : `Equivalence preconditions could not be resolved (${pCheck.status})`,
        solverStatus: solverResult.status,
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
      query,
      translationStatus:
        allUnknowns === 0 && allUnsupported.length === 0
          ? (allAssumptions.length > 0 ? TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS : TRANSLATION_STATUS.EXACT)
          : TRANSLATION_STATUS.UNSUPPORTED,
      scopeCompleteness: completeness,
      semanticUnknowns: allUnknowns,
      unsupportedEntities: allUnsupported,
      assumptionsExplicit: true,
      preconditionsConsistent: pCheck.consistent === true,
      backend: activeSession.backend,
      solverResult,
      validSolverResult: isValidSolverResult(solverResult, { query, backend: activeSession.backend }),
      solverResultStatus: solverResult.status,
      cancelled: activeSession.isCancelled(),
      timedOut: lifecycle.timedOut === true,
      stale: lifecycle.stale === true,
      disposed: lifecycle.disposed === true,
      budgetExceeded: options.budgetExceeded ?? false,
      budgetFailure: lifecycle.budgetExceeded === true,
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
      semanticIrVersion: query.semanticIrVersion,
      backendId: activeSession.backend?.id || 'unknown',
      backendVersion: activeSession.backend?.version || '0.0.0',
      proofAuthority: activeSession.backend?.proofAuthority || 'none',
      capabilityFingerprint: activeSession.backend?.capabilityFingerprint?.() || null,
      solverStatus: solverResult.status,
      preconditionStatus: 'satisfiable',
      validationStatus: 'validated',
      assumptions: allAssumptions,
      completeness,
      architecture: query.architecture,
      bitWidth: query.bitWidth,
      proofScope: query.proofScope,
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
