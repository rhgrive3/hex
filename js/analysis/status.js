/**
 * Common Phase 7 analysis status envelope.
 *
 * Phase 7 adds several independent analyses (alias, points-to, summaries,
 * escape, types, debug ingestion, function discovery). Each of them can stop
 * early for a different reason, and each of them is consumed by code that must
 * be able to tell "no relationship exists" apart from "we ran out of budget
 * before we could look".
 *
 * P7-INV-002 is the reason this file exists at all: relation strength and
 * analysis completeness are independent dimensions. A budget-limited run may
 * only ever return a weaker relation; it must never convert incompleteness into
 * a stronger one. Keeping completeness in one shared envelope stops every
 * subsystem from inventing its own subtly different `partial` flag.
 */

import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const ANALYSIS_STATUS_SCHEMA_VERSION = 1;
export const ANALYSIS_STATUS_CONTRACT_VERSION = '1.0.0';

/**
 * Ordered weakest-last. `complete` is the only value that may satisfy a
 * consumer which requires a total answer.
 */
export const ANALYSIS_COMPLETENESS = Object.freeze([
  'complete',
  'bounded',
  'partial',
  'truncated',
  'unsupported',
]);

export const ANALYSIS_STOP_REASONS = Object.freeze([
  'cancelled',
  'timeout',
  'budget-exhausted',
  'memory-limit',
  'iteration-limit',
  'widened',
  'unsupported-input',
  'dependency-missing',
  'dependency-mismatch',
  'evidence-missing',
]);

/**
 * Stop reasons that describe an aborted run rather than a deliberately bounded
 * one. A result carrying any of these can never be published as `complete`
 * (P7-INV-010).
 */
export const FAIL_CLOSED_STOP_REASONS = Object.freeze([
  'cancelled',
  'timeout',
  'budget-exhausted',
  'memory-limit',
  'dependency-missing',
  'dependency-mismatch',
]);

export const ANALYSIS_BUDGET_CLASSES = Object.freeze(['interactive', 'expanded', 'background', 'exhaustive']);

const COMPLETENESS_SET = new Set(ANALYSIS_COMPLETENESS);
const STOP_REASON_SET = new Set(ANALYSIS_STOP_REASONS);
const FAIL_CLOSED_SET = new Set(FAIL_CLOSED_STOP_REASONS);
const BUDGET_CLASS_SET = new Set(ANALYSIS_BUDGET_CLASSES);
const COMPLETENESS_RANK = new Map(ANALYSIS_COMPLETENESS.map((value, index) => [value, index]));

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function stringList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return [...new Set(values.map((value) => nonEmpty(value, code)))].sort();
}

/**
 * Builds the one status envelope every Phase 7 result carries.
 *
 * The validation here is the enforcement point for P7-INV-010: a caller cannot
 * hand back `complete` while also admitting that it was cancelled or ran out of
 * budget, and a caller cannot claim `unsupported` without saying why.
 */
export function createAnalysisStatus(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('analysis-status-invalid');
  const completeness = nonEmpty(input.completeness, 'analysis-status-completeness-required');
  if (!COMPLETENESS_SET.has(completeness)) fail('analysis-status-invalid-completeness');
  const stopReason = input.stopReason == null ? null : nonEmpty(input.stopReason, 'analysis-status-invalid-stop-reason');
  if (stopReason != null && !STOP_REASON_SET.has(stopReason)) fail('analysis-status-invalid-stop-reason');
  if (completeness === 'complete' && stopReason != null) fail('analysis-status-complete-cannot-stop-early');
  if (completeness !== 'complete' && stopReason == null) fail('analysis-status-incomplete-requires-stop-reason');
  if (stopReason != null && FAIL_CLOSED_SET.has(stopReason) && completeness === 'bounded') {
    // `bounded` means "we deliberately looked only this far and the answer is
    // sound within that bound". An aborted run has no such guarantee.
    fail('analysis-status-aborted-cannot-be-bounded');
  }
  const budgetClass = input.budgetClass == null ? null : nonEmpty(input.budgetClass, 'analysis-status-invalid-budget-class');
  if (budgetClass != null && !BUDGET_CLASS_SET.has(budgetClass)) fail('analysis-status-invalid-budget-class');

  const status = {
    schemaVersion: ANALYSIS_STATUS_SCHEMA_VERSION,
    snapshotId: nonEmpty(input.snapshotId, 'analysis-status-snapshot-required'),
    analyzerId: nonEmpty(input.analyzerId, 'analysis-status-analyzer-required'),
    analyzerVersion: nonEmpty(input.analyzerVersion, 'analysis-status-analyzer-version-required'),
    completeness,
    budgetClass,
    stopReason,
    evidenceIds: stringList(input.evidenceIds, 'analysis-status-invalid-evidence-ids'),
    dependencyIds: stringList(input.dependencyIds, 'analysis-status-invalid-dependency-ids'),
  };
  return deepFreeze(status);
}

export function isCompleteStatus(status) {
  return !!status && status.completeness === 'complete' && status.stopReason == null;
}

/** True when the run stopped for a reason that forbids publishing at all. */
export function isFailClosedStatus(status) {
  return !!status && status.stopReason != null && FAIL_CLOSED_SET.has(status.stopReason);
}

export function completenessRank(value) {
  const rank = COMPLETENESS_RANK.get(value);
  if (rank == null) fail('analysis-status-invalid-completeness');
  return rank;
}

/** Weakest completeness wins. Used whenever several inputs feed one answer. */
export function weakestCompleteness(...values) {
  let worst = 'complete';
  for (const value of values.flat()) {
    if (value == null) continue;
    if (completenessRank(value) > completenessRank(worst)) worst = value;
  }
  return worst;
}

/**
 * Merges several statuses into the one status a fused result may claim.
 *
 * Merging never strengthens: the result is at most as complete as its weakest
 * input, and any fail-closed stop reason propagates.
 */
export function mergeAnalysisStatus(base, ...others) {
  if (!base) fail('analysis-status-merge-base-required');
  const all = [base, ...others.flat().filter(Boolean)];
  const completeness = weakestCompleteness(all.map((status) => status.completeness));
  let stopReason = null;
  for (const status of all) {
    if (status.stopReason == null) continue;
    if (stopReason == null || (FAIL_CLOSED_SET.has(status.stopReason) && !FAIL_CLOSED_SET.has(stopReason))) {
      stopReason = status.stopReason;
    }
  }
  if (completeness === 'complete' && stopReason != null) fail('analysis-status-merge-inconsistent');
  const evidenceIds = [...new Set(all.flatMap((status) => status.evidenceIds ?? []))].sort();
  const dependencyIds = [...new Set(all.flatMap((status) => status.dependencyIds ?? []))].sort();
  const budgetClass = all.map((status) => status.budgetClass).find((value) => value != null) ?? null;
  return createAnalysisStatus({
    snapshotId: base.snapshotId,
    analyzerId: base.analyzerId,
    analyzerVersion: base.analyzerVersion,
    completeness,
    budgetClass,
    stopReason,
    evidenceIds,
    dependencyIds,
  });
}

/**
 * Consumer-side guard. A lookup that needs a total answer must call this rather
 * than reading `completeness` ad hoc, so "partial satisfies complete" can never
 * be reintroduced by a well-meaning caller.
 */
export function satisfiesRequirement(status, required = 'complete') {
  if (!COMPLETENESS_SET.has(required)) fail('analysis-status-invalid-completeness');
  if (!status) return false;
  if (isFailClosedStatus(status)) return false;
  return completenessRank(status.completeness) <= completenessRank(required);
}

/** Stable digest of the status identity, for evidence manifests. */
export function analysisStatusDigest(status) {
  return stableDigest({
    schemaVersion: status.schemaVersion,
    snapshotId: status.snapshotId,
    analyzerId: status.analyzerId,
    analyzerVersion: status.analyzerVersion,
    completeness: status.completeness,
    budgetClass: status.budgetClass,
    stopReason: status.stopReason,
    dependencyIds: status.dependencyIds,
  });
}
