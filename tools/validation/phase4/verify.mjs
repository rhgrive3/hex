import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runVerificationOracles } from '../../../tests/phase4/verification/oracles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_DIR = path.join(ROOT, 'reports/phase4');
const REQUIRED_RAW_COUNTERS = Object.freeze([
  'determinismFailures',
  'underInvalidationFailures',
  'overInvalidationFailures',
  'corruptionAcceptanceFailures',
  'partialPublishFailures',
  'warmUnexpectedProducerInvocations',
  'coalescingFailures',
  'cancellationFailures',
  'wholeFileMaterializationFailures',
  'coldWarmMismatchCount',
  'ownershipViolations',
]);
const FIRST_DIVERGENCE = Object.freeze({
  A: 'ArtifactKey',
  B: 'producer normalization',
  C: 'dependency identity',
  D: 'scheduler',
  E: 'cancellation/budget',
  F: 'persistent write',
  G: 'persistent read',
  H: 'hot cache',
  I: 'project index',
  J: 'paging',
  K: 'migration',
  L: 'packaging/CI',
  M: 'unrelated main change',
});

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function git(args, fallback = null) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : fallback;
}

function command(label, executable, args, { timeoutMs = 20 * 60_000, env = process.env } = {}) {
  const started = Date.now();
  const child = spawnSync(executable, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    label,
    command: [executable, ...args].join(' '),
    passed: child.status === 0,
    status: child.status,
    signal: child.signal ?? null,
    timedOut: child.error?.code === 'ETIMEDOUT',
    elapsedMs: Date.now() - started,
    stdout: String(child.stdout || ''),
    stderr: String(child.stderr || ''),
  };
}

function publicCommand(result) {
  return {
    label: result.label,
    command: result.command,
    passed: result.passed,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    stdoutTail: result.stdout.slice(-12_000),
    stderrTail: result.stderr.slice(-12_000),
  };
}

function walkFiles(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relativePath.replaceAll('\\', '/')];
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) out.push(...walkFiles(child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function staticAudit() {
  const findings = [];
  const jsFiles = walkFiles('js').filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));

  // One ArtifactId algorithm only. Imports/calls are intentionally not findings.
  const artifactDefinitions = [];
  const definitionPattern = /(?:function\s+createArtifactId\b|(?:const|let|var)\s+createArtifactId\s*=|class\s+ArtifactId\b)/g;
  for (const file of jsFiles) {
    const matches = read(file).match(definitionPattern) || [];
    for (const match of matches) artifactDefinitions.push({ file, match });
  }
  const secondArtifactDefinitions = artifactDefinitions.filter((entry) => entry.file !== 'js/core/identity/index.js');
  if (secondArtifactDefinitions.length) {
    findings.push({
      id: 'second-artifact-id-definition', category: 'A', ownerLane: 'p4-0', repairLane: 'p4-7', blocker: true,
      status: 'NOT-INTEGRATED / BLOCKING', count: secondArtifactDefinitions.length, evidence: secondArtifactDefinitions,
    });
  }

  // A second semantic analysis scheduler/work queue is a release blocker. I/O page queues are not.
  const schedulerDefinitions = [];
  const schedulerPattern = /(?:class\s+AnalysisScheduler\b|(?:const|let|var)\s+analysisQueue\s*=|this\.analysisQueue\s*=|analysisQueue\.push\s*\()/g;
  for (const file of jsFiles) {
    if (file === 'js/core/scheduler/index.js') continue;
    const matches = read(file).match(schedulerPattern) || [];
    for (const match of matches) schedulerDefinitions.push({ file, match });
  }
  if (schedulerDefinitions.length) {
    findings.push({
      id: 'second-analysis-scheduler-or-work-queue', category: 'K', ownerLane: 'p4-5', repairLane: 'p4-7', blocker: true,
      status: 'NOT-INTEGRATED / BLOCKING', count: schedulerDefinitions.length, evidence: schedulerDefinitions,
    });
  }

  // P4-5 must cut compatible production orchestration over to ArtifactStore/scheduler.
  const migrationPaths = [
    ...walkFiles('js/cache'),
    'js/backend.js', 'js/worker.js', 'js/worker-legacy.js', 'js/worker-budget.js',
  ].filter((file) => fs.existsSync(path.join(ROOT, file)));
  const legacyCacheEvidence = [];
  const hiddenFallbackEvidence = [];
  for (const file of migrationPaths) {
    const source = read(file);
    if (/\bAnalysisCache\b/.test(source)) legacyCacheEvidence.push({ file, pattern: 'AnalysisCache' });
    if (/legacy-macho|legacy[-_ ]fallback|fallback.*analysis|analysis.*fallback/i.test(source)) {
      hiddenFallbackEvidence.push({ file, pattern: 'legacy/fallback analysis path' });
    }
  }
  if (legacyCacheEvidence.length) {
    findings.push({
      id: 'legacy-analysis-cache-production-path', category: 'K', ownerLane: 'p4-5', repairLane: 'p4-7', blocker: true,
      status: 'NOT-INTEGRATED / BLOCKING', count: legacyCacheEvidence.length, evidence: legacyCacheEvidence,
    });
  }
  if (hiddenFallbackEvidence.length) {
    findings.push({
      id: 'hidden-fallback-candidates', category: 'K', ownerLane: 'p4-5', repairLane: 'p4-7', blocker: true,
      status: 'NOT-INTEGRATED / BLOCKING', count: hiddenFallbackEvidence.length, evidence: hiddenFallbackEvidence,
    });
  }

  // P4-6 lives below tests/phase4/verification. The existing Phase 4 runner must actually recurse or import it.
  const phase4Runner = read('tests/phase4/run.mjs');
  const packageJson = read('package.json');
  const releaseWorkflowPath = '.github/workflows/phase4-release-validation.yml';
  const releaseWorkflow = fs.existsSync(path.join(ROOT, releaseWorkflowPath)) ? read(releaseWorkflowPath) : '';
  const nestedVerificationWired = /phase4\/verification|validation\/phase4\/verify\.mjs/.test(phase4Runner)
    || /validation\/phase4\/verify\.mjs/.test(packageJson)
    || /validation\/phase4\/verify\.mjs/.test(releaseWorkflow);
  if (!nestedVerificationWired) {
    findings.push({
      id: 'phase4-verifier-not-wired-to-release-ci', category: 'L', ownerLane: 'p4-7', repairLane: 'p4-7', blocker: true,
      status: 'NOT-INTEGRATED / BLOCKING', count: 1,
      evidence: [
        { file: 'tests/phase4/run.mjs', detail: 'current runner discovers direct test files only' },
        { file: 'package.json', detail: 'no Phase 4 verification runner script' },
        { file: releaseWorkflowPath, detail: 'release workflow does not invoke tools/validation/phase4/verify.mjs' },
      ],
    });
  }

  return { findings, artifactDefinitions, schedulerDefinitions, migrationPaths, nestedVerificationWired };
}

function parseJsonLog(output, prefix) {
  const lines = String(output || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const index = line.indexOf(prefix);
    if (index < 0) continue;
    const text = line.slice(index + prefix.length).trim();
    try { return JSON.parse(text); } catch { /* continue */ }
  }
  return null;
}

function phase3From(irRun, semanticV2Run) {
  const irMatch = /(\d+) passed,\s*(\d+) failed/.exec(`${irRun.stdout}\n${irRun.stderr}`);
  const current = parseJsonLog(semanticV2Run.stdout, '[phase3-current-corpus]');
  const finalEvidence = parseJsonLog(semanticV2Run.stdout, '[phase3-final-evidence]');
  const release = parseJsonLog(semanticV2Run.stdout, '[phase3-release-report]');
  const result = {
    ir: {
      expected: 30,
      passed: irMatch ? Number(irMatch[1]) : null,
      failed: irMatch ? Number(irMatch[2]) : null,
      satisfied: irRun.passed && irMatch != null && Number(irMatch[1]) === 30 && Number(irMatch[2]) === 0,
    },
    semantic: {
      expected: 11,
      passed: current?.semantic?.passed ?? release?.semanticCommandResult?.passed ?? null,
      failed: current?.semantic?.failed ?? release?.semanticCommandResult?.failed ?? null,
      satisfied: semanticV2Run.passed && (current?.semantic?.passed ?? release?.semanticCommandResult?.passed) === 11
        && (current?.semantic?.failed ?? release?.semanticCommandResult?.failed) === 0,
    },
    decompiler: {
      expected: 14,
      passed: current?.decompiler?.passed ?? release?.decompilerCommandResult?.passed ?? null,
      failed: current?.decompiler?.failed ?? release?.decompilerCommandResult?.failed ?? null,
      satisfied: semanticV2Run.passed && (current?.decompiler?.passed ?? release?.decompilerCommandResult?.passed) === 14
        && (current?.decompiler?.failed ?? release?.decompilerCommandResult?.failed) === 0,
    },
    v1Differential: {
      expected: 25,
      matched: release?.v1DifferentialMatchCount ?? finalEvidence?.differentialMatchCount ?? null,
      mismatches: release?.mismatchCount ?? finalEvidence?.mismatchCount ?? null,
      satisfied: (release?.v1DifferentialMatchCount ?? finalEvidence?.differentialMatchCount) === 25
        && (release?.mismatchCount ?? finalEvidence?.mismatchCount) === 0,
    },
    provenanceLossCount: release?.provenanceLossCount ?? finalEvidence?.provenanceLossCount ?? null,
    unknownStoreSafetyFailures: release?.unknownStoreSafetyFailures ?? null,
    unknownCallSafetyFailures: release?.unknownCallSafetyFailures ?? null,
    deterministicProductionChain: release?.deterministicProductionChain ?? finalEvidence?.deterministic ?? null,
    source: 'current executable Phase 3 evidence emitted by tests/semantic-v2/run.mjs',
  };
  result.satisfied = result.ir.satisfied
    && result.semantic.satisfied
    && result.decompiler.satisfied
    && result.v1Differential.satisfied
    && result.provenanceLossCount === 0
    && result.unknownStoreSafetyFailures === 0
    && result.unknownCallSafetyFailures === 0
    && result.deterministicProductionChain === true;
  return result;
}

function dynamicFirstDivergences(oracles) {
  const failures = oracles.verificationCases.filter((item) => item.status !== 'pass');
  return failures.map((item) => ({
    category: item.category,
    categoryName: FIRST_DIVERGENCE[item.category],
    case: item.name,
    ownerLane: item.ownerLane,
    repairLane: item.ownerLane === 'p4-0' ? 'p4-7' : item.ownerLane,
    status: 'BLOCKING',
    error: item.error || null,
  }));
}

function mergeRawFailures(oracles, ownershipRun) {
  const raw = { ...oracles.rawFailures };
  for (const name of REQUIRED_RAW_COUNTERS) if (!Number.isSafeInteger(raw[name])) raw[name] = 0;
  raw.ownershipViolations = ownershipRun.passed ? 0 : 1;
  return raw;
}

function makeMarkdown(report) {
  const failures = Object.entries(report.rawFailures).filter(([, value]) => Number(value) > 0);
  const lines = [
    '# Phase 4 Independent Verification Report',
    '',
    `- Base: \`${report.baseSha}\``,
    `- Head: \`${report.headSha}\``,
    `- Decision: **${report.integrationDecision}**`,
    `- Verification cases: ${report.verificationCases.length}`,
    '',
    '## Raw failures',
    '',
  ];
  if (!failures.length) lines.push('- none');
  else for (const [name, value] of failures) lines.push(`- ${name}: ${value}`);
  lines.push('', '## First divergences', '');
  if (!report.firstDivergences.length) lines.push('- none');
  else for (const item of report.firstDivergences) {
    lines.push(`- ${item.category} ${item.categoryName}: ${item.case || item.id} — ${item.status} — owner ${item.ownerLane}${item.repairLane && item.repairLane !== item.ownerLane ? `; repair ${item.repairLane}` : ''}`);
  }
  lines.push('', '## Phase 3 regression oracle', '', '```json', JSON.stringify(report.phase3, null, 2), '```', '');
  lines.push('## Scaling', '', '```json', JSON.stringify(report.performance.scaling, null, 2), '```', '');
  lines.push('## Validation commands', '');
  for (const item of report.validation) lines.push(`- ${item.passed ? 'PASS' : 'FAIL'} — \`${item.command}\` (${item.elapsedMs} ms)`);
  lines.push('');
  return lines.join('\n');
}

const baseSha = arg('base', process.env.PHASE4_BASE || '9c67832485f8e9b6101915d460fae2a74bccfec5');
const headSha = arg('head', git(['rev-parse', 'HEAD'], 'unknown'));
const noCommands = process.argv.includes('--no-commands');

const oracles = await runVerificationOracles();
const audit = staticAudit();

const irRun = noCommands
  ? { label: 'tests/ir.mjs', command: 'node tests/ir.mjs', passed: false, status: null, signal: null, timedOut: false, elapsedMs: 0, stdout: '', stderr: 'NOT-RUN (--no-commands)' }
  : command('Phase 3 IR', process.execPath, ['tests/ir.mjs']);
const semanticV2Run = noCommands
  ? { label: 'semantic-v2:test', command: 'npm run semantic-v2:test', passed: false, status: null, signal: null, timedOut: false, elapsedMs: 0, stdout: '', stderr: 'NOT-RUN (--no-commands)' }
  : command('Phase 3 semantic evidence + semantic-v2', 'npm', ['run', 'semantic-v2:test']);

const requiredCommands = noCommands ? [] : [
  command('npm run check', 'npm', ['run', 'check']),
  // Run these independently even though check also contains them. The release oracle records each gate separately.
  command('npm run invariants:test', 'npm', ['run', 'invariants:test']),
  command('npm run migration:test', 'npm', ['run', 'migration:test']),
];
const ownershipRun = noCommands
  ? { label: 'ownership gate', command: `node tools/validation/phase4-ownership.mjs --lane p4-6 --base ${baseSha}`, passed: false, status: null, signal: null, timedOut: false, elapsedMs: 0, stdout: '', stderr: 'NOT-RUN (--no-commands)' }
  : command('ownership gate', process.execPath, ['tools/validation/phase4-ownership.mjs', '--lane', 'p4-6', '--base', baseSha]);

const validationRuns = [irRun, semanticV2Run, ...requiredCommands, ownershipRun];
const rawFailures = mergeRawFailures(oracles, ownershipRun);
const dynamicDivergences = dynamicFirstDivergences(oracles);
const staticDivergences = audit.findings.filter((item) => item.blocker).map((item) => ({
  category: item.category,
  categoryName: FIRST_DIVERGENCE[item.category],
  id: item.id,
  ownerLane: item.ownerLane,
  repairLane: item.repairLane,
  status: item.status,
  evidence: item.evidence,
}));
const phase3 = phase3From(irRun, semanticV2Run);
const validationFailures = validationRuns.filter((item) => !item.passed);
const rawFailureTotal = Object.values(rawFailures).reduce((sum, value) => sum + (Number(value) || 0), 0);
const blockers = [...dynamicDivergences, ...staticDivergences];
if (!phase3.satisfied) blockers.push({ category: 'M', categoryName: FIRST_DIVERGENCE.M, id: 'phase3-regression-oracle', ownerLane: 'integration', repairLane: 'p4-7', status: 'BLOCKING' });
if (validationFailures.length) blockers.push({ category: 'L', categoryName: FIRST_DIVERGENCE.L, id: 'required-validation-command-failure', ownerLane: 'integration', repairLane: 'p4-7', status: 'BLOCKING', evidence: validationFailures.map((item) => item.command) });

const report = {
  schemaVersion: 1,
  phase: 4,
  lane: 'p4-6-artifact-verification',
  baseSha,
  headSha,
  generatedAt: new Date().toISOString(),
  integrationDecision: blockers.length || rawFailureTotal ? 'NOT-INTEGRATED / BLOCKING' : 'READY-FOR-P4-7-INTEGRATION',
  verificationCases: oracles.verificationCases,
  rawFailures,
  performance: oracles.performance,
  firstDivergences: blockers,
  productionBlockersByOwnerLane: Object.groupBy
    ? Object.groupBy(blockers, (item) => item.ownerLane || 'unknown')
    : blockers.reduce((out, item) => { const key = item.ownerLane || 'unknown'; (out[key] ||= []).push(item); return out; }, {}),
  staticAudit: audit,
  phase3,
  validation: validationRuns.map(publicCommand),
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
const stem = `verification-${String(headSha).slice(0, 12) || 'unknown'}`;
const jsonPath = path.join(REPORT_DIR, `${stem}.json`);
const mdPath = path.join(REPORT_DIR, `${stem}.md`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(mdPath, makeMarkdown(report));
console.log(`PHASE4_VERIFICATION_REPORT ${path.relative(ROOT, jsonPath)} ${report.integrationDecision}`);
console.log(JSON.stringify({ baseSha, headSha, integrationDecision: report.integrationDecision, rawFailures, firstDivergenceCount: blockers.length, phase3: phase3.satisfied }));
if (report.integrationDecision !== 'READY-FOR-P4-7-INTEGRATION') process.exitCode = 1;
