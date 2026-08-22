import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCompetitiveProfile } from '../competitive/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_PATH = path.join(ROOT, 'reports/stage1/stage1-verdict.json');
const OUTPUT_LIMIT = 6000;

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function parseExpectedSha(argv) {
  const direct = argv.find((arg) => arg.startsWith('--expect-sha='));
  if (direct) return direct.slice('--expect-sha='.length);
  const index = argv.indexOf('--expect-sha');
  return index >= 0 ? argv[index + 1] : null;
}

function bounded(text) {
  const value = String(text || '');
  return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT);
}

function runCommand(command) {
  const startedAt = Date.now();
  const result = spawnSync(command.bin, command.args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: process.env.CI || '1' },
  });
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

const GATES = Object.freeze([
  Object.freeze({
    id: 'A1',
    name: 'canonical address/value truth closure',
    evidence: ['tests/core-identity-contracts.mjs'],
    commands: [node('tests/core-identity-contracts.mjs')],
  }),
  Object.freeze({
    id: 'A2',
    name: 'MachineEffects coverage denominator closure',
    evidence: ['js/targets/architecture/coverage.js', 'tests/machine-effects/**', 'tests/stage1/a2-machine-effects-coverage.test.mjs'],
    commands: [npm('effects:test'), node('tests/stage1/a2-machine-effects-coverage.test.mjs')],
  }),
  Object.freeze({
    id: 'A3',
    name: 'alias/call-clobber and unknown-writer soundness',
    evidence: ['tests/semantic-v2/alias-floor-safety.test.mjs', 'tests/semantic-v2/compat-v1-call-abi-state.test.mjs', 'tests/semantic-v2/compat-v1-memory.test.mjs'],
    commands: [
      node('tests/semantic-v2/alias-floor-safety.test.mjs'),
      node('tests/semantic-v2/compat-v1-call-abi-state.test.mjs'),
      node('tests/semantic-v2/compat-v1-memory.test.mjs'),
    ],
  }),
  Object.freeze({
    id: 'A4',
    name: 'semantic pipeline breadth',
    evidence: ['tests/semantic-v2/**'],
    commands: [npm('semantic-v2:test')],
  }),
  Object.freeze({
    id: 'A5',
    name: 'F3/F4/F5 decompiler proof integrity',
    evidence: ['tests/phase8/**'],
    commands: [npm('phase8:test')],
  }),
  Object.freeze({
    id: 'A6',
    name: 'native solver/equivalence proof integrity',
    evidence: ['tests/phase9/**'],
    commands: [npm('phase9:test')],
  }),
  Object.freeze({
    id: 'A7',
    name: 'managed frontend equivalence',
    evidence: ['tests/phase11/**'],
    commands: [npm('phase11:test')],
  }),
  Object.freeze({
    id: 'A8',
    name: 'persistence/plugin regression',
    evidence: ['tests/platform-bytesource.mjs', 'tests/project-roundtrip.mjs', 'tests/plugin-platform.mjs', 'tests/plugin-manifest-v2.mjs'],
    commands: [npm('platform:test')],
  }),
  Object.freeze({
    id: 'A9',
    name: 'large-file and iPad-adjacent hot-path regression',
    evidence: ['tests/bytesource-contract.mjs', 'tests/universal-binary-source.mjs', 'tests/binary-platform.mjs', 'tests/benchmark-baseline.mjs'],
    commands: [npm('binary:test'), npm('benchmark:baseline')],
  }),
]);

const SCOPE_PATH = path.join(ROOT, 'tools/validation/stage2/completion-scope.lock.json');
const LEDGER_PATH = path.join(ROOT, 'tools/validation/stage2/closure-ledger.json');
const REQUIRED_STAGE1_LEDGER_IDS = Object.freeze([
  'S1-A2-NATIVE',
]);

export function validateStage1ScopeAndLedger(headSha) {
  const errors = [];
  if (!fs.existsSync(SCOPE_PATH)) errors.push('completion-scope-missing');
  if (!fs.existsSync(LEDGER_PATH)) errors.push('closure-ledger-missing');
  if (errors.length > 0) return { ok: false, errors };

  const scope = JSON.parse(fs.readFileSync(SCOPE_PATH, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

  if (scope.growthOnly !== true) errors.push('scope-not-growth-only');
  if (!/^[0-9a-f]{40}$/.test(scope.baselineCommit || '')) errors.push('scope-baseline-commit-invalid');
  if (!/^[0-9a-f]{40}$/.test(scope.baselineTree || '')) errors.push('scope-baseline-tree-invalid');

  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', scope.baselineCommit, headSha], { cwd: ROOT, encoding: 'utf8' });
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

  for (const id of REQUIRED_STAGE1_LEDGER_IDS) {
    if (!ids.has(id)) errors.push(`ledger-required-stage1-id-missing:${id}`);
  }

  return { ok: errors.length === 0, errors, scope, ledger, ledgerItemCount: ids.size };
}

export function stage1GateDefinitions() {
  return GATES;
}

export function verifyStage1({ expectedSha = null } = {}) {
  const gitSha = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('stage1-head-sha-invalid');
  if (expectedSha != null) {
    if (!/^[0-9a-f]{40}$/i.test(String(expectedSha))) throw new TypeError('stage1-expected-sha-invalid');
    if (gitSha.toLowerCase() !== String(expectedSha).toLowerCase()) {
      throw new Error(`stage1-exact-head-mismatch: expected ${expectedSha}, got ${gitSha}`);
    }
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`stage1-worktree-not-clean:\n${dirty}`);

  // Validate Scope and Ledger
  const scopeValidation = validateStage1ScopeAndLedger(gitSha);
  if (!scopeValidation.ok) {
    throw new Error(`stage1-scope-ledger-invalid:\n${scopeValidation.errors.join('\n')}`);
  }

  // Validate Competitive Profile
  verifyCompetitiveProfile();

  const gates = [];
  for (const gate of GATES) {
    const commandResults = [];
    for (const command of gate.commands) commandResults.push(runCommand(command));
    gates.push(Object.freeze({
      id: gate.id,
      name: gate.name,
      status: commandResults.every((result) => result.status === 'passed') ? 'passed' : 'failed',
      evidence: Object.freeze([...gate.evidence]),
      commands: Object.freeze(commandResults),
    }));
  }

  const verdict = gates.every((gate) => gate.status === 'passed') ? 'READY' : 'BLOCKED';
  const report = {
    schemaVersion: 'stage1-verdict/v1',
    stage: 1,
    title: 'Analysis Truth + Coverage Closure',
    gitSha,
    expectedSha: expectedSha || null,
    generatedAt: new Date().toISOString(),
    scopeValidation: { ok: true, ledgerItemCount: scopeValidation.ledgerItemCount },
    gates,
    verdict,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (verdict !== 'READY') {
    const failed = gates.filter((gate) => gate.status !== 'passed').map((gate) => gate.id).join(', ');
    throw new Error(`stage1-release-blocked: ${failed}`);
  }
  return Object.freeze(report);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = verifyStage1({ expectedSha: parseExpectedSha(process.argv.slice(2)) });
    console.log(`Stage 1 release verdict: ${report.verdict} @ ${report.gitSha}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
