import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePhysicalIPadEvidence } from '../../../js/platform/physical-ipad-evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_PATH = path.join(ROOT, 'reports/stage2/stage2-verdict.json');
const SCOPE_PATH = path.join(ROOT, 'tools/validation/stage2/completion-scope.lock.json');
const LEDGER_PATH = path.join(ROOT, 'tools/validation/stage2/closure-ledger.json');
const OUTPUT_LIMIT = 7000;

function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return { status: result.status, stdout: result.stdout?.trim() || '', stderr: result.stderr?.trim() || '' };
}
function bounded(text) { const value = String(text || ''); return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT); }
function parseArg(name, argv) {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}
function hasFlag(name, argv) { return argv.includes(name); }
function run(command) {
  const startedAt = Date.now();
  const result = spawnSync(command.bin, command.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1' } });
  return Object.freeze({
    command: [command.bin, ...command.args].join(' '),
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal || null,
    durationMs: Date.now() - startedAt,
    stdoutTail: bounded(result.stdout),
    stderrTail: bounded(result.stderr),
  });
}
const node = (...args) => ({ bin: process.execPath, args });
const npm = (...args) => ({ bin: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', ...args] });

function validateScopeAndLedger(headSha) {
  const scope = JSON.parse(fs.readFileSync(SCOPE_PATH, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const errors = [];
  if (scope.growthOnly !== true) errors.push('scope-not-growth-only');
  if (!/^[0-9a-f]{40}$/.test(scope.baselineCommit || '')) errors.push('scope-baseline-commit-invalid');
  if (!/^[0-9a-f]{40}$/.test(scope.baselineTree || '')) errors.push('scope-baseline-tree-invalid');
  if (!Array.isArray(scope.requiredTargetPlatforms) || !scope.requiredTargetPlatforms.includes('physical-ipad-ipados-webkit')) errors.push('physical-ipad-missing-from-scope');
  const ancestor = git(['merge-base', '--is-ancestor', scope.baselineCommit, headSha], true);
  if (ancestor.status !== 0) errors.push('scope-baseline-not-ancestor');
  const ids = new Set();
  for (const item of ledger.items || []) {
    if (!item.id || ids.has(item.id)) errors.push(`ledger-id-invalid:${item.id || '<missing>'}`);
    ids.add(item.id);
    for (const ref of [...(item.implementationRefs || []), ...(item.testRefs || []), ...(item.verifierRefs || []), ...(item.supportTruthRefs || [])]) {
      if (ref.includes('*')) continue;
      if (!fs.existsSync(path.join(ROOT, ref))) errors.push(`ledger-ref-missing:${item.id}:${ref}`);
    }
  }
  const required = ['S2-A7-NATIVE','S2-M6-WASM','S2-M6-DEX','S2-M6-CIL','S2-M6-JVM','S2-F6-MACHO','S2-F6-ELF','S2-F6-PE','S2-P12-KNOWLEDGE','S2-P12-RULES','S2-P12-PATTERNS','S2-P12-COLLAB-REMOTE','S2-IPAD-PHYSICAL','S2-FINAL-AUDIT'];
  for (const id of required) if (!ids.has(id)) errors.push(`ledger-required-id-missing:${id}`);
  return { ok: errors.length === 0, errors, scope, ledgerItemCount: ids.size };
}

function auditStage2Source() {
  const paths = [
    'js/runtime/authority.js',
    'js/managed/runtime-binding.js',
    'js/rebuild/transaction-v2.js',
    'js/collaboration/remote-authority.js',
    'js/collaboration/remote-delivery.js',
    'js/platform/physical-ipad-evidence.js',
    'js/platform/stage2-capability-maturity.js',
  ];
  const findings = [];
  for (const relative of paths) {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    if (/\b(?:TODO|FIXME)\b/.test(text)) findings.push(`${relative}:todo-fixme`);
    if (/not[- ]implemented/i.test(text)) findings.push(`${relative}:not-implemented-marker`);
  }
  return { ok: findings.length === 0, findings };
}

function physicalEvidenceResult({ finalMode, evidencePath, headSha, treeSha, buildIdentity }) {
  if (!finalMode) return { required: false, status: 'not-evaluated-in-implementation-mode' };
  if (!evidencePath) return { required: true, status: 'failed', reason: 'physical-ipad-evidence-required' };
  const resolved = path.resolve(ROOT, evidencePath);
  if (!fs.existsSync(resolved)) return { required: true, status: 'failed', reason: 'physical-ipad-evidence-file-missing' };
  let record;
  try { record = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { return { required: true, status: 'failed', reason: 'physical-ipad-evidence-json-invalid', detail: String(error?.message || error) }; }
  const checked = validatePhysicalIPadEvidence(record, { commitSha: headSha, treeSha, ...(buildIdentity ? { buildIdentity } : {}) });
  return { required: true, status: checked.ok ? 'passed' : 'failed', reason: checked.reason || null, evidenceId: checked.evidenceId || record.evidenceId || null };
}

export function verifyStage2({ expectedSha = null, finalMode = false, physicalEvidencePath = null, buildIdentity = null, full = false } = {}) {
  const headSha = git(['rev-parse', 'HEAD']).stdout;
  const treeSha = git(['rev-parse', 'HEAD^{tree}']).stdout;
  if (!/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(treeSha)) throw new Error('stage2-git-identity-invalid');
  if (expectedSha && headSha !== String(expectedSha).toLowerCase()) throw new Error(`stage2-exact-head-mismatch: expected ${expectedSha}, got ${headSha}`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout;
  if (dirty) throw new Error(`stage2-worktree-not-clean:\n${dirty}`);

  const structural = validateScopeAndLedger(headSha);
  const sourceAudit = auditStage2Source();
  const commands = [
    node('tools/validation/stage1/verify.mjs', '--expect-sha', headSha),
    node('tests/stage2/run.mjs'),
    npm('runtime:test'),
    npm('phase11:test'),
    npm('phase12:test'),
    npm('benchmark:baseline'),
  ];
  if (full) commands.push(npm('check'));
  const commandResults = commands.map(run);
  const physical = physicalEvidenceResult({ finalMode, evidencePath: physicalEvidencePath, headSha, treeSha, buildIdentity });

  const failures = [];
  if (!structural.ok) failures.push(...structural.errors.map((reason) => ({ gate: 'scope-ledger', reason })));
  if (!sourceAudit.ok) failures.push(...sourceAudit.findings.map((reason) => ({ gate: 'source-audit', reason })));
  for (const result of commandResults) if (result.status !== 'passed') failures.push({ gate: 'command', reason: result.command });
  if (physical.status === 'failed') failures.push({ gate: 'physical-ipad', reason: physical.reason });

  const verdict = failures.length === 0 ? (finalMode ? 'COMPLETE' : 'IMPLEMENTATION_READY') : 'NOT_COMPLETE';
  const report = {
    schemaVersion: 'stage2-verdict/v1',
    stage: 2,
    headSha,
    treeSha,
    expectedSha: expectedSha || null,
    finalMode,
    full,
    generatedAt: new Date().toISOString(),
    scope: { version: structural.scope.scopeVersion, baselineCommit: structural.scope.baselineCommit, ledgerItemCount: structural.ledgerItemCount, status: structural.ok ? 'passed' : 'failed' },
    sourceAudit,
    commands: commandResults,
    physicalIPadEvidence: physical,
    failures,
    verdict,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (verdict === 'NOT_COMPLETE') throw new Error(`stage2-not-complete: ${failures.map((item) => `${item.gate}:${item.reason}`).join(', ')}`);
  return Object.freeze(report);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  try {
    const report = verifyStage2({
      expectedSha: parseArg('--expect-sha', argv),
      finalMode: hasFlag('--final', argv),
      physicalEvidencePath: parseArg('--physical-evidence', argv),
      buildIdentity: parseArg('--build-identity', argv),
      full: hasFlag('--full', argv),
    });
    console.log(`Stage 2 verdict: ${report.verdict} @ ${report.headSha}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
