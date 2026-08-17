import { SCOPE_ORDER } from '../../control/scope.js';

export const ANALYSIS_SCOPE_NONE = 'none';
export const ANALYSIS_SCOPE_INITIALS = Object.freeze([ANALYSIS_SCOPE_NONE, ...SCOPE_ORDER]);
export const ANALYSIS_SCOPE_EXPANSION_POLICY = Object.freeze({
  LOCKED: 'locked',
  AUTO: 'auto',
  AGENT: 'agent',
});
export const ANALYSIS_SCOPE_EXPANSION_POLICIES = Object.freeze(Object.values(ANALYSIS_SCOPE_EXPANSION_POLICY));

export function createAnalysisScopeRequest({ initial, expansionPolicy } = {}) {
  const normalizedInitial = String(initial || '').toLowerCase();
  const normalizedPolicy = String(expansionPolicy || '').toLowerCase();
  if (!ANALYSIS_SCOPE_INITIALS.includes(normalizedInitial)) {
    throw new TypeError(`Unsupported analysis scope: ${initial}`);
  }
  if (!ANALYSIS_SCOPE_EXPANSION_POLICIES.includes(normalizedPolicy)) {
    throw new TypeError(`Unsupported analysis scope expansion policy: ${expansionPolicy}`);
  }
  return Object.freeze({ initial: normalizedInitial, expansionPolicy: normalizedPolicy });
}

export function createDevAnalysisScopeRequest(initial = ANALYSIS_SCOPE_NONE) {
  return createAnalysisScopeRequest({
    initial,
    expansionPolicy: ANALYSIS_SCOPE_EXPANSION_POLICY.AGENT,
  });
}

export function isDevOnlyAnalysisScope(request) {
  return request?.initial === ANALYSIS_SCOPE_NONE;
}

/**
 * Compatibility boundary for the existing Standard ScopeController.
 * `null` means there is deliberately no Hex analysis context to attach yet.
 * Standard Agent keeps using its existing scope vocabulary and controller.
 */
export function toLegacyAnalysisScope(request) {
  const normalized = createAnalysisScopeRequest(request);
  if (normalized.initial === ANALYSIS_SCOPE_NONE) return null;
  if (normalized.expansionPolicy === ANALYSIS_SCOPE_EXPANSION_POLICY.AUTO) return 'auto';
  return normalized.initial;
}
