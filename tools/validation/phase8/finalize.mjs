import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { recordCheckpoint } from './checkpoint.mjs';
import { PROFILE, publish, verifyPhase8 } from './verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEDGER = path.join(ROOT, 'reports/phase8/checkpoints.json');
const EVIDENCE_DIRECTORY = path.join(ROOT, 'reports/phase8');
const EVIDENCE_FILES = [
  path.join(EVIDENCE_DIRECTORY, 'phase8-release-evidence.json'),
  path.join(EVIDENCE_DIRECTORY, 'phase8-release-evidence.md'),
];

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding:'utf8', maxBuffer:64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  return String(result.stdout).trim();
}

function snapshotFile(file) {
  return fs.existsSync(file) ? { exists:true, data:fs.readFileSync(file) } : { exists:false, data:null };
}

function restoreFile(file, snapshot) {
  if (snapshot.exists) {
    fs.mkdirSync(path.dirname(file), { recursive:true });
    const temporary = `${file}.${process.pid}.restore`;
    fs.writeFileSync(temporary, snapshot.data);
    fs.renameSync(temporary, file);
  } else {
    fs.rmSync(file, { force:true });
  }
}

/**
 * Execute a filesystem transaction whose owned evidence files are restored on
 * any failure. Exported so the rollback contract has a deterministic regression
 * without invoking the expensive product verifier from the test itself.
 */
export async function withFileRollback(files, operation) {
  const snapshots = new Map(files.map((file) => [file, snapshotFile(file)]));
  try {
    return await operation();
  } catch (error) {
    for (const file of files) restoreFile(file, snapshots.get(file));
    throw error;
  }
}

/**
 * P8-I cutover transaction.
 *
 * The accepted ledger entry exists only in the working tree while the permanent
 * verifier evaluates the real exact product. If any hard-zero, quality,
 * performance, gate, identity, or checkpoint condition fails, the old ledger
 * and evidence are restored. Only a real READY report may escape this function.
 * This resolves the P8-I checkpoint/verifier cycle without weakening either side
 * and without fabricating a self-referential commit SHA.
 */
export async function finalizeP8I({ baseSha, externalGates = [] }) {
  if (!/^[0-9a-f]{40}$/i.test(String(baseSha || ''))) throw new TypeError('P8-I finalizer requires an exact 40-character base SHA');
  const headSha = git(['rev-parse', 'HEAD']);
  const ownedFiles = [LEDGER, ...EVIDENCE_FILES];
  return withFileRollback(ownedFiles, async () => {
    const gates = [...new Set([
      ...PROFILE.requiredGates,
      ...externalGates,
    ])];
    const checkpoint = recordCheckpoint({
      id:'P8-I',
      baseSha,
      result:'accepted',
      gates,
      generatedOutputDiff:'zero',
      notes:'P8-I accepted only after temporary-ledger exact-product verification returned READY. External exact-head workflow evidence was observed by the cutover workflow before this transaction.',
    });

    const report = verifyPhase8({
      shadow:false,
      expectedSha:headSha,
      gates:true,
    });
    if (report.verdict !== 'READY') {
      const first = report.failures?.[0];
      throw new Error(`P8-I verifier returned ${report.verdict}: ${first?.category || 'unknown'}: ${first?.firstDivergence || 'no failure detail'}`);
    }
    if (report.product?.commitSha !== headSha) throw new Error(`P8-I evidence identity mismatch: ${report.product?.commitSha} != ${headSha}`);
    publish(report, EVIDENCE_DIRECTORY);
    return { checkpoint, report };
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag, fallback = null) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const baseSha = value('--base');
  const externalGates = String(value('--external-gates', '') || '').split('|').map((item) => item.trim()).filter(Boolean);
  if (!baseSha) {
    console.error('usage: node tools/validation/phase8/finalize.mjs --base <pre-Phase-8-sha> [--external-gates "workflow A|workflow B"]');
    process.exitCode = 2;
  } else {
    try {
      const { checkpoint, report } = await finalizeP8I({ baseSha, externalGates });
      console.log(`P8_I_CHECKPOINT_PRODUCT=${checkpoint.integrationSha}`);
      console.log(`P8_I_CORPUS=${checkpoint.corpusDigest}`);
      console.log(`P8_VERDICT=${report.verdict}`);
      console.log(`P8_EVIDENCE_PRODUCT=${report.product.commitSha}`);
    } catch (error) {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    }
  }
}
