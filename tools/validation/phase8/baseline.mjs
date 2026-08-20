import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';

import { loadCorpus } from './build-corpus.mjs';
import { observeCorpus } from './decompile-corpus.mjs';

/**
 * Captures the frozen Phase 8 baseline.
 *
 * The point of capturing it before any optimizer lands is that the comparison
 * numbers exist before anyone knows whether they will be flattering. A baseline
 * captured after the candidate is visible is not a baseline.
 *
 * The ledger binds the corpus digest and the toolchain identity. If either
 * changes the old ledger is a different series and must be re-captured rather
 * than compared across (§5 evidence identity).
 *
 * `--current` re-captures from the working tree, which is only correct while
 * Phase 8 is still a no-op. Once an optimizer changes output, re-capturing the
 * baseline from the candidate would erase exactly the evidence Phase 8 is judged
 * against, so the command refuses unless `--force` is given.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGET = path.join(ROOT, 'tests/phase8/corpus/pre-phase8-observations.json');

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function captureBaseline({ target = TARGET, baseCommit = git(['rev-parse', 'HEAD']), decompilerTimeBudgetMs = 5000 } = {}) {
  const corpus = loadCorpus();
  const observations = observeCorpus({ corpus, decompilerTimeBudgetMs }).map(({ phase8, ...rest }) => rest);
  const ledger = {
    schemaVersion: 1,
    note: 'Frozen pre-Phase-8 decompiler output for the Phase 8 corpus. Captured from the product at the Phase 8 base commit with the rewrite engine time valve disabled, so the fixed point depends only on the input and the rules. Regenerating this file is an acceptance-semantics change: it invalidates every Phase 8 no-op and quality comparison derived from it.',
    baseCommit,
    corpusId: corpus.corpusId,
    corpusVersion: corpus.corpusVersion,
    corpusDigest: corpus.corpusDigest,
    toolchain: corpus.toolchain,
    deterministicTransforms: true,
    decompilerTimeBudgetMs,
    observations,
  };
  ledger.observationsDigest = stableDigest(observations);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temporary, target);
  return { target, ledger };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (fs.existsSync(TARGET) && !argv.includes('--force')) {
    console.error('phase8 baseline: a frozen baseline already exists. Re-capturing it invalidates every Phase 8 comparison derived from it; pass --force if that is genuinely intended.');
    process.exitCode = 2;
  } else {
    const { target, ledger } = captureBaseline();
    console.log(`phase8 baseline written: ${path.relative(ROOT, target)}`);
    console.log(`corpus digest: ${ledger.corpusDigest}`);
    console.log(`observations digest: ${ledger.observationsDigest} (${ledger.observations.length} functions, ${ledger.observations.filter((observation) => observation.semantic).length} on the semantic path)`);
  }
}
