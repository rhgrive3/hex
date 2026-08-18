import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Permanent Phase 6 verifier.
 *
 * Built early and matured continuously, so final release verification is a
 * boring re-run rather than the first time the verifier sees the finished
 * product. At an early checkpoint it legitimately reports BLOCKING or
 * NOT-INTEGRATED; what it must never do is report READY by absence.
 *
 * Every published verdict is bound to the exact product commit and tree, the
 * verifier's own version, the frozen profile, the corpus digest, the toolchain
 * identity, and the deployed decoder artifact hashes. Publication is atomic:
 * the report is validated and written to a temporary file, then renamed, so a
 * truncated or partial report can never be mistaken for evidence.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase6/profile.json'), 'utf8'));
const SCHEMA_VERSION = 'phase6-release-evidence/v1';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function productIdentity() {
  const commitSha = git(['rev-parse', 'HEAD']);
  const treeSha = git(['rev-parse', 'HEAD^{tree}']);
  const status = git(['status', '--porcelain']);
  return Object.freeze({
    commitSha: commitSha ?? '0'.repeat(40),
    treeSha: treeSha ?? '0'.repeat(40),
    // A dirty tree means the reported commit does not describe what was tested.
    workingTreeClean: status === '',
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
  });
}

function decoderIdentity() {
  return PROFILE.decoder.deployedArtifacts.map((artifact) => {
    const absolute = path.join(ROOT, artifact.path);
    const present = fs.existsSync(absolute);
    const digest = present ? sha256(fs.readFileSync(absolute)) : '0'.repeat(64);
    return { path: artifact.path, sha256: digest, matchesFrozenProfile: present && digest === artifact.sha256 };
  });
}

function runCommand(label, executable, args) {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  return Object.freeze({
    label,
    command: `${executable} ${args.join(' ')}`,
    status: result.status,
    durationMs: Date.now() - started,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  });
}

/** Extract the corpus ledger the mandatory gate prints. Absence is BLOCKING. */
function parseLedger(output) {
  const marker = 'P6_PIPELINE_LEDGER=';
  const index = output.lastIndexOf(marker);
  if (index < 0) return null;
  const line = output.slice(index + marker.length).split('\n', 1)[0];
  try { return JSON.parse(line); }
  catch { return null; }
}

function zeroCounts() {
  return {
    mandatoryCorpusCases: 0,
    instantiatedCases: 0,
    missingCases: 0,
    exactEffects: 0,
    partialEffects: 0,
    unsupportedEffects: 0,
    semanticMismatches: 0,
    decoderMismatches: 0,
    abiMismatches: 0,
    elfMismatches: 0,
    provenanceLosses: 0,
    hiddenFallbacks: 0,
    unknownStoreSafetyFailures: 0,
    unknownCallSafetyFailures: 0,
    architectureNeutralityViolations: 0,
    staleArtifactFailures: 0,
    crossArchitectureMismatches: 0,
    firstDivergenceCount: 0,
  };
}

const GATE_GROUPS = Object.freeze([
  { id: 'phase6-foundation', group: 'foundation' },
  { id: 'phase6-decoder', group: 'decoder' },
  { id: 'phase6-registers', group: 'registers' },
  { id: 'phase6-effects', group: 'effects' },
  { id: 'phase6-abi', group: 'abi' },
  { id: 'phase6-elf', group: 'elf' },
  { id: 'phase6-generic-core', group: 'generic-core' },
  { id: 'phase6-cross-architecture', group: 'cross-architecture' },
  { id: 'phase6-ownership', group: 'ownership' },
  { id: 'phase6-mandatory-corpus', group: 'verification' },
]);

export function verifyPhase6({ shadow = false, expectedSha = null } = {}) {
  const product = productIdentity();
  const failures = [];
  const gates = [];
  const counts = zeroCounts();

  const addFailure = (category, firstDivergence, expected, actual, identity, blocking = true) => {
    failures.push({ category, firstDivergence, expected: String(expected), actual: String(actual), identity: String(identity), blocking });
    if (blocking) counts.firstDivergenceCount += 1;
  };

  if (expectedSha && expectedSha.toLowerCase() !== product.commitSha.toLowerCase()) {
    addFailure('stale-head', 'product commit does not equal the requested exact head',
      expectedSha, product.commitSha, product.commitSha);
  }
  if (!product.workingTreeClean) {
    addFailure('dirty-tree', 'working tree has uncommitted changes',
      'clean working tree', 'modified files present', product.commitSha);
  }

  const decoderArtifacts = decoderIdentity();
  for (const artifact of decoderArtifacts) {
    if (!artifact.matchesFrozenProfile) {
      addFailure('decoder-identity', `deployed decoder artifact does not match the frozen profile: ${artifact.path}`,
        PROFILE.decoder.deployedArtifacts.find((item) => item.path === artifact.path)?.sha256 ?? 'declared hash',
        artifact.sha256, artifact.path);
    }
  }

  let ledger = null;
  for (const gate of GATE_GROUPS) {
    const run = runCommand(gate.id, process.execPath, ['tests/phase6/run.mjs', '--group', gate.group]);
    const passed = run.status === 0;
    gates.push({ id: gate.id, status: passed ? 'PASS' : 'FAIL', detail: `${run.command} exited ${run.status} in ${run.durationMs}ms` });
    if (gate.group === 'verification') ledger = parseLedger(`${run.stdout}\n${run.stderr}`);
    if (!passed) {
      const firstError = (run.stderr || run.stdout).split('\n').find((line) => /Error|AssertionError|✖/.test(line)) ?? 'gate failed';
      addFailure('gate-failure', `${gate.id} failed`, 'exit status 0', firstError.trim().slice(0, 400), gate.id);
    }
  }

  const expectedCases = PROFILE.corpus.mandatoryTargets.length
    * PROFILE.corpus.mandatoryOptimizationLevels.length
    * PROFILE.corpus.mandatoryCategories.length;
  counts.mandatoryCorpusCases = expectedCases;

  if (!ledger) {
    // Missing mandatory coverage is BLOCKING. It is never "0 failures".
    addFailure('missing-evidence', 'the mandatory corpus gate published no ledger',
      'a complete P6_PIPELINE_LEDGER record', 'absent or malformed', 'phase6-mandatory-corpus');
    counts.missingCases = expectedCases;
  } else {
    counts.instantiatedCases = Number(ledger.totals?.mandatory ?? 0);
    counts.missingCases = Math.max(0, expectedCases - counts.instantiatedCases);
    counts.decoderMismatches = Number(ledger.safety?.decoderMismatches ?? 0) + Number(ledger.safety?.capstoneDifferentialMismatches ?? 0);
    counts.provenanceLosses = Number(ledger.safety?.provenanceLosses ?? 0);
    counts.hiddenFallbacks = Number(ledger.safety?.hiddenFallbacks ?? 0);
    counts.unknownStoreSafetyFailures = Number(ledger.safety?.unknownStoreFailures ?? 0);
    counts.unknownCallSafetyFailures = Number(ledger.safety?.unknownCallFailures ?? 0);
    for (const row of ledger.ledger ?? []) {
      counts.exactEffects += Number(row.completeness?.exact ?? 0) + Number(row.completeness?.exactWithIntrinsic ?? 0);
      counts.partialEffects += Number(row.completeness?.partial ?? 0);
      counts.unsupportedEffects += Number(row.completeness?.unsupported ?? 0) + Number(row.completeness?.unknown ?? 0);
      if (row.status === 'PASS') continue;
      const stage = row.firstDivergence?.stage ?? 'unknown';
      if (stage === 'decode' || stage === 'decoder-differential') counts.decoderMismatches += 1;
      else if (stage === 'provenance') counts.provenanceLosses += 1;
      else counts.semanticMismatches += 1;
      addFailure(`corpus-${stage}`,
        `${row.fixture} / ${row.category}`,
        String(row.firstDivergence?.expected ?? 'pass'),
        JSON.stringify(row.firstDivergence?.actual ?? row.status).slice(0, 400),
        `${row.target}|${row.optimization}|${row.category}`);
    }
    if (counts.missingCases > 0) {
      addFailure('missing-corpus-coverage', 'fewer mandatory tuples were instantiated than the frozen profile requires',
        expectedCases, counts.instantiatedCases, PROFILE.corpus.id);
    }
  }

  const neutralityGate = gates.find((gate) => gate.id === 'phase6-generic-core');
  if (neutralityGate?.status === 'FAIL') counts.architectureNeutralityViolations += 1;
  const crossGate = gates.find((gate) => gate.id === 'phase6-cross-architecture');
  if (crossGate?.status === 'FAIL') counts.crossArchitectureMismatches += 1;

  const abiGate = gates.find((gate) => gate.id === 'phase6-abi');
  if (abiGate?.status === 'FAIL') counts.abiMismatches += 1;
  const elfGate = gates.find((gate) => gate.id === 'phase6-elf');
  if (elfGate?.status === 'FAIL') counts.elfMismatches += 1;

  const blockingFailures = failures.filter((failure) => failure.blocking);
  const verdict = blockingFailures.length === 0 && counts.instantiatedCases === expectedCases
    ? 'READY'
    : (shadow && counts.instantiatedCases === 0 ? 'NOT-INTEGRATED' : 'BLOCKING');

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    verifierVersion: PROFILE.verifierVersion,
    verdict,
    generatedAt: new Date(0).toISOString(),
    product,
    identities: {
      profileVersion: PROFILE.profileVersion,
      isaProfile: PROFILE.isaProfile.id,
      abiProfiles: PROFILE.abiProfiles.supported.map((entry) => entry.id),
      toolchain: ledger?.toolchain ?? { id: PROFILE.toolchain.id, observed: null },
      decoderArtifacts,
      architectureSemanticVersion: PROFILE.semanticVersions.architecture,
      abiSemanticVersion: PROFILE.semanticVersions.abi,
      corpusId: PROFILE.corpus.id,
      corpusDigest: ledger?.corpusDigest ?? '0'.repeat(64),
    },
    counts,
    gates,
    failures,
  });
}

export function validateEvidence(report) {
  const errors = [];
  if (report?.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion must match the frozen evidence schema');
  if (!/^[0-9a-f]{40}$/.test(String(report?.product?.commitSha ?? ''))) errors.push('product.commitSha must be an exact 40-character SHA');
  if (!/^[0-9a-f]{64}$/.test(String(report?.identities?.corpusDigest ?? ''))) errors.push('identities.corpusDigest must be a sha256 digest');
  if (!Array.isArray(report?.gates) || report.gates.length === 0) errors.push('gates must be a non-empty array');
  if (!report?.counts || typeof report.counts !== 'object') errors.push('counts must be present');
  else for (const [key, value] of Object.entries(zeroCounts())) {
    void value;
    if (!Number.isInteger(report.counts[key])) errors.push(`counts.${key} must be an integer`);
  }
  if (!['READY', 'BLOCKING', 'NOT-INTEGRATED'].includes(report?.verdict)) errors.push('verdict must be READY, BLOCKING or NOT-INTEGRATED');
  if (report?.verdict === 'READY') {
    if (report.counts.firstDivergenceCount !== 0) errors.push('READY requires firstDivergenceCount = 0');
    if (report.counts.missingCases !== 0) errors.push('READY requires no missing mandatory coverage');
    if (report.counts.hiddenFallbacks !== 0) errors.push('READY requires zero hidden fallbacks');
    if (report.counts.provenanceLosses !== 0) errors.push('READY requires zero provenance losses');
    if (report.counts.architectureNeutralityViolations !== 0) errors.push('READY requires zero architecture-neutrality violations');
    if (!report.product.workingTreeClean) errors.push('READY requires a clean working tree');
    if (report.identities.decoderArtifacts.some((artifact) => !artifact.matchesFrozenProfile)) {
      errors.push('READY requires the deployed decoder to match the frozen profile');
    }
  }
  return errors;
}

export function renderMarkdown(report) {
  const lines = [
    '# Phase 6 release evidence',
    '',
    `**Verdict: ${report.verdict}**`,
    '',
    `- verifier: \`${report.verifierVersion}\``,
    `- product commit: \`${report.product.commitSha}\``,
    `- product tree: \`${report.product.treeSha}\``,
    `- working tree clean: ${report.product.workingTreeClean}`,
    `- ISA profile: \`${report.identities.isaProfile}\``,
    `- ABI profiles: ${report.identities.abiProfiles.map((id) => `\`${id}\``).join(', ')}`,
    `- corpus: \`${report.identities.corpusId}\` digest \`${report.identities.corpusDigest}\``,
    `- architecture semantic version: \`${report.identities.architectureSemanticVersion}\``,
    '',
    '## Decoder artifacts',
    '',
    '| artifact | sha256 | matches frozen profile |',
    '|---|---|---|',
    ...report.identities.decoderArtifacts.map((artifact) => `| \`${artifact.path}\` | \`${artifact.sha256}\` | ${artifact.matchesFrozenProfile} |`),
    '',
    '## Gates',
    '',
    '| gate | status | detail |',
    '|---|---|---|',
    ...report.gates.map((gate) => `| ${gate.id} | ${gate.status} | ${gate.detail} |`),
    '',
    '## Counts',
    '',
    '| count | value |',
    '|---|---|',
    ...Object.entries(report.counts).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## Failures',
    '',
  ];
  if (report.failures.length === 0) lines.push('None.');
  else {
    lines.push('| category | first divergence | expected | actual | identity | blocking |', '|---|---|---|---|---|---|');
    for (const failure of report.failures) {
      lines.push(`| ${failure.category} | ${failure.firstDivergence} | ${failure.expected} | ${String(failure.actual).replaceAll('|', '\\|')} | ${failure.identity} | ${failure.blocking} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Write atomically: validate, write to a temp file, then rename into place. */
function publish(report, outputDirectory) {
  const errors = validateEvidence(report);
  if (errors.length) throw new Error(`Phase 6 evidence failed its own schema: ${errors.join('; ')}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, content] of [['phase6-release-evidence.json', `${JSON.stringify(report, null, 2)}\n`], ['phase6-release-evidence.md', renderMarkdown(report)]]) {
    const target = path.join(outputDirectory, name);
    const temporary = path.join(outputDirectory, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, content);
    if (fs.statSync(temporary).size === 0) { fs.rmSync(temporary, { force: true }); throw new Error(`refusing to publish an empty artifact: ${name}`); }
    fs.renameSync(temporary, target);
  }
  return outputDirectory;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const shadow = argv.includes('--shadow');
  const expectedShaIndex = argv.indexOf('--expect-sha');
  const expectedSha = expectedShaIndex >= 0 ? argv[expectedShaIndex + 1] : null;
  const outputIndex = argv.indexOf('--out');
  const outputDirectory = path.resolve(ROOT, outputIndex >= 0 ? argv[outputIndex + 1] : 'reports/phase6');
  let report;
  try {
    report = verifyPhase6({ shadow, expectedSha });
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
    report = null;
  }
  if (report) {
    try {
      publish(report, outputDirectory);
      console.log(`P6_VERDICT=${report.verdict}`);
      console.log(`P6_EVIDENCE=${path.relative(ROOT, outputDirectory)}/phase6-release-evidence.json`);
      console.log(renderMarkdown(report));
      // Shadow mode reports the truth without failing the surrounding job, so
      // the verifier can run from the first checkpoint onward.
      process.exitCode = shadow || report.verdict === 'READY' ? 0 : 1;
    } catch (error) {
      console.error(error?.stack ?? String(error));
      process.exitCode = 2;
    }
  }
}
