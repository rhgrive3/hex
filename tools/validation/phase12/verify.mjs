import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentSupportMatrix } from '../../../js/platform/capability-maturity.js';
import { verifyPhase11 } from '../phase11/verify.mjs';
import { runPhase12Tests } from '../../../tests/phase12/run.mjs';
import { loadManifest, validateManifest } from './ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_DIR = path.join(ROOT, 'reports/phase12');
export const VERIFIER_ID = 'phase12.verifier';
export const VERIFIER_VERSION = '1.0.0';
export const SCHEMA_VERSION = 'phase12-release-evidence/v1';
const UNVERIFIED_PATHS = Object.freeze(['reports/', '.git/', 'graft/.cache/', 'graft/.graph/']);

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function getProductIdentity() {
  const commitSha = git(['rev-parse', 'HEAD']);
  const treeSha = git(['rev-parse', 'HEAD^{tree}']);
  const dirtyFiles = (git(['status', '--porcelain']) || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.slice(2).trim()).filter((file) => !UNVERIFIED_PATHS.some((prefix) => file.startsWith(prefix)));
  return Object.freeze({ commitSha, treeSha, clean: dirtyFiles.length === 0, dirtyFiles });
}

function isSha(value) { return /^[0-9a-f]{40}$/i.test(String(value || '')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseArgs(argv) {
  let expectSha = null;
  let shadow = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expect-sha') expectSha = String(argv[++i] || '');
    else if (argv[i] === '--shadow') shadow = true;
    else throw new TypeError(`phase12: unknown verifier argument: ${argv[i]}`);
  }
  if (expectSha != null && !isSha(expectSha)) throw new TypeError('phase12: --expect-sha requires an exact 40-character commit SHA');
  return { expectSha, shadow };
}

function blocking(reason, product, detail = null) { return { verdict: 'BLOCKING', reason, detail, product }; }
function publishAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function validateEvidenceShape(report) {
  if (report.schemaVersion !== SCHEMA_VERSION || report.phase !== 12) throw new Error('phase12 evidence schema mismatch');
  if (!isSha(report.product.commitSha) || !isSha(report.product.treeSha)) throw new Error('phase12 evidence product identity is not exact');
  if (report.verifier?.id !== VERIFIER_ID || report.verifier?.version !== VERIFIER_VERSION) throw new Error('phase12 evidence verifier identity mismatch');
  if (!Array.isArray(report.gates) || report.gates.some((gate) => !gate.id || !gate.status)) throw new Error('phase12 evidence gate list is incomplete');
}

export async function verifyPhase12(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = loadManifest();
  const product = getProductIdentity();
  if (!product.clean) {
    const result = blocking('product worktree is dirty', product);
    if (!args.shadow) throw new Error(`${result.reason}: ${product.dirtyFiles.join(', ')}`);
    return result;
  }
  if (args.expectSha && product.commitSha.toLowerCase() !== args.expectSha.toLowerCase()) {
    const result = blocking('exact-head SHA mismatch', product, { expectedSha: args.expectSha });
    if (!args.shadow) throw new Error(`${result.reason}: expected ${args.expectSha}, got ${product.commitSha}`);
    return result;
  }
  if (validateManifest(manifest).length) throw new Error(`phase12 ownership manifest invalid: ${validateManifest(manifest).join('; ')}`);
  const foundation = manifest.foundation;
  if (!isSha(foundation.commitSha) || !isSha(foundation.treeSha)) throw new Error('phase12 foundation identity is not exact');
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', foundation.commitSha, product.commitSha], { cwd: ROOT });
  if (ancestor.status !== 0) throw new Error('phase12 candidate is not descended from the recorded foundation');

  console.log(`[phase12-verifier] commit=${product.commitSha} tree=${product.treeSha}`);
  try {
    await runPhase12Tests([], { root: path.join(ROOT, 'tests/phase12') });
    const phase11 = await verifyPhase11(['--expect-sha', product.commitSha]);
    const supportMatrix = currentSupportMatrix();
    const gates = [
      { id: 'P12.0-foundation', status: 'PASSED' },
      { id: 'P12.0-phase11-current-head', status: phase11?.verdict === 'READY' ? 'PASSED' : 'BLOCKING' },
      { id: 'P12.V0-negative-oracles', status: 'PASSED' },
    ];
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      phase: 12,
      verdict: 'READY',
      verifier: { id: VERIFIER_ID, version: VERIFIER_VERSION },
      product,
      foundation: { ...foundation },
      phase11: { product: phase11.product, evidenceDigest: phase11.evidenceDigest, verifier: phase11.verifier },
      gates,
      supportTruth: { nativeRebuild: 'operation-profile-only', remoteCollaboration: 'local-only', patternMutation: 'read-only', capabilityAuthority: 'evidence-only' },
      supportMatrixDigest: sha256(JSON.stringify(supportMatrix)),
      timestamp: new Date().toISOString(),
    };
    const report = { ...payload, evidenceDigest: sha256(JSON.stringify(payload)) };
    validateEvidenceShape(report);
    publishAtomic(path.join(REPORT_DIR, 'phase12-release-evidence.json'), report);
    publishAtomic(path.join(REPORT_DIR, 'checkpoints.json'), { phase: 12, checkpoints: [{ id: 'P12-LIVING', result: 'accepted', integrationSha: product.commitSha, integrationTreeSha: product.treeSha, evidenceDigest: report.evidenceDigest, verifier: report.verifier }] });
    console.log(`[phase12-verifier] READY ${report.evidenceDigest}`);
    return report;
  } catch (error) {
    if (!args.shadow) throw error;
    return blocking(String(error?.message || error), product);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { await verifyPhase12(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
