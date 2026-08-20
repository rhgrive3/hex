/**
 * js/symbolic/verify/query.js
 *
 * Verification query schema, taxonomy, and factory for Hex Solver-backed Verification.
 * Provides deterministic hashing, explicit polarity, and structured targets.
 */

import { stableDigest } from '../../core/identity/index.js';
import { computeStructuralHash } from '../expr/hash.js';
import { createCompleteness } from '../translate/support-matrix.js';

export const VERIFICATION_QUERY_KIND = Object.freeze({
  CONDITIONAL_EDGE_FEASIBILITY: 'conditional_edge_feasibility',
  BOUNDED_EQUIVALENCE: 'bounded_equivalence',
  GLOBAL_EDGE_REACHABILITY: 'global_edge_reachability',
});

export const CLAIM_KIND = Object.freeze({
  EDGE_INFEASIBLE: 'edge_infeasible',
  EDGE_FEASIBLE: 'edge_feasible',
  EQUIVALENT: 'equivalent',
  DIFFERENT: 'different',
});

export const VERDICT = Object.freeze({
  PROVED: 'proved',
  REFUTED: 'refuted',
  UNKNOWN: 'unknown',
});

export function isVerificationQuery(query) {
  return (
    !!query &&
    typeof query === 'object' &&
    typeof query.kind === 'string' &&
    typeof query.claimKind === 'string' &&
    Array.isArray(query.constraints) &&
    typeof query.queryHash === 'string'
  );
}

export function createVerificationQuery({
  kind,
  claimKind,
  targetEntity = null,
  constraints = [],
  assertion = null,
  assumptions = [],
  completeness = null,
  requestedOutputs = [],
}) {
  if (!Object.values(VERIFICATION_QUERY_KIND).includes(kind)) {
    throw new TypeError(`createVerificationQuery: invalid query kind '${kind}'`);
  }
  if (!Object.values(CLAIM_KIND).includes(claimKind)) {
    throw new TypeError(`createVerificationQuery: invalid claim kind '${claimKind}'`);
  }

  let normalizedConstraints = [];
  if (Array.isArray(constraints)) {
    normalizedConstraints = [...constraints].filter(Boolean);
  } else if (constraints) {
    normalizedConstraints = [constraints];
  }

  const normalizedAssumptions = Array.isArray(assumptions) ? [...assumptions] : [];
  const normalizedOutputs = Array.isArray(requestedOutputs) ? [...requestedOutputs] : [];
  const normalizedCompleteness = completeness || createCompleteness();

  const hashPayload = JSON.stringify({
    kind,
    claimKind,
    targetEntity: targetEntity && typeof targetEntity === 'object' ? targetEntity : String(targetEntity || ''),
    constraints: normalizedConstraints.map((c) => computeStructuralHash(c)),
    assertion: assertion ? computeStructuralHash(assertion) : null,
    assumptions: normalizedAssumptions.map((a) => a.id || a.statement || String(a)),
    requestedOutputs: normalizedOutputs,
  });

  const queryHash = stableDigest(hashPayload);

  return Object.freeze({
    kind,
    claimKind,
    targetEntity: targetEntity && typeof targetEntity === 'object' ? Object.freeze({ ...targetEntity }) : targetEntity,
    constraints: Object.freeze(normalizedConstraints),
    assertion: assertion || null,
    assumptions: Object.freeze(normalizedAssumptions),
    completeness: normalizedCompleteness,
    requestedOutputs: Object.freeze(normalizedOutputs),
    queryHash,
  });
}
