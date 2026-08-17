import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runVerificationOracles } from '../../../tests/phase4/verification/oracles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_DIR = path.join(ROOT, 'reports/phase4');
const REQUIRED_RAW_COUNTERS = Object.freeze([
  'determinismFailures', 'underInvalidationFailures', 'overInvalidationFailures',
  'corruptionAcceptanceFailures', 'partialPublishFailures', 'warmUnexpectedProducerInvocations',
  'coalescingFailures', 'cancellationFailures', 'wholeFileMaterializationFailures',
  'coldWarmMismatchCount', 'ownershipViolations',
]);
const FIRST_DIVERGENCE = Object.freeze({
  A: 'ArtifactKey', B: 'producer normalization', C: 'dependency identity', D: 'scheduler',
  E: 'cancellation/budget', F: 'persistent write', G: 'persistent read', H: 'hot cache',
  I: 'project index', J: 'paging', K: 'migration', L: 'packaging/CI', M: 'unrelated main change',
});

function arg(name, fallback = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; }
function git(args, fallback = null) { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? String(r.stdout || '').trim() : fallback; }
function command(label, executable, args, timeoutMs = 20 * 60_000) {
  const started = Date.now();
  const child = spawnSync(executable, args, { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs });
  return {
    label, command: [executable, ...args].join(' '), passed: child.status === 0, status: child.status,
    signal: child.signal ?? null, timedOut: child.error?.code === 'ETIMEDOUT', elapsedMs: Date.now() - started,
    stdout: String(child.stdout || ''), stderr: String(child.stderr || ''),
  };
}
function publicCommand(result) {
  return {
    label: result.label, command: result.command, passed: result.passed, status: result.status, signal: result.signal,
    timedOut: result.timedOut, elapsedMs: result.elapsedMs,
    stdoutTail: result.stdout.slice(-12_000), stderrTail: result.stderr.slice(-12_000),
  };
}
function walkFiles(relative) {
  const absolute = path.join(ROOT, relative); if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [relative.replaceAll('\\', '/')];
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) out.push(...walkFiles(child)); else if (entry.isFile()) out.push(child);
  }
  return out;
}
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
function blocker(id, category, ownerLane, repairLane, evidence) {
  return { id, category, ownerLane, repairLane, blocker: true, status: 'NOT-INTEGRATED / BLOCKING', count: evidence.length, evidence };
}

function staticAudit() {
  const findings = [];
  const jsFiles = walkFiles('js').filter((file) => /\.(?:m?js)$/.test(file));

  const artifactDefinitions = [];
  const artifactDefinitionPattern = /(?:function\s+createArtifactId\b|(?:const|let|var)\s+createArtifactId\s*=|class\s+ArtifactId\b)/g;
  for (const file of jsFiles) for (const match of read(file).match(artifactDefinitionPattern) || []) artifactDefinitions.push({ file, match });
  const duplicateArtifactDefinitions = artifactDefinitions.filter((entry) => entry.file !== 'js/core/identity/index.js');
  if (duplicateArtifactDefinitions.length) findings.push(blocker('second-artifact-id-definition', 'A', 'p4-0', 'p4-7', duplicateArtifactDefinitions));

  // P4-7 intentionally keeps the frozen public scheduler entrypoint tiny and
  // re-exports exactly one hardened implementation. That implementation is the
  // canonical scheduler, not a second scheduler. Any additional definition or
  // semantic analysisQueue remains blocking.
  const schedulerIndex = read('js/core/scheduler/index.js');
  const canonicalSchedulerReexport = /export\s*\{\s*AnalysisScheduler\s*\}\s*from\s*['"]\.\/analysis-scheduler\.js['"]/.test(schedulerIndex);
  const canonicalSchedulerPath = canonicalSchedulerReexport ? 'js/core/scheduler/analysis-scheduler.js' : null;
  const schedulerDefinitions = [];
  const schedulerPattern = /(?:class\s+AnalysisScheduler\b|(?:const|let|var)\s+analysisQueue\s*=|this\.analysisQueue\s*=|analysisQueue\.push\s*\()/g;
  for (const file of jsFiles) {
    if (file === 'js/core/scheduler/index.js' || file === canonicalSchedulerPath) continue;
    for (const match of read(file).match(schedulerPattern) || []) schedulerDefinitions.push({ file, match });
  }
  if (!canonicalSchedulerReexport) {
    findings.push(blocker('canonical-hardened-scheduler-not-wired', 'D', 'p4-7', 'p4-7', [
      { file: 'js/core/scheduler/index.js', pattern: "canonical AnalysisScheduler re-export from './analysis-scheduler.js' missing" },
    ]));
  }
  if (schedulerDefinitions.length) findings.push(blocker('second-analysis-scheduler-or-work-queue', 'K', 'p4-5', 'p4-7', schedulerDefinitions));

  // A retained explicit current-route compatibility cache is not an artifact
  // fallback. It becomes a blocker only if the canonical artifact runtime uses
  // it, or if production contains an automatic artifact -> current fallback.
  const migrationPaths = [...walkFiles('js/cache'), 'js/backend.js', 'js/worker.js', 'js/worker-legacy.js', 'js/worker-budget.js']
    .filter((file) => fs.existsSync(path.join(ROOT, file)));
  const artifactRuntimeSource = fs.existsSync(path.join(ROOT, 'js/cache/artifact-orchestration.js')) ? read('js/cache/artifact-orchestration.js') : '';
  const backendSource = fs.existsSync(path.join(ROOT, 'js/backend.js')) ? read('js/backend.js') : '';
  const legacyCacheEvidence = [];
  if (/\bAnalysisCache\b/.test(artifactRuntimeSource)) legacyCacheEvidence.push({ file: 'js/cache/artifact-orchestration.js', pattern: 'AnalysisCache used by artifact runtime' });
  if (legacyCacheEvidence.length) findings.push(blocker('legacy-analysis-cache-production-path', 'K', 'p4-5', 'p4-7', legacyCacheEvidence));
  const hiddenFallbackEvidence = [];
  const automaticFallback = /try\s*\{[\s\S]{0,4000}(?:_analyzeArtifact|ANALYSIS_ORCHESTRATION_ROUTE\.ARTIFACT)[\s\S]{0,4000}\}\s*catch[\s\S]{0,1500}(?:_analyzeCurrent|ANALYSIS_ORCHESTRATION_ROUTE\.CURRENT)/;
  if (automaticFallback.test(backendSource)) hiddenFallbackEvidence.push({ file: 'js/backend.js', pattern: 'automatic artifact-to-current catch fallback' });
  if (/allowMemoryFallback\s*:\s*true/.test(artifactRuntimeSource)) hiddenFallbackEvidence.push({ file: 'js/cache/artifact-orchestration.js', pattern: 'implicit persistent-store memory fallback' });
  if (hiddenFallbackEvidence.length) findings.push(blocker('hidden-artifact-fallback-candidates', 'K', 'p4-5', 'p4-7', hiddenFallbackEvidence));

  const schedulerSource = schedulerIndex;
  if (schedulerSource.includes('dependencyResults.push(await this.#request(dependency,ancestry));')) {
    findings.push(blocker('dependency-cancellation-signal-not-linked', 'E', 'p4-2', 'p4-7', [
      { file: 'js/core/scheduler/index.js', pattern: 'this.#request(dependency, ancestry) without parent task.controller.signal linkage' },
    ]));
  }

  const projectSource = read('js/project/index.js');
  const artifactIndexSource = read('js/project/artifact-index.js');
  const publicBoundarySanitizes = /isArtifactRef/.test(projectSource) && /sanitizeCacheReferences/.test(projectSource) && /toProjectReferences/.test(projectSource);
  const projectAcceptsRawCacheReferences = /cacheReferences:\s*list\(/.test(projectSource) && !publicBoundarySanitizes;
  const refLayerRejectsPayload = /!Object\.hasOwn\(value,\s*'payload'\)/.test(artifactIndexSource);
  if (projectAcceptsRawCacheReferences && refLayerRejectsPayload) {
    findings.push(blocker('hexproj-cache-reference-boundary-bypass', 'I', 'p4-7', 'p4-7', [
      { file: 'js/project/index.js', pattern: 'analysis.cacheReferences accepts arbitrary entries before serialization' },
      { file: 'js/project/artifact-index.js', pattern: 'isArtifactRef rejects payload/record, but project serializer does not enforce it' },
    ]));
  }

  const phase4Runner = read('tests/phase4/run.mjs'); const packageJson = read('package.json');
  const releaseWorkflowPath = '.github/workflows/phase4-release-validation.yml';
  const releaseWorkflow = fs.existsSync(path.join(ROOT, releaseWorkflowPath)) ? read(releaseWorkflowPath) : '';
  const runnerWired = /phase4\/verification|verification\/oracles\.mjs/.test(phase4Runner);
  const packageWired = /validation\/phase4\/verify\.mjs/.test(packageJson);
  const releaseWired = /validation\/phase4\/verify\.mjs|phase4:verify/.test(releaseWorkflow) && /independent-verifier/.test(releaseWorkflow);
  const verificationWired = runnerWired && packageWired && releaseWired;
  if (!verificationWired) findings.push(blocker('phase4-verifier-not-wired-to-release-ci', 'L', 'p4-7', 'p4-7', [
    ...(!runnerWired ? [{ file: 'tests/phase4/run.mjs', detail: 'canonical Phase 4 runner does not execute verification oracles' }] : []),
    ...(!packageWired ? [{ file: 'package.json', detail: 'no independent Phase 4 verifier script' }] : []),
    ...(!releaseWired ? [{ file: releaseWorkflowPath, detail: 'permanent exact-SHA workflow does not hard-gate independent verifier' }] : []),
  ]));

  return { findings, artifactDefinitions, schedulerDefinitions, canonicalSchedulerPath, migrationPaths, verificationWired };
}

function parseJsonLog(output, prefix) {
  for (const line of String(output || '').split(/\r?\n/).reverse()) {
    const index = line.indexOf(prefix); if (index < 0) continue;
    try { return JSON.parse(line.slice(index + prefix.length).trim()); } catch { /* continue */ }
  }
  return null;
}

function phase3From(irRun, semanticV2Run) {
  const irMatch = /(\d+) passed,\s*(\d+) failed/.exec(`${irRun.stdout}\n${irRun.stderr}`);
  const current = parseJsonLog(semanticV2Run.stdout, '[phase3-current-corpus]');
  const finalEvidence = parseJsonLog(semanticV2Run.stdout, '[phase3-final-evidence]');
  const release = parseJsonLog(semanticV2Run.stdout, '[phase3-release-report]');
  const result = {
    ir: { expected: 30, passed: irMatch ? Number(irMatch[1]) : null, failed: irMatch ? Number(irMatch[2]) : null },
    semantic: { expected: 11, passed: current?.semantic?.passed ?? release?.semanticCommandResult?.passed ?? null, failed: current?.semantic?.failed ?? release?.semanticCommandResult?.failed ?? null },
    decompiler: { expected: 14, passed: current?.decompiler?.passed ?? release?.decompilerCommandResult?.passed ?? null, failed: current?.decompiler?.failed ?? release?.decompilerCommandResult?.failed ?? null },
    v1Differential: { expected: 25, matched: release?.v1DifferentialMatchCount ?? finalEvidence?.differentialMatchCount ?? null, mismatches: release?.mismatchCount ?? finalEvidence?.mismatchCount ?? null },
    provenanceLossCount: release?.provenanceLossCount ?? finalEvidence?.provenanceLossCount ?? null,
    unknownStoreSafetyFailures: release?.unknownStoreSafetyFailures ?? null,
    unknownCallSafetyFailures: release?.unknownCallSafetyFailures ?? null,
    deterministicProductionChain: release?.deterministicProductionChain ?? finalEvidence?.deterministic ?? null,
    source: 'current executable Phase 3 evidence emitted by tests/semantic-v2/run.mjs',
  };
  result.ir.satisfied = irRun.passed && result.ir.passed === 30 && result.ir.failed === 0;
  result.semantic.satisfied = semanticV2Run.passed && result.semantic.passed === 11 && result.semantic.failed === 0;
  result.decompiler.satisfied = semanticV2Run.passed && result.decompiler.passed === 14 && result.decompiler.failed === 0;
  result.v1Differential.satisfied = result.v1Differential.matched === 25 && result.v1Differential.mismatches === 0;
  result.satisfied = result.ir.satisfied && result.semantic.satisfied && result.decompiler.satisfied && result.v1Differential.satisfied
    && result.provenanceLossCount === 0 && result.unknownStoreSafetyFailures === 0 && result.unknownCallSafetyFailures === 0
    && result.deterministicProductionChain === true;
  return result;
}

function dynamicDivergences(oracles) {
  return oracles.verificationCases.filter((item) => item.status !== 'pass').map((item) => ({
    category: item.category, categoryName: FIRST_DIVERGENCE[item.category], case: item.name,
    ownerLane: item.ownerLane, repairLane: item.ownerLane === 'p4-0' ? 'p4-7' : item.ownerLane,
    status: 'BLOCKING', error: item.error || null,
  }));
}
function rawFailures(oracles, ownershipRun) {
  const raw = { ...oracles.rawFailures };
  for (const name of REQUIRED_RAW_COUNTERS) if (!Number.isSafeInteger(raw[name])) raw[name] = 0;
  raw.ownershipViolations = ownershipRun.passed ? 0 : 1;
  return raw;
}
function markdown(report) {
  const lines = [
    '# Phase 4 Independent Verification Report', '', `- Base: \`${report.baseSha}\``, `- Ownership base: \`${report.ownershipBaseSha}\``, `- Head: \`${report.headSha}\``,
    `- Decision: **${report.integrationDecision}**`, `- Verification cases: ${report.verificationCases.length}`, '', '## Raw failures', '',
  ];
  const failures = Object.entries(report.rawFailures).filter(([, value]) => Number(value) > 0);
  if (!failures.length) lines.push('- none'); else for (const [name, value] of failures) lines.push(`- ${name}: ${value}`);
  lines.push('', '## First divergences', '');
  if (!report.firstDivergences.length) lines.push('- none'); else for (const item of report.firstDivergences) lines.push(`- ${item.category} ${item.categoryName}: ${item.case || item.id} — ${item.status} — owner ${item.ownerLane}`);
  lines.push('', '## Phase 3 regression oracle', '', '```json', JSON.stringify(report.phase3, null, 2), '```', '', '## Scaling', '', '```json', JSON.stringify(report.performance.scaling, null, 2), '```', '', '## Validation commands', '');
  for (const item of report.validation) lines.push(`- ${item.passed ? 'PASS' : 'FAIL'} — \`${item.command}\` (${item.elapsedMs} ms)`);
  return lines.join('\n') + '\n';
}

const baseSha = arg('base', process.env.PHASE4_BASE || '9c67832485f8e9b6101915d460fae2a74bccfec5');
const headSha = arg('head', git(['rev-parse', 'HEAD'], 'unknown'));
const ownershipLane = arg('lane', process.env.PHASE4_LANE || 'p4-7');
const ownershipBaseSha = arg('ownership-base', git(['merge-base', headSha, 'origin/main'], baseSha));
const noCommands = process.argv.includes('--no-commands');
const oracles = await runVerificationOracles(); const audit = staticAudit();
const notRun = (label, commandText) => ({ label, command: commandText, passed: false, status: null, signal: null, timedOut: false, elapsedMs: 0, stdout: '', stderr: 'NOT-RUN (--no-commands)' });
const irRun = noCommands ? notRun('Phase 3 IR', 'node tests/ir.mjs') : command('Phase 3 IR', process.execPath, ['tests/ir.mjs']);
const semanticV2Run = noCommands ? notRun('Phase 3 semantic evidence + semantic-v2', 'npm run semantic-v2:test') : command('Phase 3 semantic evidence + semantic-v2', 'npm', ['run', 'semantic-v2:test']);
const validation = [irRun, semanticV2Run];
if (!noCommands) validation.push(
  command('npm run check', 'npm', ['run', 'check']),
  command('npm run invariants:test', 'npm', ['run', 'invariants:test']),
  command('npm run migration:test', 'npm', ['run', 'migration:test']),
);
const ownershipCommand = `node tools/validation/phase4-ownership.mjs --lane ${ownershipLane} --base ${ownershipBaseSha}`;
const ownershipRun = noCommands ? notRun('ownership gate', ownershipCommand)
  : command('ownership gate', process.execPath, ['tools/validation/phase4-ownership.mjs', '--lane', ownershipLane, '--base', ownershipBaseSha]);
validation.push(ownershipRun);

const raw = rawFailures(oracles, ownershipRun);
const firstDivergences = [
  ...dynamicDivergences(oracles),
  ...audit.findings.map((item) => ({ category: item.category, categoryName: FIRST_DIVERGENCE[item.category], id: item.id, ownerLane: item.ownerLane, repairLane: item.repairLane, status: item.status, evidence: item.evidence })),
];
const phase3 = phase3From(irRun, semanticV2Run);
const failedCommands = validation.filter((item) => !item.passed);
if (!phase3.satisfied) firstDivergences.push({ category: 'M', categoryName: FIRST_DIVERGENCE.M, id: 'phase3-regression-oracle', ownerLane: 'integration', repairLane: 'p4-7', status: 'BLOCKING' });
if (failedCommands.length) firstDivergences.push({ category: 'L', categoryName: FIRST_DIVERGENCE.L, id: 'required-validation-command-failure', ownerLane: 'integration', repairLane: 'p4-7', status: 'BLOCKING', evidence: failedCommands.map((item) => item.command) });
const rawTotal = Object.values(raw).reduce((sum, value) => sum + (Number(value) || 0), 0);
const integrationDecision = firstDivergences.length || rawTotal ? 'NOT-INTEGRATED / BLOCKING' : 'READY-FOR-P4-7-INTEGRATION';
const productionBlockersByOwnerLane = firstDivergences.reduce((out, item) => { const key = item.ownerLane || 'unknown'; (out[key] ||= []).push(item); return out; }, {});
const report = {
  schemaVersion: 1, phase: 4, lane: 'p4-6-artifact-verification', verificationLane: ownershipLane,
  baseSha, ownershipBaseSha, headSha, generatedAt: new Date().toISOString(),
  integrationDecision, verificationCases: oracles.verificationCases, rawFailures: raw, performance: oracles.performance,
  firstDivergences, productionBlockersByOwnerLane, staticAudit: audit, phase3, validation: validation.map(publicCommand),
};
fs.mkdirSync(REPORT_DIR, { recursive: true });
const stem = `verification-${String(headSha).slice(0, 12) || 'unknown'}`;
const jsonPath = path.join(REPORT_DIR, `${stem}.json`); const mdPath = path.join(REPORT_DIR, `${stem}.md`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n'); fs.writeFileSync(mdPath, markdown(report));
console.log(`PHASE4_VERIFICATION_REPORT ${path.relative(ROOT, jsonPath)} ${integrationDecision}`);
console.log(JSON.stringify({ baseSha, ownershipBaseSha, headSha, integrationDecision, rawFailures: raw, firstDivergenceCount: firstDivergences.length, phase3: phase3.satisfied }));
if (integrationDecision !== 'READY-FOR-P4-7-INTEGRATION') process.exitCode = 1;
