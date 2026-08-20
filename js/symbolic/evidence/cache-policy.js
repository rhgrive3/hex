/**
 * js/symbolic/evidence/cache-policy.js
 *
 * Verifier fingerprinting and version-safe cache policy for Phase 9 symbolic proofs.
 * Binds queryKind, exprSchemaVersion, exprDagVersion, translatorVersion, backendId,
 * backendVersion, and solverOptions into a deterministic SHA-256 fingerprint.
 * Enforces fail-closed proof cacheability (only clean PROVED/REFUTED results with complete translation).
 * Provides proof tool cache options for ToolRegistry / ObservationStore.
 */

import { stableDigest } from '../../core/identity/index.js';
import { SOLVER_STATUS } from '../solver/result.js';
import { EXPR_SCHEMA_VERSION, EXPR_DAG_VERSION } from '../expr/serialize.js';
import { COMPLETENESS_STATUS } from '../translate/support-matrix.js';

export const VERIFIER_FINGERPRINT_SCHEMA_VERSION = '1.0.0';

function sha256Hex(data) {
  return stableDigest(data);
}

function canonicalizeValue(val) {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'bigint') return `0x${val.toString(16)}`;
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const sorted = {};
  for (const k of Object.keys(val).sort()) {
    sorted[k] = canonicalizeValue(val[k]);
  }
  return sorted;
}

export function computeVerifierFingerprint({
  queryKind,
  exprSchemaVersion = EXPR_SCHEMA_VERSION,
  exprDagVersion = EXPR_DAG_VERSION,
  translatorVersion = '1.0.0',
  backendId,
  backendVersion = '0.0.0',
  solverOptions = null,
} = {}) {
  if (!queryKind || typeof queryKind !== 'string' || queryKind.trim() === '') {
    throw new TypeError('computeVerifierFingerprint: queryKind is required and must be a non-empty string');
  }
  if (!backendId || typeof backendId !== 'string' || backendId.trim() === '') {
    throw new TypeError('computeVerifierFingerprint: backendId is required and must be a non-empty string');
  }
  if (!exprSchemaVersion || typeof exprSchemaVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: exprSchemaVersion is required and must be a string');
  }
  if (!exprDagVersion || typeof exprDagVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: exprDagVersion is required and must be a string');
  }
  if (!translatorVersion || typeof translatorVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: translatorVersion is required and must be a string');
  }
  if (!backendVersion || typeof backendVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: backendVersion is required and must be a string');
  }

  const payload = {
    backendId: String(backendId),
    backendVersion: String(backendVersion),
    exprDagVersion: String(exprDagVersion),
    exprSchemaVersion: String(exprSchemaVersion),
    queryKind: String(queryKind),
    solverOptions: solverOptions ? canonicalizeValue(solverOptions) : null,
    translatorVersion: String(translatorVersion),
  };

  const canonicalJson = JSON.stringify(canonicalizeValue(payload));
  return sha256Hex(canonicalJson);
}

export function isCacheableProof({
  verdict,
  solverStatus,
  completeness = null,
  hasUnresolvedUnknowns = false,
  preconditionStatus = null,
  validationStatus = null,
} = {}) {
  // 1. Only clean PROVED or REFUTED verdicts may be cached
  if (verdict !== 'proved' && verdict !== 'refuted') {
    return false;
  }

  // 2. Check solver status: must be clean SAT or UNSAT, not failure/timeout/cancelled/etc.
  if (
    !solverStatus ||
    solverStatus === SOLVER_STATUS.TIMEOUT ||
    solverStatus === SOLVER_STATUS.RESOURCE_LIMIT ||
    solverStatus === SOLVER_STATUS.UNSUPPORTED ||
    solverStatus === SOLVER_STATUS.CANCELLED ||
    solverStatus === SOLVER_STATUS.PROVIDER_FAILURE ||
    solverStatus === SOLVER_STATUS.INVALID_QUERY ||
    solverStatus === SOLVER_STATUS.UNKNOWN
  ) {
    return false;
  }

  // 3. Unresolved unknowns cannot produce cacheable proofs
  if (hasUnresolvedUnknowns === true) {
    return false;
  }

  // 4. Incomplete or unsupported translation cannot be cached as proved/refuted
  if (completeness) {
    if (
      completeness.translation === COMPLETENESS_STATUS.UNSUPPORTED ||
      completeness.translation === 'unsupported' ||
      completeness.translation === COMPLETENESS_STATUS.PARTIAL ||
      completeness.translation === 'partial'
    ) {
      return false;
    }
  }

  // 5. Inconsistent or unknown preconditions cannot produce cacheable proofs
  if (preconditionStatus === 'inconsistent' || preconditionStatus === 'unknown') {
    return false;
  }

  // 6. Rejected counterexamples cannot be cached as refuted proofs
  if (validationStatus === 'rejected' || validationStatus === 'failed') {
    return false;
  }

  return true;
}

export function getProofToolCacheOptions(options = {}) {
  const verifierFingerprint = options?.verifierFingerprint ? String(options.verifierFingerprint) : null;
  return Object.freeze({
    storeResult: true,
    deterministic: false,
    verifierFingerprint,
  });
}

export function computeProofCacheKey({
  baseKey = 'proof',
  queryHash,
  verifierFingerprint,
  binaryIdentity = null,
  analysisRevision = null,
} = {}) {
  if (!queryHash || typeof queryHash !== 'string') {
    throw new TypeError('computeProofCacheKey: queryHash is required and must be a string');
  }
  if (!verifierFingerprint || typeof verifierFingerprint !== 'string') {
    throw new TypeError('computeProofCacheKey: verifierFingerprint is required and must be a string');
  }

  const parts = [
    String(baseKey),
    binaryIdentity ? String(binaryIdentity) : 'binary:unknown',
    analysisRevision ? String(analysisRevision) : 'analysis:0',
    String(verifierFingerprint),
    String(queryHash),
  ];
  return parts.join('::');
}
