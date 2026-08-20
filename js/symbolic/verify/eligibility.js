/**
 * js/symbolic/verify/eligibility.js
 *
 * Fail-closed proof eligibility gate for Hex Solver-backed Verification.
 * Prevents UNSAT alone, partial translations, unhandled semantics,
 * contradictory preconditions, or unbudgeted runs from minting a proved verdict.
 */

import { TRANSLATION_STATUS, COMPLETENESS_STATUS } from '../translate/support-matrix.js';
import { SOLVER_STATUS } from '../solver/result.js';

export function checkProofEligibility({
  queryValid = false,
  translationStatus = null,
  scopeCompleteness = null,
  semanticUnknowns = 0,
  unsupportedEntities = [],
  assumptionsExplicit = false,
  preconditionsConsistent = false,
  backendCapabilityExact = false,
  solverResultStatus = null,
  cancelled = false,
  budgetExceeded = false,
} = {}) {
  const reasons = [];

  // 1. Query validity
  if (queryValid !== true) {
    reasons.push('invalid-query');
  }

  // 2. Translation completeness
  if (
    translationStatus !== TRANSLATION_STATUS.EXACT &&
    translationStatus !== TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS
  ) {
    reasons.push(`incomplete-translation:${translationStatus || 'unspecified'}`);
  }

  // If translation has assumptions, they must be explicitly declared and tracked
  if (translationStatus === TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS && assumptionsExplicit !== true) {
    reasons.push('implicit-assumptions');
  }

  // 3. Scope completeness across modeled dimensions
  if (scopeCompleteness === false) {
    reasons.push('incomplete-scope');
  } else if (scopeCompleteness && typeof scopeCompleteness === 'object') {
    if (scopeCompleteness.translation && scopeCompleteness.translation !== COMPLETENESS_STATUS.COMPLETE) {
      reasons.push(`incomplete-scope-translation:${scopeCompleteness.translation}`);
    }
    if (scopeCompleteness.controlFlow && scopeCompleteness.controlFlow !== COMPLETENESS_STATUS.COMPLETE) {
      reasons.push(`incomplete-scope-control-flow:${scopeCompleteness.controlFlow}`);
    }
    if (scopeCompleteness.memoryEffects && scopeCompleteness.memoryEffects !== COMPLETENESS_STATUS.COMPLETE) {
      reasons.push(`incomplete-scope-memory-effects:${scopeCompleteness.memoryEffects}`);
    }
    if (scopeCompleteness.pathCoverage && scopeCompleteness.pathCoverage !== COMPLETENESS_STATUS.COMPLETE) {
      reasons.push(`incomplete-scope-path-coverage:${scopeCompleteness.pathCoverage}`);
    }
    if (scopeCompleteness.queryScope && scopeCompleteness.queryScope !== COMPLETENESS_STATUS.COMPLETE) {
      reasons.push(`incomplete-scope-query-scope:${scopeCompleteness.queryScope}`);
    }
  }

  // 4. Semantic unknowns
  if (Number(semanticUnknowns) > 0) {
    reasons.push(`semantic-unknowns-present:${semanticUnknowns}`);
  }

  // 5. Unsupported entities
  if (Array.isArray(unsupportedEntities) && unsupportedEntities.length > 0) {
    reasons.push(`unsupported-entities-present:${unsupportedEntities.length}`);
  }

  // 6. Explicit assumptions
  if (assumptionsExplicit !== true) {
    reasons.push('assumptions-not-explicit');
  }

  // 7. Precondition consistency (vacuous proof guard)
  if (preconditionsConsistent !== true) {
    reasons.push('preconditions-not-consistent');
  }

  // 8. Exact backend capability
  if (backendCapabilityExact !== true) {
    reasons.push('backend-capability-mismatch');
  }

  // 9. Solver result status (must be exact UNSAT for proof)
  if (solverResultStatus !== SOLVER_STATUS.UNSAT) {
    reasons.push(`solver-status-not-unsat:${solverResultStatus || 'unspecified'}`);
  }

  // 10. Cancellation
  if (cancelled === true) {
    reasons.push('session-cancelled');
  }

  // 11. Resource / budget limits
  if (budgetExceeded === true) {
    reasons.push('budget-exceeded');
  }

  const eligible = reasons.length === 0;

  return Object.freeze({
    eligible,
    reasons: Object.freeze(reasons),
  });
}
