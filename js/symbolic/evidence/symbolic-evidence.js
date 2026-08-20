/**
 * js/symbolic/evidence/symbolic-evidence.js
 *
 * Deterministic SymbolicEvidence schema builder and validator.
 * Binds queryKind, claimKind, proofStatement, targetEntities, exact versioned hashes,
 * backend info, assumptions, completeness, and validation state into an immutable record.
 * Fails closed on invalid shapes, inconsistent preconditions, or solver failures.
 */

import { createHash } from 'node:crypto';
import { SOLVER_STATUS, isSolverFailure } from '../solver/result.js';
import { EXPR_SCHEMA_VERSION } from '../expr/serialize.js';
import { COMPLETENESS_STATUS, createCompleteness } from '../translate/support-matrix.js';

export const EVIDENCE_SCHEMA_VERSION = '1.0.0';

export const EVIDENCE_VERDICT = Object.freeze({
  PROVED: 'proved',
  REFUTED: 'refuted',
  UNKNOWN: 'unknown',
});

export const CLAIM_KIND = Object.freeze({
  EDGE_FEASIBILITY: 'edge-feasibility',
  GLOBAL_EDGE_REACHABILITY: 'global-edge-reachability',
  BOUNDED_EQUIVALENCE: 'bounded-equivalence',
  PATCH_INVARIANT: 'patch-invariant',
  SYMBOLIC_QUERY: 'symbolic-query',
});

export const PRECONDITION_STATUS = Object.freeze({
  SATISFIABLE: 'satisfiable',
  INCONSISTENT: 'inconsistent',
  UNKNOWN: 'unknown',
  NONE: 'none',
});

export const VALIDATION_STATUS = Object.freeze({
  VALIDATED: 'validated',
  REJECTED: 'rejected',
  UNVALIDATED: 'unvalidated',
  NOT_APPLICABLE: 'not-applicable',
  FAILED: 'failed',
});

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function canonicalize(val) {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'bigint') return `0x${val.toString(16)}`;
    return val;
  }
  if (val instanceof Map) {
    const entries = [...val.entries()].sort(([k1], [k2]) => String(k1).localeCompare(String(k2)));
    const out = {};
    for (const [k, v] of entries) {
      out[String(k)] = canonicalize(v);
    }
    return out;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const sorted = {};
  for (const k of Object.keys(val).sort()) {
    sorted[k] = canonicalize(val[k]);
  }
  return sorted;
}

export function computeEvidenceId({
  schemaVersion = EVIDENCE_SCHEMA_VERSION,
  queryKind,
  claimKind,
  queryHash,
  backendId,
  backendVersion,
  solverStatus,
  verdict,
  targetEntities = [],
}) {
  const canonicalPayload = canonicalize({
    schemaVersion,
    queryKind: String(queryKind),
    claimKind: String(claimKind),
    queryHash: String(queryHash),
    backendId: String(backendId),
    backendVersion: String(backendVersion),
    solverStatus: String(solverStatus),
    verdict: String(verdict),
    targetEntities: Array.isArray(targetEntities) ? targetEntities.map(String).sort() : [],
  });
  const digest = sha256Hex(JSON.stringify(canonicalPayload));
  return `ev_${digest.slice(0, 32)}`;
}

export function createSymbolicEvidence({
  queryKind,
  claimKind,
  proofStatement,
  targetEntities,
  queryHash,
  exprSchemaVersion = EXPR_SCHEMA_VERSION,
  translatorVersion = '1.0.0',
  backendId,
  backendVersion = '0.0.0',
  solverStatus,
  preconditionStatus = PRECONDITION_STATUS.NONE,
  validationStatus = VALIDATION_STATUS.NOT_APPLICABLE,
  assumptions = [],
  completeness = null,
  origins = {},
  verdict,
  witnessModel = null,
  limits = null,
  metadata = null,
}) {
  // Required string validations
  if (!queryKind || typeof queryKind !== 'string' || queryKind.trim() === '') {
    throw new TypeError('createSymbolicEvidence: queryKind must be a non-empty string');
  }
  if (!claimKind || typeof claimKind !== 'string' || claimKind.trim() === '') {
    throw new TypeError('createSymbolicEvidence: claimKind must be a non-empty string');
  }
  if (!proofStatement || typeof proofStatement !== 'string' || proofStatement.trim() === '') {
    throw new TypeError('createSymbolicEvidence: proofStatement must be a non-empty string');
  }
  if (!targetEntities || !Array.isArray(targetEntities)) {
    throw new TypeError('createSymbolicEvidence: targetEntities must be an array');
  }
  if (!queryHash || typeof queryHash !== 'string' || queryHash.trim() === '') {
    throw new TypeError('createSymbolicEvidence: queryHash must be a non-empty string');
  }
  if (!exprSchemaVersion || typeof exprSchemaVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: exprSchemaVersion must be a string');
  }
  if (!translatorVersion || typeof translatorVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: translatorVersion must be a string');
  }
  if (!backendId || typeof backendId !== 'string' || backendId.trim() === '') {
    throw new TypeError('createSymbolicEvidence: backendId must be a non-empty string');
  }
  if (!backendVersion || typeof backendVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: backendVersion must be a string');
  }

  // Validate solver status
  if (!solverStatus || !Object.values(SOLVER_STATUS).includes(solverStatus)) {
    throw new TypeError(`createSymbolicEvidence: invalid solverStatus '${solverStatus}'`);
  }

  // Validate verdict
  if (!verdict || !Object.values(EVIDENCE_VERDICT).includes(verdict)) {
    throw new TypeError(`createSymbolicEvidence: invalid verdict '${verdict}'`);
  }

  // Validate precondition status if specified
  const normPreconditionStatus = preconditionStatus ? String(preconditionStatus) : PRECONDITION_STATUS.NONE;
  if (!Object.values(PRECONDITION_STATUS).includes(normPreconditionStatus)) {
    throw new TypeError(`createSymbolicEvidence: invalid preconditionStatus '${preconditionStatus}'`);
  }

  // Validate validation status if specified
  const normValidationStatus = validationStatus ? String(validationStatus) : VALIDATION_STATUS.NOT_APPLICABLE;
  if (!Object.values(VALIDATION_STATUS).includes(normValidationStatus)) {
    throw new TypeError(`createSymbolicEvidence: invalid validationStatus '${validationStatus}'`);
  }

  // Invariant 1: Inconsistent preconditions cannot mint confirmed proved evidence (prevent vacuous truth)
  if (verdict === EVIDENCE_VERDICT.PROVED && normPreconditionStatus === PRECONDITION_STATUS.INCONSISTENT) {
    throw new Error('createSymbolicEvidence: cannot mint proved evidence when preconditions are inconsistent');
  }

  // Invariant 2: Solver failures cannot mint proved evidence
  if (verdict === EVIDENCE_VERDICT.PROVED && isSolverFailure({ status: solverStatus })) {
    throw new Error(`createSymbolicEvidence: cannot mint proved evidence with solver failure status '${solverStatus}'`);
  }

  // Invariant 3: Unsupported translation completeness cannot mint proved evidence
  const normCompleteness = completeness
    ? createCompleteness(completeness)
    : createCompleteness();

  if (
    verdict === EVIDENCE_VERDICT.PROVED &&
    (normCompleteness.translation === COMPLETENESS_STATUS.UNSUPPORTED || normCompleteness.translation === 'unsupported')
  ) {
    throw new Error('createSymbolicEvidence: cannot mint proved evidence with unsupported translation completeness');
  }

  // Invariant 4: Refuted verdict with rejected witness model is invalid
  if (verdict === EVIDENCE_VERDICT.REFUTED && normValidationStatus === VALIDATION_STATUS.REJECTED) {
    throw new Error('createSymbolicEvidence: cannot mint refuted evidence when witness model validation was rejected');
  }

  // Normalize targetEntities
  const normalizedTargets = targetEntities.map((t) => (typeof t === 'string' ? t : JSON.stringify(canonicalize(t))));

  // Normalize assumptions
  const normalizedAssumptions = Array.isArray(assumptions)
    ? assumptions.map((a) => (typeof a === 'object' && a !== null ? { ...a } : a))
    : [];

  // Normalize witnessModel
  let normalizedWitness = null;
  if (witnessModel) {
    if (witnessModel instanceof Map) {
      normalizedWitness = {};
      for (const [k, v] of witnessModel.entries()) {
        normalizedWitness[String(k)] = typeof v === 'bigint' ? `0x${v.toString(16)}` : v;
      }
    } else if (typeof witnessModel === 'object') {
      normalizedWitness = canonicalize(witnessModel);
    }
  }

  // Normalize origins
  let normalizedOrigins = origins;
  if (origins instanceof Map) {
    normalizedOrigins = {};
    for (const [k, v] of origins.entries()) {
      normalizedOrigins[String(k)] = Array.isArray(v) || v instanceof Set ? [...v].map(String).sort() : canonicalize(v);
    }
  } else if (typeof origins === 'object' && origins !== null) {
    normalizedOrigins = canonicalize(origins);
  }

  const id = computeEvidenceId({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    queryKind,
    claimKind,
    queryHash,
    backendId,
    backendVersion,
    solverStatus,
    verdict,
    targetEntities: normalizedTargets,
  });

  const record = {
    id,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    queryKind: String(queryKind),
    claimKind: String(claimKind),
    proofStatement: String(proofStatement),
    targetEntities: normalizedTargets,
    queryHash: String(queryHash),
    exprSchemaVersion: String(exprSchemaVersion),
    translatorVersion: String(translatorVersion),
    backendId: String(backendId),
    backendVersion: String(backendVersion),
    solverStatus,
    preconditionStatus: normPreconditionStatus,
    validationStatus: normValidationStatus,
    assumptions: normalizedAssumptions,
    completeness: normCompleteness,
    origins: normalizedOrigins,
    verdict,
    witnessModel: normalizedWitness,
    limits: limits ? canonicalize(limits) : null,
    metadata: metadata ? canonicalize(metadata) : null,
  };

  return deepFreeze(record);
}

export function isProvedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  return (
    evidence.verdict === EVIDENCE_VERDICT.PROVED &&
    evidence.preconditionStatus !== PRECONDITION_STATUS.INCONSISTENT &&
    !isSolverFailure({ status: evidence.solverStatus })
  );
}

export function isRefutedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  return (
    evidence.verdict === EVIDENCE_VERDICT.REFUTED &&
    evidence.validationStatus !== VALIDATION_STATUS.REJECTED &&
    !isSolverFailure({ status: evidence.solverStatus })
  );
}
