import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { passRegistryDigest } from '../../../js/decompiler/phase8/index.js';

import { loadCorpus } from './build-corpus.mjs';
import { PROFILE, VERIFIER_VERSION } from './verify.mjs';

/**
 * Records one Phase 8 checkpoint acceptance.
 *
 * The ledger is durable repository evidence rather than conversation state, so a
 * long run that spans merges and reloads can say exactly where it reached and
 * what proved it (EP-030). Each entry binds the exact head, the changed-file
 * inventory digest, the ownership policy version, the corpus identity, the pass
 * registry digest and the verifier version — a generic "CI green" line is
 * explicitly not enough.
 *
 * The ledger is also what enforces the checkpoint lock: the verifier treats a
 * required checkpoint with no accepted entry as missing evidence, so the next
 * dependent component cannot be accepted on the strength of a green branch
 * alone (EP-009).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEDGER = path.join(ROOT, 'reports/phase8/checkpoints.json');

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function changedFiles(baseSha) {
  const output = git(['diff', '--name-only', `${baseSha}...HEAD`]);
  if (output == null) return [];
  return output.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

export function readLedger() {
  if (!fs.existsSync(LEDGER)) return { schemaVersion: 1, checkpoints: [] };
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}

export function recordCheckpoint({
  id,
  baseSha,
  result = 'accepted',
  blockingReason = null,
  gates = [],
  generatedOutputDiff = 'zero',
  notes = '',
}) {
  const corpus = loadCorpus();
  const ownership = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase-ownership/phase8.json'), 'utf8'));
  const files = changedFiles(baseSha);
  const entry = {
    id,
    recordedAt: new Date().toISOString(),
    integrationSha: git(['rev-parse', 'HEAD']) ?? 'unknown',
    integrationTreeSha: git(['rev-parse', 'HEAD^{tree}']) ?? 'unknown',
    mergeBaseSha: baseSha,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
    changedFileCount: files.length,
    changedFileInventoryDigest: stableDigest(files),
    ownershipPolicyVersion: ownership.version,
    corpusId: corpus.corpusId,
    corpusDigest: corpus.corpusDigest,
    toolchain: corpus.toolchain,
    passRegistryDigest: passRegistryDigest(),
    verifierVersion: VERIFIER_VERSION,
    // The acceptance profile this checkpoint was accepted under. A profile bump
    // changes what "accepted" means, so evidence recorded under an older profile
    // is visibly older evidence rather than silently grandfathered (§5).
    profileVersion: PROFILE.profileVersion,
    gates,
    generatedOutputDiff,
    result,
    blockingReason,
    notes,
  };
  const ledger = readLedger();
  ledger.checkpoints = [...ledger.checkpoints.filter((item) => item.id !== id), entry]
    .sort((left, right) => left.id.localeCompare(right.id));
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const temporary = `${LEDGER}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temporary, LEDGER);
  return entry;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag, fallback = null) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const id = value('--id');
  const baseSha = value('--base');
  if (!id || !baseSha) {
    console.error('usage: node tools/validation/phase8/checkpoint.mjs --id P8-1 --base <sha> [--gates a,b] [--result accepted|blocking] [--reason text]');
    process.exitCode = 2;
  } else {
    const entry = recordCheckpoint({
      id,
      baseSha,
      result: value('--result', 'accepted'),
      blockingReason: value('--reason', null),
      gates: (value('--gates', '') ?? '').split(',').map((gate) => gate.trim()).filter(Boolean),
      generatedOutputDiff: value('--generated', 'zero'),
      notes: value('--notes', ''),
    });
    console.log(`recorded checkpoint ${entry.id} at ${entry.integrationSha} (${entry.changedFileCount} files, inventory ${entry.changedFileInventoryDigest.slice(0, 16)})`);
  }
}
