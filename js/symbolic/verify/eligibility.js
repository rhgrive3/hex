/**
 * js/symbolic/verify/eligibility.js
 *
 * Fail-closed proof eligibility gate for Hex Solver-backed Verification.
 * Prevents UNSAT alone, partial translations, unhandled semantics,
 * contradictory preconditions, or unbudgeted runs from minting a proved verdict.
 */

import { TRANSLATION_STATUS, COMPLETENESS_STATUS } from '../translate/support-matrix.js';
import { isExactProofBackend } from '../solver/backend.js';
import { isValidSolverResult, SOLVER_STATUS } from '../solver/result.js';
import { isVerificationQuery } from './query.js';

const COMPLETENESS_KEYS = Object.freeze([
  'translation',
  'controlFlow',
  'memoryEffects',
  'pathCoverage',
  'queryScope',
]);

export function checkProofEligibility({
  queryValid = false,
  translationStatus = null,
  scopeCompleteness = null,
  semanticUnknowns = 0,
  unsupportedEntities = [],
  assumptionsExplicit = false,
  preconditionsConsistent = false,
  backend = null,
  query = null,
  solverResult = null,
  validSolverResult = false,
  solverResultStatus = null,
  cancelled = false,
  timedOut = false,
  stale = false,
  disposed = false,
  budgetExceeded = false,
  budgetFailure = false,
} = {}) {
  const reasons = [];

  // 1. Query validity
  if (queryValid !== true || !isVerificationQuery(query)) {
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
  if (scopeCompleteness === false || !scopeCompleteness || typeof scopeCompleteness !== 'object') {
    reasons.push('incomplete-scope');
  } else {
    for (const key of COMPLETENESS_KEYS) {
      if (scopeCompleteness[key] !== COMPLETENESS_STATUS.COMPLETE) {
        reasons.push(`incomplete-scope-${key}:${scopeCompleteness[key] || 'missing'}`);
      }
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

  // 8. Explicit proof authority and immutable backend identity. Local/WASM/
  // non-remote flags are intentionally not consulted here.
  if (!isExactProofBackend(backend)) {
    reasons.push(`backend-proof-authority:${backend?.proofAuthority || 'missing'}`);
  } else {
    const capabilities = backend.capabilities();
    if (!capabilities?.capabilityFingerprint || capabilities.capabilityFingerprint !== backend.capabilityFingerprint()) {
      reasons.push('backend-capability-fingerprint-mismatch');
    }
  }

  // 9. Solver result status (must be exact UNSAT for proof)
  if (solverResultStatus !== SOLVER_STATUS.UNSAT) {
    reasons.push(`solver-status-not-unsat:${solverResultStatus || 'unspecified'}`);
  }

  if (!validSolverResult || !isValidSolverResult(solverResult, { query, backend })) {
    reasons.push('invalid-solver-result');
  }

  // 10. Cancellation
  if (cancelled === true) {
    reasons.push('session-cancelled');
  }

  if (timedOut === true) reasons.push('session-timed-out');
  if (stale === true) reasons.push('stale-result');
  if (disposed === true) reasons.push('session-disposed');

  // 11. Resource / budget limits
  if (budgetExceeded === true || budgetFailure === true) {
    reasons.push('budget-exceeded');
  }

  const eligible = reasons.length === 0;

  return Object.freeze({
    eligible,
    reasons: Object.freeze(reasons),
  });
}
