import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { buildCorpusManifest } from './corpus-manifest.mjs';
import { collectPhase7Metrics } from './metrics.mjs';

/**
 * Permanent Phase 7 verifier.
 *
 * It exists from P7-0 and runs in shadow mode from the first checkpoint, so
 * final verification is a boring re-run rather than the first time the verifier
 * meets the real product (EP-011, FM-10). At an early checkpoint it correctly
 * reports BLOCKING or NOT-INTEGRATED; the one thing it must never do is report
 * READY because a capability was absent.
 *
 * Every verdict binds the exact product commit and tree, the verifier version,
 * the frozen profile, and the corpus/query/truth/scoring manifest digest.
 * Publication is atomic — validate, write to a temporary path, rename — so a
 * failed or truncated run can never leave a current-looking report behind
 * (EP-015, P7-INV-011).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase7/profile.json'), 'utf8'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase7/release-evidence.schema.json'), 'utf8'));
const FROZEN_MANIFEST_PATH = path.join(ROOT, 'tests/phase7/corpus/manifest.json');

export const VERIFIER_ID = 'phase7.verifier';
export const VERIFIER_VERSION = '1.0.0';
export const SCHEMA_VERSION = 'phase7-release-evidence/v1';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

/**
 * Paths a verification run necessarily dirties, and which are therefore not
 * source under test.
 *
 * `reports/phase7/` is the verifier's own output: writing the report is the
 * last thing a run does, so counting it would make every run report its own
 * output as a reason to distrust itself.
 *
 * The deployment stamp records which commit a *deployment* was built from. Any
 * canonical build rewrites it — including the generated-output step that runs
 * immediately before this verifier in CI — so requiring it to be clean would
 * fail on the workflow's own side effect. The repository's canonical
 * generated-sync check excludes it for the same reason.
 *
 * Everything else still counts. `dirty source fails closed` in
 * tests/phase7/verifier/exact-head.test.mjs proves the exclusion stayed narrow.
 */
const UNVERIFIED_PATHS = Object.freeze([
  'reports/phase7/',
  'js/userscript/deployment-identity.generated.js',
]);

function productIdentity() {
  const commitSha = git(['rev-parse', 'HEAD']);
  const treeSha = git(['rev-parse', 'HEAD^{tree}']);
  const status = git(['status', '--porcelain']) ?? '';
  // A dirty tree means the reported commit does not describe what was tested
  // (EP-018), so exact-commit proof fails closed rather than being fudged.
  //
  // The one exclusion is the verifier's own evidence directory. Writing the
  // report is the last thing a run does, so counting it as dirt would make
  // every run report its own output as a reason to distrust itself. Source
  // dirt anywhere else still fails, which is the property that matters.
  const dirty = status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const path_ = line.slice(2).trim();
      return !UNVERIFIED_PATHS.some((prefix) => path_.startsWith(prefix));
    });
  return Object.freeze({
    commitSha: commitSha ?? '0'.repeat(40),
    treeSha: treeSha ?? '0'.repeat(40),
    workingTreeClean: dirty.length === 0,
    dirtyPaths: dirty,
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

export async function verifyPhase7({ shadow = false, expectedSha = null, gates = false } = {}) {
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

  // Corpus identity. A regenerated manifest that differs from the frozen one
  // means the measured question set moved underneath the candidate.
  const regenerated = buildCorpusManifest();
  const frozen = fs.existsSync(FROZEN_MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(FROZEN_MANIFEST_PATH, 'utf8'))
    : null;
  const frozenDigestMatches = frozen != null && frozen.manifestDigest === regenerated.manifestDigest;
  if (!frozenDigestMatches) {
    blocking('corpus', 'frozen corpus manifest digest does not match the regenerated manifest',
      regenerated.manifestDigest, frozen?.manifestDigest ?? 'missing');
  }

  const metrics = await collectPhase7Metrics({ manifestLanes: regenerated.architectureLanes.mandatory, repetitions: PROFILE.performance.repetitions });

  // Soundness: these outrank every schedule and precision consideration.
  if (metrics.alias.candidate.falseNoAlias > PROFILE.soundness.maxFalseNoAlias) {
    blocking('soundness', 'candidate returned NoAlias where truth is not no', '0', metrics.alias.candidate.falseNoAlias);
  }
  if (metrics.alias.candidate.falseMustAlias > PROFILE.soundness.maxFalseMustAlias) {
    blocking('soundness', 'candidate returned MustAlias where truth is not must', '0', metrics.alias.candidate.falseMustAlias);
  }
  if (metrics.memoryLinks.candidate.barrierBypasses > PROFILE.soundness.maxBarrierBypasses) {
    blocking('soundness', 'a load was forwarded across a mandatory barrier', '0', metrics.memoryLinks.candidate.barrierBypasses);
  }
  if (metrics.types.candidate.falseCertainty > PROFILE.soundness.maxFalseCertainty) {
    blocking('soundness', 'a type conclusion was reported certain against exact truth', '0', metrics.types.candidate.falseCertainty);
  }
  if (metrics.discovery.candidate.falseStarts > 0) {
    blocking('soundness', 'function discovery produced a start with no supporting evidence', '0', metrics.discovery.candidate.falseStarts);
  }

  // Precision may not regress against the baseline on the same denominator.
  if (PROFILE.precision.requireExactProvenAtLeastBaseline
    && metrics.alias.candidate.exactProven < metrics.alias.baseline.exactProven) {
    blocking('precision', 'candidate proves fewer exact alias relations than the baseline',
      `>= ${metrics.alias.baseline.exactProven}`, metrics.alias.candidate.exactProven);
  }
  if (PROFILE.precision.requireNoUnknownRateIncrease
    && metrics.alias.candidate.unknownRate > metrics.alias.baseline.unknownRate + 1e-9) {
    blocking('precision', 'candidate leaves more alias queries unknown than the baseline',
      `<= ${metrics.alias.baseline.unknownRate}`, metrics.alias.candidate.unknownRate);
  }
  if (metrics.memoryLinks.candidate.exactLinks < metrics.memoryLinks.baseline.exactLinks) {
    blocking('precision', 'candidate proves fewer exact memory links than the baseline',
      `>= ${metrics.memoryLinks.baseline.exactLinks}`, metrics.memoryLinks.candidate.exactLinks);
  }

  // Debug ecosystems: DWARF *and* PDB. One working backend is not the phase.
  for (const ecosystem of PROFILE.requiredDebugEcosystems) {
    const lane = metrics.debug.ecosystems[ecosystem];
    if (!lane) blocking('debug', `required debug ecosystem is missing: ${ecosystem}`, 'present', 'missing');
    else if (!lane.identityBound) blocking('debug', `debug ecosystem does not enforce identity binding: ${ecosystem}`, 'identity-bound', 'unbound');
    else if (!lane.failsClosedOnMismatch) blocking('debug', `debug ecosystem does not fail closed on identity mismatch: ${ecosystem}`, 'fail-closed', 'applies-anyway');
  }

  // Architecture lanes: a missing mandatory lane is blocking, never skip-green.
  for (const lane of regenerated.architectureLanes.mandatory) {
    const observed = metrics.architectureLanes[lane];
    if (!observed) blocking('architecture', `mandatory architecture lane produced no evidence: ${lane}`, 'evidence', 'missing');
    else if (!observed.genericLawsHold) blocking('architecture', `metamorphic middle-end laws failed on lane: ${lane}`, 'laws hold', 'violated');
  }

  for (const [name, result] of Object.entries(metrics.performance)) {
    const budget = PROFILE.performance.budgetsMs[name];
    if (budget == null) continue;
    if (result.medianMs > budget) {
      blocking('performance', `performance budget exceeded: ${name}`, `<= ${budget} ms`, `${result.medianMs} ms`);
    }
  }

  const gateResults = gates ? PROFILE.requiredGates.map(runGate) : [];
  for (const gate of gateResults) {
    if (!gate.ok) blocking('gate', `required gate failed: ${gate.command}`, 'exit 0', `exit ${gate.status}\n${gate.tail}`);
  }

  const checkpoints = PROFILE.requiredCheckpoints.map((id) => ({
    id, present: metrics.checkpoints.includes(id),
  }));
  const missingCheckpoints = checkpoints.filter((checkpoint) => !checkpoint.present).map((checkpoint) => checkpoint.id);
  if (missingCheckpoints.length) {
    failures.push({
      category: 'integration',
      firstDivergence: 'a required checkpoint has no evidence on this head',
      expected: PROFILE.requiredCheckpoints.join(','),
      actual: `missing: ${missingCheckpoints.join(',')}`,
      identity: product.commitSha,
      blocking: true,
    });
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
    corpus: {
      corpusId: regenerated.corpusId,
      corpusVersion: regenerated.corpusVersion,
      manifestDigest: regenerated.manifestDigest,
      frozenDigestMatches,
      scoring: regenerated.scoring,
      truthGenerator: regenerated.truthGenerator,
    },
    checkpoints,
    alias: metrics.alias,
    memoryLinks: metrics.memoryLinks,
    types: metrics.types,
    summaries: metrics.summaries,
    escape: metrics.escape,
    discovery: metrics.discovery,
    debug: metrics.debug,
    architectureLanes: metrics.architectureLanes,
    performance: metrics.performance,
    gates: gateResults,
    evidenceDigest: stableDigest({ metrics, manifest: regenerated.manifestDigest, profile: PROFILE.profileVersion }),
    failures,
    verdict,
  };
  return report;
}

function renderMarkdown(report) {
  const lines = [
    `# Phase 7 release evidence — ${report.verdict}`,
    '',
    `- product: \`${report.product.commitSha}\` (tree \`${report.product.treeSha}\`, branch \`${report.product.branch}\`, clean: ${report.product.workingTreeClean})`,
    `- verifier: ${report.verifierId} ${report.verifierVersion} (source sha256 \`${report.verifierSourceSha256.slice(0, 16)}\`)`,
    `- profile version: ${report.profileVersion}`,
    `- corpus: ${report.corpus.corpusId} v${report.corpus.corpusVersion}, digest \`${report.corpus.manifestDigest}\`, frozen match: ${report.corpus.frozenDigestMatches}`,
    `- scoring: ${report.corpus.scoring.id} ${report.corpus.scoring.version}; truth: ${report.corpus.truthGenerator.id} ${report.corpus.truthGenerator.version}`,
    '',
    '## Alias precision (same frozen query set, same denominator)',
    '',
    '| metric | baseline | candidate |',
    '|---|---|---|',
    `| exact relations proven | ${report.alias.baseline.exactProven}/${report.alias.baseline.exactAvailable} | ${report.alias.candidate.exactProven}/${report.alias.candidate.exactAvailable} |`,
    `| strong proven rate | ${report.alias.baseline.strongProvenRate.toFixed(3)} | ${report.alias.candidate.strongProvenRate.toFixed(3)} |`,
    `| may rate | ${report.alias.baseline.mayRate.toFixed(3)} | ${report.alias.candidate.mayRate.toFixed(3)} |`,
    `| unknown rate | ${report.alias.baseline.unknownRate.toFixed(3)} | ${report.alias.candidate.unknownRate.toFixed(3)} |`,
    `| false NoAlias | ${report.alias.baseline.falseNoAlias} | ${report.alias.candidate.falseNoAlias} |`,
    `| false MustAlias | ${report.alias.baseline.falseMustAlias} | ${report.alias.candidate.falseMustAlias} |`,
    '',
    '## Memory links',
    '',
    '| metric | baseline | candidate |',
    '|---|---|---|',
    `| exact links | ${report.memoryLinks.baseline.exactLinks} | ${report.memoryLinks.candidate.exactLinks} |`,
    `| barriers correctly held | ${report.memoryLinks.baseline.blockedCorrect} | ${report.memoryLinks.candidate.blockedCorrect} |`,
    `| barrier bypasses | ${report.memoryLinks.baseline.barrierBypasses} | ${report.memoryLinks.candidate.barrierBypasses} |`,
    '',
    '## Checkpoints',
    '',
    report.checkpoints.map((checkpoint) => `- ${checkpoint.present ? 'x' : ' '} ${checkpoint.id}`).join('\n'),
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
  if (errors.length) throw new Error(`Phase 7 evidence failed its own schema: ${errors.join('; ')}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, content] of [
    ['phase7-release-evidence.json', `${JSON.stringify(report, null, 2)}\n`],
    ['phase7-release-evidence.md', renderMarkdown(report)],
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

export { renderMarkdown };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const shadow = argv.includes('--shadow');
  const gates = argv.includes('--gates');
  const expectedShaIndex = argv.indexOf('--expect-sha');
  const expectedSha = expectedShaIndex >= 0 ? argv[expectedShaIndex + 1] : null;
  const outputIndex = argv.indexOf('--out');
  const outputDirectory = path.resolve(ROOT, outputIndex >= 0 ? argv[outputIndex + 1] : 'reports/phase7');
  let report = null;
  try {
    report = await verifyPhase7({ shadow, expectedSha, gates });
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  }
  if (report) {
    try {
      publish(report, outputDirectory);
      console.log(`P7_VERDICT=${report.verdict}`);
      console.log(`P7_EVIDENCE=${path.relative(ROOT, outputDirectory)}/phase7-release-evidence.json`);
      console.log(renderMarkdown(report));
      // Shadow mode reports the truth without failing the surrounding job, so
      // the verifier can run from the very first checkpoint.
      process.exitCode = shadow || report.verdict === 'READY' ? 0 : 1;
    } catch (error) {
      console.error(error?.stack ?? String(error));
      process.exitCode = 2;
    }
  }
}
