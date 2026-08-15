/*
 * Audited facade over report-legacy.js.
 *
 * FieldIndex.resolveAccess may deliberately return a heuristic match with
 * `certain:false` for x19/x20-style object accesses. Such a label is useful as
 * a candidate, but it must never appear in the FACT layer or be consumed as an
 * identified field by role/purpose logic. See issue #298.
 */
import { buildFunctionReport as legacyBuildFunctionReport } from './report-legacy.js';

export * from './report-legacy.js';

function detachUncertainField(owner, row, field, inferred) {
  if (!field || field.certain === true) return field || null;
  inferred.push({
    certainty: 'inference',
    code: 'field-candidate',
    confidence: 0.35,
    level: 'low',
    evidence: [],
    detail: {
      owner: owner && owner.className ? owner.className : null,
      row: row == null ? null : row,
      candidate: field,
      reason: 'heuristic-object-base',
    },
  });
  return null;
}

export function buildFunctionReport(opts) {
  const report = legacyBuildFunctionReport(opts);
  if (!report) return report;
  const inferred = [];

  /* Canonical update/location objects are reused downstream. Remove uncertain
     labels there first so later consumers cannot promote them back to facts. */
  for (const u of report.updates || []) {
    if (!u || !u.field || u.field.certain === true) continue;
    u.fieldCandidate = u.field;
    u.field = detachUncertainField(report.owner, u.store && u.store.row, u.fieldCandidate, inferred);
  }
  for (const loc of report.locations || []) {
    if (!loc || !loc.field || loc.field.certain === true) continue;
    loc.fieldCandidate = loc.field;
    loc.field = detachUncertainField(report.owner, loc.row, loc.fieldCandidate, inferred);
  }
  for (const e of report.editTargets || []) {
    if (!e || !e.field || e.field.certain === true) continue;
    e.fieldCandidate = e.field;
    e.field = null;
  }

  /* FACT rows are snapshots created by the latest report implementation, so
     scrub them independently. Only an explicitly certain resolution remains. */
  for (const f of report.facts || []) {
    if (!f || f.code !== 'value-update' || !f.detail || !f.detail.field) continue;
    const candidate = f.detail.field;
    if (candidate.certain === true) continue;
    f.detail.fieldCandidate = candidate;
    f.detail.field = null;
  }

  if (inferred.length) report.inferences = [...(report.inferences || []), ...inferred];
  report.fieldCertaintyBoundary = true;
  return report;
}
