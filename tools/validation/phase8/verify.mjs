import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { currentSupportMatrix } from '../../../js/platform/capability-maturity.js';

import { collectPhase8Metrics, loadFrozenBaseline } from './metrics.mjs';

/**
 * Permanent Phase 8 verifier.
 *
 * It exists from P8-0 and runs in shadow mode from the first checkpoint, so
 * final verification is a boring re-run rather than the first time the verifier
 * meets the real product (EP-011, EP-006). At an early checkpoint it correctly
 * reports BLOCKING or NOT-INTEGRATED; the one thing it must never do is report
 * READY because a capability was absent.
 *
 * Every verdict binds the exact product commit and tree, the verifier version,
 * the frozen profile, the corpus and toolchain identity, the frozen baseline
 * digest and the pass registry digest. Publication is atomic — validate, write
 * to a temporary path, rename — so a failed or truncated run can never leave a
 * current-looking report behind (EP-015).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase8/profile.json'), 'utf8'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase8/release-evidence.schema.json'), 'utf8'));
const READINESS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase8/readiness.json'), 'utf8'));
const CHECKPOINT_LEDGER = path.join(ROOT, 'reports/phase8/checkpoints.json');

export const VERIFIER_ID = 'phase8.verifier';
export const VERIFIER_VERSION = '1.0.0';
export const SCHEMA_VERSION = 'phase8-release-evidence/v1';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

/**
 * Paths a verification run necessarily dirties, and which are therefore not
 * source under test. `reports/phase8/` is the verifier's own output; the
 * deployment stamp is rewritten by any canonical build.
 */
const UNVERIFIED_PATHS = Object.freeze([
  'reports/phase8/',
  'js/userscript/deployment-identity.generated.js',
]);

function productIdentity() {
  const status = git(['status', '--porcelain']) ?? '';
  // A dirty tree means the reported commit does not describe what was tested
  // (EP-018), so exact-commit proof fails closed rather than being fudged.
  const dirty = status.split('\n').map((line) => line.trim()).filter(Boolean).filter((line) => {
    const file = line.slice(2).trim();
    return !UNVERIFIED_PATHS.some((prefix) => file.startsWith(prefix));
  });
  return Object.freeze({
    commitSha: git(['rev-parse', 'HEAD']) ?? '0'.repeat(40),
    treeSha: git(['rev-parse', 'HEAD^{tree}']) ?? '0'.repeat(40),
    workingTreeClean: dirty.length === 0,
    dirtyPaths: dirty.slice(0, 10),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
  });
}

function runGate(command) {
  const started = Date.now();
  const result = spawnSync('npm', ['run', '--silent', ...command.replace(/^npm run /, '').split(' ')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  return {
    command,
    status: result.status,
    durationMs: Date.now() - started,
    ok: result.status === 0,
    tail: String(result.stderr || result.stdout || '').split('\n').slice(-8).join('\n'),
  };
}

/**
 * Architectures the shared decompiler is claimed to support, read from live
 * capability truth rather than from a list in this file. A lane that live truth
 * calls supported but Phase 8 has no evidence for is missing evidence, which is
 * blocking — it is never quietly dropped from the denominator.
 */
export function mandatoryArchitectureLanes(matrix = currentSupportMatrix()) {
  return matrix.architectures
    .filter((architecture) => architecture.features.cfgSemanticIR === 'supported'
      && architecture.features.ssaMemoryDataflow === 'supported'
      && architecture.features.decompiler === 'supported')
    .map((architecture) => architecture.id)
    .sort();
}

function readCheckpoints() {
  if (!fs.existsSync(CHECKPOINT_LEDGER)) return [];
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_LEDGER, 'utf8')).checkpoints ?? []; }
  catch { return []; }
}

/** Minimal structural check of the evidence against its own frozen schema. */
export function validateEvidence(report) {
  const errors = [];
  for (const key of SCHEMA.required) if (!(key in report)) errors.push(`missing field: ${key}`);
  if (report.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion mismatch');
  if (!['READY', 'BLOCKING', 'NOT-INTEGRATED'].includes(report.verdict)) errors.push('invalid verdict');
  if (!Array.isArray(report.failures)) errors.push('failures must be an array');
  for (const [key, spec] of Object.entries(SCHEMA.properties)) {
    if (!spec.required || !report[key]) continue;
    for (const field of spec.required) if (!(field in report[key])) errors.push(`missing ${key}.${field}`);
  }
  return errors;
}

/**
 * `metrics` may be supplied by a caller that has already collected them. It
 * exists so verifier-correctness tests can exercise verdict logic without
 * re-running the whole corpus for every case; product verification never passes
 * it, so a real run always measures the real head (§3.5).
 */
export function verifyPhase8({ shadow = false, expectedSha = null, gates = false, repetitions = PROFILE.performance.repetitions, metrics: injectedMetrics = null } = {}) {
  const product = productIdentity();
  const failures = [];
  const blocking = (category, firstDivergence, expected, actual) => {
    failures.push({ category, firstDivergence, expected, actual: String(actual), identity: product.commitSha, blocking: true });
  };

  if (expectedSha && expectedSha !== product.commitSha) {
    blocking('identity', 'product commit does not match the requested exact head', expectedSha, product.commitSha);
  }
  if (!product.workingTreeClean && !shadow) {
    blocking('identity', 'working tree is dirty, so the commit does not describe what was tested',
      'clean tree', product.dirtyPaths.join('; ') || 'dirty');
  }

  const metrics = injectedMetrics ?? collectPhase8Metrics({ repetitions, includePerformance: true });
  const baseline = loadFrozenBaseline();

  // Corpus and baseline identity. A baseline captured against a different corpus
  // is a different series and cannot be compared across.
  if (metrics.corpus.corpusDigest !== undefined && baseline.corpusDigest !== metrics.corpus.corpusDigest) {
    blocking('corpus', 'frozen baseline was captured against a different corpus digest',
      metrics.corpus.corpusDigest, baseline.corpusDigest);
  }

  // Hard-zero safety gates.
  for (const [counter, limit] of Object.entries(PROFILE.hardZero)) {
    const value = metrics.safety[counter];
    if (value == null) {
      // Not measured yet. The checkpoint that owns the machinery is named in the
      // profile; until it lands this is missing evidence, not a pass.
      const owner = PROFILE.hardZeroMeasuredFrom[counter];
      failures.push({
        category: 'coverage',
        firstDivergence: `${counter} is not measurable on this head`,
        expected: `measured from ${owner ?? 'an implemented checkpoint'}`,
        actual: 'null (not measured)',
        identity: product.commitSha,
        blocking: true,
      });
      continue;
    }
    if (value > limit) blocking('safety', `${counter} exceeded its hard-zero limit`, String(limit), value);
  }

  // Quality floors: a candidate may never move a vector entry the wrong way.
  for (const [entry, direction] of Object.entries(PROFILE.quality.direction)) {
    const before = metrics.quality.baseline[entry];
    const after = metrics.quality.candidate[entry];
    if (before == null || after == null) continue;
    const worse = direction === 'lower' ? after > before : after < before;
    if (worse) blocking('quality', `readability vector regressed: ${entry}`, `${direction} than ${before}`, after);
  }

  // Architecture lanes from live capability truth.
  const lanes = mandatoryArchitectureLanes();
  const covered = new Set(loadFrozenBaseline().observations.length
    ? [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase8/corpus/functions.json'), 'utf8'))
      .functions.map((entry) => entry.architectureId))]
    : []);
  const architectureLanes = lanes.map((lane) => ({ lane, hasEvidence: covered.has(lane) }));
  for (const lane of architectureLanes) {
    if (!lane.hasEvidence) {
      failures.push({
        category: 'architecture',
        firstDivergence: `mandatory architecture lane has no Phase 8 evidence: ${lane.lane}`,
        expected: 'corpus evidence',
        actual: 'missing',
        identity: product.commitSha,
        blocking: true,
      });
    }
  }

  // Readiness matrix must be resolved: no capability may be left unclassified.
  const allowedStates = new Set(READINESS.states);
  const unresolved = READINESS.capabilities
    .filter((capability) => !allowedStates.has(capability.state))
    .map((capability) => capability.id);
  if (unresolved.length) {
    blocking('readiness', 'readiness matrix contains an unclassified capability', 'every capability classified', unresolved.join(','));
  }

  // Performance budgets.
  const coldMedian = metrics.performance?.coldActiveFunctionMs?.medianMs ?? null;
  if (coldMedian != null && coldMedian > PROFILE.performance.budgetsMs.coldActiveFunction) {
    blocking('performance', 'active-function latency budget exceeded',
      `<= ${PROFILE.performance.budgetsMs.coldActiveFunction} ms`, `${coldMedian.toFixed(1)} ms`);
  }

  const gateResults = gates ? PROFILE.requiredGates.map(runGate) : [];
  for (const gate of gateResults) {
    if (!gate.ok) blocking('gate', `required gate failed: ${gate.command}`, 'exit 0', `exit ${gate.status}\n${gate.tail}`);
  }

  const recorded = new Set(readCheckpoints().filter((entry) => entry.result === 'accepted').map((entry) => entry.id));
  const checkpoints = PROFILE.requiredCheckpoints.map((id) => ({ id, present: recorded.has(id) }));
  const missingCheckpoints = checkpoints.filter((checkpoint) => !checkpoint.present).map((checkpoint) => checkpoint.id);
  if (missingCheckpoints.length) {
    failures.push({
      category: 'integration',
      firstDivergence: 'a required checkpoint has no accepted evidence on this head',
      expected: PROFILE.requiredCheckpoints.join(','),
      actual: `missing: ${missingCheckpoints.join(',')}`,
      identity: product.commitSha,
      blocking: true,
    });
  }

  // A Phase 8 that improved nothing is not a completed Phase 8.
  for (const entry of PROFILE.quality.requireStrictImprovementAtExit) {
    if (missingCheckpoints.length) break;
    const before = metrics.quality.baseline[entry];
    const after = metrics.quality.candidate[entry];
    const direction = PROFILE.quality.direction[entry];
    const improved = direction === 'lower' ? after < before : after > before;
    if (!improved) blocking('quality', `exit requires a measurable improvement in ${entry}`, `${direction} than ${before}`, after);
  }

  const verdict = failures.length === 0
    ? 'READY'
    : missingCheckpoints.length === PROFILE.requiredCheckpoints.length ? 'NOT-INTEGRATED' : 'BLOCKING';

  const report = {
    schemaVersion: SCHEMA_VERSION,
    verifierId: VERIFIER_ID,
    verifierVersion: VERIFIER_VERSION,
    verifierSourceSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    generatedAt: new Date().toISOString(),
    product,
    profileVersion: PROFILE.profileVersion,
    corpus: metrics.corpus,
    registry: metrics.registry,
    readiness: {
      auditedCommit: READINESS.auditedCommit,
      capabilityCount: READINESS.capabilities.length,
      unresolved,
      byState: Object.fromEntries(READINESS.states.map((state) => [
        state, READINESS.capabilities.filter((capability) => capability.state === state).map((capability) => capability.id),
      ])),
    },
    checkpoints,
    quality: metrics.quality,
    safety: metrics.safety,
    architectureLanes,
    performance: metrics.performance,
    gates: gateResults,
    evidenceDigest: stableDigest({
      quality: metrics.quality,
      safety: metrics.safety,
      corpus: metrics.corpus.corpusDigest,
      registry: metrics.registry.passRegistryDigest,
      profile: PROFILE.profileVersion,
    }),
    failures,
    verdict,
  };
  return report;
}

function renderMarkdown(report) {
  const lines = [
    `# Phase 8 release evidence — ${report.verdict}`,
    '',
    `- product: \`${report.product.commitSha}\` (tree \`${report.product.treeSha}\`, branch \`${report.product.branch}\`, clean: ${report.product.workingTreeClean})`,
    `- verifier: ${report.verifierId} ${report.verifierVersion} (source sha256 \`${report.verifierSourceSha256.slice(0, 16)}\`)`,
    `- profile version: ${report.profileVersion}`,
    `- corpus: ${report.corpus.corpusId} v${report.corpus.corpusVersion}, digest \`${report.corpus.corpusDigest}\``,
    `- toolchain: ${report.corpus.toolchain.compiler} (${report.corpus.toolchain.target})`,
    `- baseline: \`${report.corpus.frozenBaselineDigest}\` captured at \`${report.corpus.baselineCommit}\``,
    `- pass registry: \`${report.registry.passRegistryDigest}\` (${report.registry.passes.map((pass) => `${pass.id}@${pass.version}`).join(', ')})`,
    '',
    '## Hard-zero safety counters',
    '',
    '| counter | value |',
    '|---|---|',
    ...Object.keys(report.safety)
      .filter((key) => key.endsWith('Count'))
      .map((key) => `| ${key} | ${report.safety[key] === null ? 'not measured' : report.safety[key]} |`),
    '',
    '## Readability / recovery vector',
    '',
    '| metric | baseline | candidate |',
    '|---|---|---|',
    ...Object.keys(report.quality.baseline).map((key) => `| ${key} | ${report.quality.baseline[key]} | ${report.quality.candidate[key]} |`),
    '',
    '## Architecture lanes',
    '',
    ...report.architectureLanes.map((lane) => `- ${lane.hasEvidence ? 'x' : ' '} ${lane.lane}`),
    '',
    '## Checkpoints',
    '',
    ...report.checkpoints.map((checkpoint) => `- ${checkpoint.present ? 'x' : ' '} ${checkpoint.id}`),
    '',
    '## Failures',
    '',
  ];
  if (report.failures.length === 0) lines.push('None.');
  else {
    lines.push('| category | first divergence | expected | actual | blocking |', '|---|---|---|---|---|');
    for (const failure of report.failures) {
      lines.push(`| ${failure.category} | ${failure.firstDivergence} | ${failure.expected} | ${String(failure.actual).replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${failure.blocking} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Validate, write to a temporary path, then rename. Never publish on failure. */
export function publish(report, outputDirectory) {
  const errors = validateEvidence(report);
  if (errors.length) throw new Error(`Phase 8 evidence failed its own schema: ${errors.join('; ')}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, content] of [
    ['phase8-release-evidence.json', `${JSON.stringify(report, null, 2)}\n`],
    ['phase8-release-evidence.md', renderMarkdown(report)],
  ]) {
    const target = path.join(outputDirectory, name);
    const temporary = path.join(outputDirectory, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, content);
    if (fs.statSync(temporary).size === 0) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`refusing to publish an empty artifact: ${name}`);
    }
    fs.renameSync(temporary, target);
  }
  return outputDirectory;
}

export { renderMarkdown, PROFILE };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const shadow = argv.includes('--shadow');
  const gates = argv.includes('--gates');
  const expectedShaIndex = argv.indexOf('--expect-sha');
  const expectedSha = expectedShaIndex >= 0 ? argv[expectedShaIndex + 1] : null;
  const outputIndex = argv.indexOf('--out');
  const outputDirectory = path.resolve(ROOT, outputIndex >= 0 ? argv[outputIndex + 1] : 'reports/phase8');
  let report = null;
  try {
    report = verifyPhase8({ shadow, expectedSha, gates });
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  }
  if (report) {
    try {
      publish(report, outputDirectory);
      console.log(`P8_VERDICT=${report.verdict}`);
      console.log(`P8_EVIDENCE=${path.relative(ROOT, outputDirectory)}/phase8-release-evidence.json`);
      console.log(renderMarkdown(report));
      // Shadow mode reports the truth without failing the surrounding job, so
      // the verifier can run from the very first checkpoint (EP-011).
      process.exitCode = shadow || report.verdict === 'READY' ? 0 : 1;
    } catch (error) {
      console.error(error?.stack ?? String(error));
      process.exitCode = 2;
    }
  }
}
