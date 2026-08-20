/**
 * Permanent independent verifier for Phase 10 — Runtime Providers.
 * Binds the exact product commit/tree to the Phase 10 contract suite and the
 * pre-existing core/runtime compatibility oracles.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runPhase10Tests } from '../../../tests/phase10/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase10/profile.json'), 'utf8'));

export const VERIFIER_ID = 'phase10.verifier';
export const VERIFIER_VERSION = '1.0.0';
export const SCHEMA_VERSION = 'phase10-release-evidence/v1';

const UNVERIFIED_PATHS = Object.freeze([
  'reports/phase10/',
  '.gemini/',
  '.github/copilot-instructions.md',
  'GEMINI.md',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function parseArgs(argv) {
  let expectSha = null;
  let shadow = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--expect-sha') {
      expectSha = String(argv[++i] || '');
      if (!/^[0-9a-f]{40}$/i.test(expectSha)) throw new TypeError('phase10: --expect-sha requires a 40-character commit SHA');
    } else if (arg === '--shadow') shadow = true;
    else throw new TypeError(`phase10: unknown verifier argument: ${arg}`);
  }
  return { expectSha, shadow };
}

function getProductIdentity() {
  const commitSha = git(['rev-parse', 'HEAD']) || '0000000000000000000000000000000000000000';
  const treeSha = git(['rev-parse', 'HEAD^{tree}']) || '0000000000000000000000000000000000000000';
  const status = git(['status', '--porcelain']) ?? '';
  const dirtyFiles = status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .filter((file) => !UNVERIFIED_PATHS.some((prefix) => file.startsWith(prefix)));
  return Object.freeze({ commitSha, treeSha, clean: dirtyFiles.length === 0, dirtyFiles });
}

function runNodeFile(relative) {
  const result = spawnSync(process.execPath, [relative], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${relative} failed with status ${result.status ?? 'signal'}`);
}

function publishAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

export function verifyPhase10(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const product = getProductIdentity();

  if (!product.clean) {
    const result = { verdict: 'BLOCKING', reason: 'product worktree is dirty', product };
    if (!args.shadow) throw new Error(`${result.reason}: ${product.dirtyFiles.join(', ')}`);
    return result;
  }
  if (args.expectSha && product.commitSha.toLowerCase() !== args.expectSha.toLowerCase()) {
    const result = { verdict: 'BLOCKING', reason: 'exact-head SHA mismatch', expectedSha: args.expectSha, product };
    if (!args.shadow) throw new Error(`${result.reason}: expected ${args.expectSha}, got ${product.commitSha}`);
    return result;
  }

  console.log(`[phase10-verifier] commit=${product.commitSha} tree=${product.treeSha}`);

  try {
    runNodeFile('tests/core-identity-contracts.mjs');
    runNodeFile('tests/core-evidence-contracts.mjs');
    runNodeFile('tests/runtime-platform.mjs');
    runNodeFile('tests/runtime-evidence-fusion.mjs');
    runPhase10Tests([], { root: path.join(ROOT, 'tests/phase10') });
  } catch (error) {
    if (!args.shadow) throw error;
    return { verdict: 'BLOCKING', reason: String(error?.message || error), product };
  }

  const gates = PROFILE.gates.map((gate) => ({ ...gate, status: 'PASSED' }));
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    phase: 10,
    verdict: 'READY',
    verifier: { id: VERIFIER_ID, version: VERIFIER_VERSION },
    product,
    gates,
    timestamp: startedAt,
  };
  const report = { ...payload, evidenceDigest: sha256(Buffer.from(JSON.stringify(payload))) };
  const reportDir = path.join(ROOT, 'reports/phase10');
  publishAtomic(path.join(reportDir, 'phase10-release-evidence.json'), report);

  let ledger = { phase: 10, checkpoints: [] };
  const ledgerPath = path.join(reportDir, 'checkpoints.json');
  if (fs.existsSync(ledgerPath)) {
    try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { /* fresh ledger */ }
  }
  ledger.checkpoints = (ledger.checkpoints || []).filter((entry) => entry.id !== 'P10-LIVING');
  ledger.checkpoints.push({
    id: 'P10-LIVING',
    timestamp: startedAt,
    result: 'accepted',
    integrationSha: product.commitSha,
    integrationTreeSha: product.treeSha,
    evidenceDigest: report.evidenceDigest,
    gatesPassed: gates.length,
  });
  publishAtomic(ledgerPath, ledger);

  console.log(`[phase10-verifier] READY ${report.evidenceDigest}`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { verifyPhase10(); }
  catch (error) { console.error(error); process.exit(1); }
}
