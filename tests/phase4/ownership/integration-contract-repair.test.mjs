import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VALIDATOR = path.join(ROOT, 'tools/validation/phase4-ownership.mjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase-ownership/phase4.json'), 'utf8'));
const RETIRED_OWNERSHIP_WORKFLOW = path.join(ROOT, '.github/workflows/phase4-ownership.yml');
const INVARIANT_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/invariant-gates.yml'), 'utf8');
const RELEASE_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/phase4-release-validation.yml'), 'utf8');
const GENERATED_SYNC_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-sync.yml'), 'utf8');
const VERIFIER = fs.readFileSync(path.join(ROOT, 'tools/validation/phase4/verify.mjs'), 'utf8');

const COMPONENT_INVENTORY = Object.freeze({
  'p4-1@eb0d116cdc05eb4d6925e4ce2c9cb7ec7f9aaef6': [
    'js/core/artifacts/backends.js',
    'js/core/artifacts/hot-cache.js',
    'js/core/artifacts/storage/integrity.js',
    'js/core/artifacts/store.js',
    'tests/phase4/store/atomic.test.mjs',
    'tests/phase4/store/basic.test.mjs',
    'tests/phase4/store/corruption.test.mjs',
    'tests/phase4/store/scaling.test.mjs',
    'tests/phase4/store/support.mjs',
  ],
  'p4-2@236e5a579be74cc141e6e2a5c02813c4086f0111': [
    'js/core/budgets/scheduler-budget.js',
    'js/core/scheduler/analysis-scheduler.js',
    'tests/phase4/scheduler/cancellation-budget.test.mjs',
    'tests/phase4/scheduler/contract-parity.test.mjs',
    'tests/phase4/scheduler/dag.test.mjs',
    'tests/phase4/scheduler/helpers.mjs',
    'tests/phase4/scheduler/priority-scaling.test.mjs',
    'tests/phase4/scheduler/run.mjs',
  ],
  'p4-3@76ed68d5209eb721d5c656158016fb3d82cc41a9': [
    'js/project/artifact-index.js',
    'tests/phase4/project/bounds.test.mjs',
    'tests/phase4/project/invalidation.test.mjs',
    'tests/phase4/project/portability.test.mjs',
    'tests/phase4/project/run.mjs',
  ],
  'p4-4@943783ef221bebdb538dc448b38453a502158e2c': [
    'js/core/artifacts/paging/index.js',
    'tests/phase4/paging/paged-large-file.test.mjs',
    'tests/phase4/paging/run.mjs',
  ],
  'p4-5@6e15d81878edeab14da88304a2857589ef63aae3': [
    'js/backend.js',
    'js/cache/analysis-cache.js',
    'js/cache/artifact-orchestration.js',
    'tests/phase4/migration/orchestration.test.mjs',
    'tests/phase4/migration/payload-codec.test.mjs',
    'tests/phase4/migration/run.mjs',
  ],
  'p4-6@fb607800634779b61ba4523ffc1ec7ee215b58f2': [
    'reports/phase4/README.md',
    'tests/phase4/verification/oracles.mjs',
    'tools/validation/phase4/verify.mjs',
  ],
});

function regexFor(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { out += '.*'; i++; continue; }
    if (ch === '*') { out += '[^/]*'; continue; }
    out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

function locallyOwned(lane, file) {
  return MANIFEST.lanes[lane].some((pattern) => regexFor(pattern).test(file));
}

function runValidator(lane, file) {
  return spawnSync(process.execPath, [VALIDATOR, '--lane', lane, '--files', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function expectPass(lane, file) {
  const result = runValidator(lane, file);
  assert.equal(result.status, 0, `${lane} should own ${file}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

function expectFail(lane, file) {
  const result = runValidator(lane, file);
  assert.equal(result.status, 1, `${lane} should reject ${file}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

test('manifest has the exact frozen-contract write-owner policy', () => {
  assert.deepEqual(MANIFEST.contractWriteOwners, {
    'js/core/artifacts/contracts.js': ['p4-0'],
    'js/core/artifacts/index.js': ['p4-0', 'p4-7'],
    'js/core/budgets/index.js': ['p4-0', 'p4-7'],
    'js/core/scheduler/index.js': ['p4-0', 'p4-7'],
    'js/project/artifact-index.js': ['p4-0', 'p4-3', 'p4-7'],
  });
  assert.deepEqual(MANIFEST.lanes['p4-r'], [
    'tools/validation/phase-ownership/phase4.json',
    'tools/validation/phase4-ownership.mjs',
    '.github/workflows/phase4-ownership.yml',
    'tests/phase4/ownership/**',
  ]);
});

test('completed Phase 4 ownership wrapper is retired while canonical invariant checks retain Phase 4/5 contracts', () => {
  assert.equal(fs.existsSync(RETIRED_OWNERSHIP_WORKFLOW), false);
  assert.match(INVARIANT_WORKFLOW, /const phaseCommands = new Set\(\['npm run phase4:test', 'npm run phase5:test'\]\)/);
  assert.match(INVARIANT_WORKFLOW, /name: 'contracts-phase'/);
  assert.match(INVARIANT_WORKFLOW, /Run exact check shard/);
  assert.match(INVARIANT_WORKFLOW, /Require complete repository check/);
});

test('dispatch-only exact-SHA Phase 4 proof keeps the permanent verifier and product proofs', () => {
  assert.match(RELEASE_WORKFLOW, /workflow_dispatch:/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /\n\s*pull_request:/);
  assert.match(RELEASE_WORKFLOW, /PRODUCT_SHA: \$\{\{ inputs\.product_sha \}\}/);
  assert.match(RELEASE_WORKFLOW, /npm run phase4:rehearsal/);
  assert.match(RELEASE_WORKFLOW, /npm run phase4:verify -- --base "\$PHASE4_BASE" --head "\$PRODUCT_SHA" --lane p4-7/);
  assert.match(RELEASE_WORKFLOW, /npm run phase4:browser/);
  assert.match(RELEASE_WORKFLOW, /HEX_ANALYSIS_ROUTE=artifact npm run userscript:test/);
  assert.match(RELEASE_WORKFLOW, /git diff --exit-code --/);
  assert.match(VERIFIER, /READY-FOR-CROSS-PHASE-INTEGRATION/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /--no-commands/);
});

test('shared generated userscript outputs remain mechanically synchronized without the retired ownership wrapper', () => {
  assert.match(GENERATED_SYNC_WORKFLOW, /npm run userscript:build/);
  assert.match(GENERATED_SYNC_WORKFLOW, /userscript\/hex\.user\.template\.js/);
  assert.match(GENERATED_SYNC_WORKFLOW, /userscript\/release-version\.json/);
  assert.match(GENERATED_SYNC_WORKFLOW, /git diff --exit-code --/);
  assert.deepEqual(MANIFEST.generatedPaths, [
    'userscript/hex.user.template.js',
    'userscript/release-version.json',
  ], 'generated outputs remain governed when a real Phase 4 lane is already running');
});

test('A: p4-3 may modify project ArtifactIndex', () => {
  expectPass('p4-3', 'js/project/artifact-index.js');
});

test('B: p4-3 cannot steal scheduler contract ownership', () => {
  expectFail('p4-3', 'js/core/scheduler/index.js');
});

test('C: p4-2 frozen scheduler entrypoint remains protected', () => {
  expectFail('p4-2', 'js/core/scheduler/index.js');
});

test('D: p4-7 may wire the canonical scheduler', () => {
  expectPass('p4-7', 'js/core/scheduler/index.js');
});

test('E: p4-7 may wire ArtifactStore exports', () => {
  expectPass('p4-7', 'js/core/artifacts/index.js');
});

test('F: Artifact contract definition remains P4-0-only', () => {
  expectFail('p4-7', 'js/core/artifacts/contracts.js');
});

test('G: p4-7 may integrate project ArtifactIndex', () => {
  expectPass('p4-7', 'js/project/artifact-index.js');
});

test('H: p4-7 may integrate representative P4-1 production paths', () => {
  for (const file of [
    'js/core/artifacts/backends.js',
    'js/core/artifacts/store.js',
    'js/core/artifacts/hot-cache.js',
    'js/core/artifacts/storage/integrity.js',
  ]) expectPass('p4-7', file);
});

test('I: p4-7 may integrate representative P4-2 production paths', () => {
  for (const file of [
    'js/core/scheduler/analysis-scheduler.js',
    'js/core/budgets/scheduler-budget.js',
  ]) expectPass('p4-7', file);
});

test('J: p4-7 may integrate P4-4 paging and ByteSource paths', () => {
  expectPass('p4-7', 'js/core/artifacts/paging/index.js');
  expectPass('p4-7', 'js/bytesource/cached.js');
});

test('K: p4-7 may integrate actual P4-5 production paths', () => {
  for (const file of [
    'js/backend.js',
    'js/cache/analysis-cache.js',
    'js/cache/artifact-orchestration.js',
  ]) expectPass('p4-7', file);
});

test('L: p4-7 may integrate P4-6 verification paths', () => {
  for (const file of [
    'tests/phase4/verification/oracles.mjs',
    'tools/validation/phase4/verify.mjs',
    'reports/phase4/README.md',
  ]) expectPass('p4-7', file);
});

test('M: semantic and decompiler forbidden paths remain forbidden to p4-7', () => {
  for (const file of [
    'js/semantics/example.js',
    'js/ir-core.js',
    'js/ir.js',
    'js/decompiler/example.js',
  ]) expectFail('p4-7', file);
});

test('N: p4-r may change governance but cannot mutate production', () => {
  expectPass('p4-r', 'tools/validation/phase-ownership/phase4.json');
  expectFail('p4-r', 'js/core/scheduler/index.js');
  expectFail('p4-r', 'js/backend.js');
});

test('O: every actual P4-1..P4-6 changed path is representable by p4-7', () => {
  for (const [component, files] of Object.entries(COMPONENT_INVENTORY)) {
    for (const file of files) {
      assert.equal(locallyOwned('p4-7', file), true, `${component}: p4-7 manifest does not represent ${file}`);
      expectPass('p4-7', file);
    }
  }
});
