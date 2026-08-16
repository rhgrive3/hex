import fs from 'node:fs';

export const SCHEMA_VERSION = 1;
export const STATUSES = new Set(['measured', 'unmeasured', 'unsupported']);
export const GATES = new Set(['blocking', 'informational', 'none']);

export const REQUIRED_METRICS = Object.freeze({
  accuracy: Object.freeze([
    'functionStartPrecision',
    'functionStartRecall',
    'extentPrecision',
    'extentRecall',
    'cfgEdges',
    'semanticMismatches',
    'decompilerSemanticRegressions',
    'falseCertainty',
  ]),
  performance: Object.freeze([
    'coldOpen',
    'warmOpen',
    'activeFunctionAnalysis',
    'decompilerLatency',
    'searchLatency',
    'peakMemory',
    'cancellationLatency',
    'ttfua',
  ]),
});

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateMetric(metric, path) {
  assert(metric && typeof metric === 'object', `${path}: metric must be an object`);
  assert(STATUSES.has(metric.status), `${path}: invalid status ${metric.status}`);
  assert(GATES.has(metric.gate), `${path}: invalid gate ${metric.gate}`);
  assert(typeof metric.reason === 'string' && metric.reason.length > 0, `${path}: reason is required`);
  if (metric.status === 'measured') {
    assert(metric.value !== undefined || metric.values !== undefined, `${path}: measured metric needs value or values`);
    assert(metric.unit && typeof metric.unit === 'string', `${path}: measured metric needs a unit`);
  } else {
    assert(metric.value === undefined && metric.values === undefined, `${path}: ${metric.status} metric must not fabricate a value`);
    assert(metric.gate === 'none', `${path}: ${metric.status} metric cannot block`);
  }
}

export function validateBaseline(baseline) {
  assert(baseline?.schema === SCHEMA_VERSION, `baseline schema must be ${SCHEMA_VERSION}`);
  assert(/^[0-9a-f]{40}$/.test(baseline?.baseline?.sourceCommit || ''), 'baseline.sourceCommit must be a full SHA');
  assert(baseline?.fixtures && typeof baseline.fixtures === 'object', 'fixtures are required');

  for (const [name, spec] of Object.entries(baseline.fixtures)) {
    assert(Number.isInteger(spec.size) && spec.size > 0, `fixtures.${name}.size invalid`);
    assert(/^[0-9a-f]{64}$/.test(spec.sha256 || ''), `fixtures.${name}.sha256 invalid`);
  }

  for (const [group, required] of Object.entries(REQUIRED_METRICS)) {
    const metrics = baseline.metrics?.[group];
    assert(metrics && typeof metrics === 'object', `metrics.${group} is required`);
    for (const id of required) {
      assert(Object.hasOwn(metrics, id), `metrics.${group}.${id} is required`);
      validateMetric(metrics[id], `metrics.${group}.${id}`);
    }
  }

  assert(baseline.regressionPolicy?.accuracy === 'fail-closed', 'accuracy regression policy must be fail-closed');
  assert(baseline.regressionPolicy?.wallClock === 'informational', 'wall-clock policy must be informational');
  return baseline;
}

export function ratioFromDetail(detail) {
  const text = String(detail || '');
  const match = /適合\s+([0-9.]+)%\s*\/\s*再現\s+([0-9.]+)%/.exec(text);
  if (!match) return null;
  return { precision: Number(match[1]) / 100, recall: Number(match[2]) / 100 };
}
