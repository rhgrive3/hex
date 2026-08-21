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

export const QUERY_SCHEMA_VERSION = '1.1.0';
export const SEMANTIC_IR_VERSION = '2.0.0';
export const TRANSLATOR_VERSION = '1.1.0';

export const CLAIM_KIND = Object.freeze({
  EDGE_INFEASIBLE: 'edge_infeasible',
  GLOBAL_EDGE_UNREACHABLE: 'global_edge_unreachable',
  EDGE_FEASIBLE: 'edge_feasible',
  EQUIVALENT: 'equivalent',
  DIFFERENT: 'different',
});

export const VERDICT = Object.freeze({
  PROVED: 'proved',
  REFUTED: 'refuted',
  UNKNOWN: 'unknown',
});

function freezeDeep(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

export function isVerificationQuery(query) {
  return (
    !!query &&
    typeof query === 'object' &&
    typeof query.kind === 'string' &&
    typeof query.claimKind === 'string' &&
    Array.isArray(query.constraints) &&
    query.schemaVersion === QUERY_SCHEMA_VERSION &&
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
  semanticIrVersion = SEMANTIC_IR_VERSION,
  translatorVersion = TRANSLATOR_VERSION,
  architecture = 'generic',
  bitWidth = null,
  proofScope = null,
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
  freezeDeep(targetEntity);
  freezeDeep(normalizedConstraints);
  freezeDeep(assertion);
  freezeDeep(normalizedAssumptions);
  freezeDeep(normalizedOutputs);
  freezeDeep(normalizedCompleteness);
  freezeDeep(proofScope);

  const hashPayload = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind,
    claimKind,
    targetEntity: targetEntity && typeof targetEntity === 'object' ? targetEntity : String(targetEntity || ''),
    constraints: normalizedConstraints.map((c) => ({ hash: computeStructuralHash(c), expression: c })),
    assertion: assertion ? { hash: computeStructuralHash(assertion), expression: assertion } : null,
    assumptions: normalizedAssumptions,
    completeness: normalizedCompleteness,
    requestedOutputs: normalizedOutputs,
    semanticIrVersion: String(semanticIrVersion),
    translatorVersion: String(translatorVersion),
    architecture: String(architecture),
    bitWidth: bitWidth == null ? null : Number(bitWidth),
    proofScope: proofScope || null,
  };

  const queryHash = stableDigest(hashPayload);

  return Object.freeze({
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind,
    claimKind,
    targetEntity: targetEntity && typeof targetEntity === 'object' ? Object.freeze({ ...targetEntity }) : targetEntity,
    constraints: Object.freeze(normalizedConstraints),
    assertion: assertion || null,
    assumptions: Object.freeze(normalizedAssumptions),
    completeness: normalizedCompleteness,
    requestedOutputs: Object.freeze(normalizedOutputs),
    semanticIrVersion: String(semanticIrVersion),
    translatorVersion: String(translatorVersion),
    architecture: String(architecture),
    bitWidth: bitWidth == null ? null : Number(bitWidth),
    proofScope: proofScope || null,
    queryHash,
  });
}
