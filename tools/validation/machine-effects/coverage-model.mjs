export const COVERAGE_STATUS = Object.freeze({
  EXACT: 'exact',
  EXACT_WITH_INTRINSIC: 'exact-with-intrinsic',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
  UNSUPPORTED: 'unsupported',
});

export const INTEGRATION_STATE = Object.freeze({
  INTEGRATED: 'integrated',
  NOT_INTEGRATED: 'not-integrated',
});

const VALID_COVERAGE = new Set(Object.values(COVERAGE_STATUS));
const VALID_INTEGRATION = new Set(Object.values(INTEGRATION_STATE));
const CONTRACT_COMPLETENESS = new Set([
  COVERAGE_STATUS.EXACT,
  COVERAGE_STATUS.EXACT_WITH_INTRINSIC,
  COVERAGE_STATUS.PARTIAL,
  COVERAGE_STATUS.UNKNOWN,
]);

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

export function normalizeLiftResult(result) {
  if (result && typeof result === 'object' && typeof result.completeness === 'string' && Array.isArray(result.operations)) {
    if (!CONTRACT_COMPLETENESS.has(result.completeness)) fail('invalid-machine-effects-completeness', result.completeness);
    return Object.freeze({ coverage: result.completeness, bundle: result, reason: null });
  }

  if (!result || typeof result !== 'object') fail('invalid-lift-result');
  const coverage = result.coverage || result.status;
  if (!VALID_COVERAGE.has(coverage)) fail('invalid-coverage-status', String(coverage));

  if (coverage === COVERAGE_STATUS.UNSUPPORTED) {
    if (result.bundle != null) {
      return Object.freeze({ coverage, bundle: result.bundle, reason: result.reason || 'unsupported-with-bundle' });
    }
    return Object.freeze({ coverage, bundle: null, reason: result.reason || 'not implemented' });
  }

  if (!result.bundle || typeof result.bundle !== 'object') fail('coverage-requires-bundle', coverage);
  if (result.bundle.completeness !== coverage) {
    fail('coverage-bundle-mismatch', `${coverage} != ${result.bundle.completeness}`);
  }
  return Object.freeze({ coverage, bundle: result.bundle, reason: result.reason || null });
}

export function createCoverageRecord({
  key,
  mnemonic = null,
  family = null,
  coverage,
  reason = null,
  integrationState = INTEGRATION_STATE.INTEGRATED,
  evidence = [],
} = {}) {
  if (!key || typeof key !== 'string') fail('coverage-key-required');
  if (!VALID_COVERAGE.has(coverage)) fail('invalid-coverage-status', String(coverage));
  if (!VALID_INTEGRATION.has(integrationState)) fail('invalid-integration-state', String(integrationState));
  if (!Array.isArray(evidence)) fail('coverage-evidence-must-be-array');
  return Object.freeze({
    key,
    mnemonic: mnemonic == null ? null : String(mnemonic).toLowerCase(),
    family: family == null ? null : String(family),
    coverage,
    reason: reason == null ? null : String(reason),
    integrationState,
    evidence: Object.freeze(evidence.map((item) => String(item)).sort()),
  });
}

export function summarizeCoverage(records, { integrationState = null } = {}) {
  if (!Array.isArray(records)) fail('coverage-records-must-be-array');
  if (integrationState != null && !VALID_INTEGRATION.has(integrationState)) {
    fail('invalid-integration-state', String(integrationState));
  }

  const counts = Object.fromEntries(Object.values(COVERAGE_STATUS).map((status) => [status, 0]));
  const byFamily = new Map();
  const keys = new Set();
  let notIntegrated = 0;

  for (const raw of records) {
    const record = createCoverageRecord(raw);
    if (keys.has(record.key)) fail('duplicate-coverage-key', record.key);
    keys.add(record.key);
    counts[record.coverage]++;
    if (record.integrationState === INTEGRATION_STATE.NOT_INTEGRATED) notIntegrated++;
    const family = record.family || '<unclassified>';
    const familyCounts = byFamily.get(family) || Object.fromEntries(Object.values(COVERAGE_STATUS).map((status) => [status, 0]));
    familyCounts[record.coverage]++;
    byFamily.set(family, familyCounts);
  }

  const effectiveIntegration = integrationState || (notIntegrated ? INTEGRATION_STATE.NOT_INTEGRATED : INTEGRATION_STATE.INTEGRATED);
  return Object.freeze({
    schemaVersion: 'machine-effects-coverage-report/v1',
    integrationState: effectiveIntegration,
    total: records.length,
    counts: Object.freeze(counts),
    byFamily: Object.freeze(Object.fromEntries([...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b)))),
    notIntegrated,
    percentagePolicy: 'not-emitted; unknown and unsupported are always reported as explicit counts',
  });
}

export function assertCoverageFullyAccounted(report) {
  if (!report || typeof report !== 'object' || !report.counts) fail('coverage-report-required');
  const counted = Object.values(COVERAGE_STATUS).reduce((sum, status) => sum + Number(report.counts[status] || 0), 0);
  if (counted !== Number(report.total)) fail('coverage-count-mismatch', `${counted} != ${report.total}`);
  if (!Object.prototype.hasOwnProperty.call(report.counts, COVERAGE_STATUS.UNKNOWN)) fail('coverage-unknown-missing');
  if (!Object.prototype.hasOwnProperty.call(report.counts, COVERAGE_STATUS.UNSUPPORTED)) fail('coverage-unsupported-missing');
  return true;
}

export function assertIntegrated(report) {
  if (!report || report.integrationState !== INTEGRATION_STATE.INTEGRATED) {
    fail('machine-effects-not-integrated', report?.integrationState || 'missing');
  }
  return true;
}
