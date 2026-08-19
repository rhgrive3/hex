import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverPhase5Tests } from '../run.mjs';
import {
  inventoryFromGit,
  inventoryDigest,
  loadManifest,
  validateFiles,
  validateManifest,
  validateUnionLedger,
} from '../../../tools/validation/phase5-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VALIDATOR = path.join(ROOT, 'tools/validation/phase5-ownership.mjs');
const RETIRED_PHASE5_WORKFLOW = path.join(ROOT, '.github/workflows/phase5-ownership.yml');
const RETIRED_PHASE4_WORKFLOW = path.join(ROOT, '.github/workflows/phase4-ownership.yml');
const PHASE4_RELEASE_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/phase4-release-validation.yml'), 'utf8');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase5/release-evidence.schema.json'), 'utf8'));
const MANIFEST = loadManifest();
const LANES = ['p5-0', 'p5-1', 'p5-2', 'p5-3', 'p5-4', 'p5-5', 'p5-6', 'p5-i'];

const COMPONENT_FILES = Object.freeze({
  'p5-1': [
    'js/targets/architecture/x86_64/effects/integer.js',
    'js/targets/architecture/x86_64/effects/flags.js',
    'js/targets/architecture/x86_64/effects/control.js',
    'tests/phase5/effects/int-control/add.test.mjs',
  ],
  'p5-2': [
    'js/targets/architecture/x86_64/effects/addressing.js',
    'js/targets/architecture/x86_64/effects/memory.js',
    'js/targets/architecture/x86_64/effects/string.js',
    'js/targets/architecture/x86_64/effects/atomic.js',
    'tests/phase5/effects/memory/rip-relative.test.mjs',
  ],
  'p5-3': [
    'js/targets/architecture/x86_64/effects/fp.js',
    'js/targets/architecture/x86_64/effects/simd.js',
    'js/targets/architecture/x86_64/effects/system.js',
    'tests/phase5/effects/fp-simd/sse2.test.mjs',
  ],
  'p5-4': [
    'js/targets/abi/sysv-amd64.js',
    'js/targets/abi/microsoft-x64.js',
    'tests/phase5/abi/sysv.test.mjs',
  ],
  'p5-5': [
    'js/viewer.js',
    'js/viewer/variable-instruction-index.js',
    'tests/phase5/viewer/bounds.test.mjs',
  ],
  'p5-6': [
    'tests/phase5/verification/oracle.test.mjs',
    'tools/validation/phase5/verify.mjs',
    'reports/phase5/README.md',
  ],
});

function cli(...args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function expectValid(lane, files) {
  const result = validateFiles(MANIFEST, lane, files);
  assert.equal(result.valid, true, `${lane}: ${JSON.stringify(result.violations)}`);
}

function expectInvalid(lane, files, category) {
  const result = validateFiles(MANIFEST, lane, files);
  assert.equal(result.valid, false, `${lane} unexpectedly accepted ${JSON.stringify(files)}`);
  if (category) assert.equal(result.violations.some((item) => item.category === category), true, JSON.stringify(result.violations));
}

test('manifest fixes the exact Phase 5 lane set and special-category owners', () => {
  assert.deepEqual(validateManifest(MANIFEST), []);
  assert.deepEqual(Object.keys(MANIFEST.lanes), LANES);
  assert.deepEqual(MANIFEST.componentLanes, LANES.slice(1, 7));
  assert.equal(MANIFEST.integrationLane, 'p5-i');
  assert.deepEqual(MANIFEST.contractWriteOwners['tests/phase5/corpus/**'], ['p5-0']);
  assert.deepEqual(MANIFEST.generatedWriteOwners, ['p5-0', 'p5-i']);
  assert.deepEqual(MANIFEST.releaseWriteOwners, ['p5-i']);
});

test('retired Phase 4/5 ownership wrappers are no longer active CI', () => {
  assert.equal(fs.existsSync(RETIRED_PHASE4_WORKFLOW), false);
  assert.equal(fs.existsSync(RETIRED_PHASE5_WORKFLOW), false);
});

test('Phase 4 exact-SHA release proof remains explicit and dispatch-only', () => {
  assert.match(PHASE4_RELEASE_WORKFLOW, /workflow_dispatch:/);
  assert.doesNotMatch(PHASE4_RELEASE_WORKFLOW, /\n\s*pull_request:/);
  assert.match(PHASE4_RELEASE_WORKFLOW, /product_sha:/);
  assert.match(PHASE4_RELEASE_WORKFLOW, /npm run phase4:rehearsal/);
  assert.match(PHASE4_RELEASE_WORKFLOW, /npm run phase4:verify/);
});

test('each component owns its representative inventory and cannot steal another lane', () => {
  for (const [lane, files] of Object.entries(COMPONENT_FILES)) {
    expectValid(lane, files);
    for (const otherLane of MANIFEST.componentLanes) {
      if (otherLane !== lane) expectInvalid(otherLane, [files[0]], 'outside-lane');
    }
  }
});

test('p5-i represents the complete declared component union', () => {
  const union = Object.values(COMPONENT_FILES).flat();
  expectValid('p5-i', union);
  assert.equal(new Set(union).size, union.length);
});

test('shared, frozen, generated, release-only, and forbidden policies all execute', () => {
  expectValid('p5-0', ['js/targets/architecture/index.js']);
  expectValid('p5-i', ['js/targets/architecture/index.js']);
  expectInvalid('p5-1', ['js/targets/architecture/index.js'], 'shared-integration');
  expectValid('p5-0', [
    'js/platform/worker.js',
    'js/targets/architecture/x86_64/semantic-function.js',
    'js/targets/architecture/x86_64/capstone-structured.js',
    'js/targets/architecture/x86_64/registers-core.js',
    'tests/phase5/abi/foundation.test.mjs',
  ]);

  expectValid('p5-0', ['tests/phase5/corpus/manifest.json']);
  expectInvalid('p5-i', ['tests/phase5/corpus/manifest.json'], 'frozen-contract');
  expectInvalid('p5-6', ['tools/validation/phase5/release-evidence.schema.json'], 'frozen-contract');

  expectValid('p5-0', ['userscript/hex.user.template.js']);
  expectValid('p5-i', ['userscript/release-version.json']);
  expectInvalid('p5-1', ['userscript/hex.user.template.js'], 'generated');

  expectValid('p5-i', ['.github/workflows/phase5-release-validation.yml']);
  expectInvalid('p5-0', ['.github/workflows/phase5-release-validation.yml'], 'release-only');

  for (const file of [
    'js/analyze.js',
    'js/targets/architecture/arm64/effects/integer.js',
    'js/core/scheduler/index.js',
    'js/worker-legacy.js',
    'tests/phase6/start.test.mjs',
  ]) {
    for (const lane of LANES) expectInvalid(lane, [file], 'forbidden');
  }
});

test('JSON changed-file input preserves commas and newlines and rejects legacy comma splitting', () => {
  const unsafe = 'tests/phase5/effects/int-control/comma,name\nnewline.test.mjs';
  const result = cli('--lane', 'p5-1', '--files-json', JSON.stringify([unsafe]));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.changedFiles, 1);
  assert.equal(report.inventoryDigest, inventoryDigest([unsafe]));

  const legacy = cli('--lane', 'p5-1', '--files', unsafe);
  assert.equal(legacy.status, 2);
  assert.match(legacy.stderr, /unknown argument: --files/);
});

test('single-lane actual inventory mode fails closed without both exact SHAs', () => {
  const missing = cli('--lane', 'p5-1');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /choose exactly one inventory source/);
  const symbolic = cli('--lane', 'p5-1', '--base-sha', 'HEAD', '--head-sha', 'HEAD');
  assert.equal(symbolic.status, 2);
  assert.match(symbolic.stderr, /exact 40-character commit SHA/);
});

test('Git-derived actual inventory is NUL-safe for comma and newline paths', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase5-git-inventory-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: temporary, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Phase 5 test');
    git('config', 'user.email', 'phase5@example.invalid');
    git('commit', '--allow-empty', '-q', '-m', 'foundation');
    const baseSha = git('rev-parse', 'HEAD');
    const unsafe = 'tests/phase5/effects/int-control/comma,name\nnewline.test.mjs';
    const absolute = path.join(temporary, unsafe);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'export {};\n');
    git('add', '--all');
    git('commit', '-q', '-m', 'component');
    const headSha = git('rev-parse', 'HEAD');
    const inventory = inventoryFromGit(temporary, baseSha, headSha);
    assert.deepEqual(inventory.files, [unsafe]);
    expectValid('p5-1', inventory.files);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('actual-union contract requires all exact component lanes and revalidates p5-i', () => {
  const foundationSha = 'a'.repeat(40);
  const components = MANIFEST.componentLanes.map((lane, index) => ({
    lane,
    baseSha: foundationSha,
    headSha: String(index + 1).repeat(40),
  }));
  const inventoryResolver = (_root, baseSha, headSha) => {
    const index = Number(headSha[0]) - 1;
    const lane = MANIFEST.componentLanes[index];
    return { baseSha, headSha, files: COMPONENT_FILES[lane] };
  };
  const report = validateUnionLedger(MANIFEST, { version: 1, foundationSha, components }, { inventoryResolver });
  assert.equal(report.components.length, 6);
  assert.equal(report.unionFileCount, Object.values(COMPONENT_FILES).flat().length);
  assert.match(report.unionDigest, /^[0-9a-f]{64}$/);

  assert.throws(
    () => validateUnionLedger(MANIFEST, { version: 1, foundationSha, components: components.slice(1) }, { inventoryResolver }),
    /each component lane exactly once/,
  );
  const wrongBase = structuredClone(components);
  wrongBase[0].baseSha = 'b'.repeat(40);
  assert.throws(
    () => validateUnionLedger(MANIFEST, { version: 1, foundationSha, components: wrongBase }, { inventoryResolver }),
    /does not equal the frozen foundationSha/,
  );
});

test('actual-union validation blocks a component shared-path violation rather than skip-green', () => {
  const foundationSha = 'a'.repeat(40);
  const components = MANIFEST.componentLanes.map((lane, index) => ({ lane, baseSha: foundationSha, headSha: String(index + 1).repeat(40) }));
  assert.throws(() => validateUnionLedger(MANIFEST, { version: 1, foundationSha, components }, {
    inventoryResolver: (_root, baseSha, headSha) => {
      const index = Number(headSha[0]) - 1;
      const lane = MANIFEST.componentLanes[index];
      return { baseSha, headSha, files: lane === 'p5-1' ? ['js/backend.js'] : COMPONENT_FILES[lane] };
    },
  }), /p5-1 actual inventory violates Phase 5 ownership/);
});

test('recursive runner discovers arbitrary nested tests deterministically', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase5-discovery-'));
  try {
    fs.mkdirSync(path.join(temporary, 'z/deep'), { recursive: true });
    fs.mkdirSync(path.join(temporary, 'a'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'z/deep/second.test.mjs'), '');
    fs.writeFileSync(path.join(temporary, 'a/first.test.mjs'), '');
    fs.writeFileSync(path.join(temporary, 'z/helper.mjs'), '');
    const relative = discoverPhase5Tests(temporary).map((file) => path.relative(temporary, file).replaceAll('\\', '/'));
    assert.deepEqual(relative, ['a/first.test.mjs', 'z/deep/second.test.mjs']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release schema requires every Phase 5 field and encodes null as not-proven', () => {
  const required = [
    'startMainSha', 'foundationMergeSha', 'lastReconciledMainSha', 'productSha',
    'decoderContractVersion', 'x86SemanticVersion', 'sysvAbiVersion', 'microsoftX64AbiVersion',
    'mandatoryCorpusTotal', 'mandatoryCorpusPassed', 'mandatoryCorpusFailed',
    'instructionTotal', 'exactCount', 'exactWithIntrinsicCount', 'partialCount', 'unknownCount', 'unsupportedCount',
    'decodeMismatchCount', 'machineEffectsMismatchCount', 'semanticIrMismatchCount', 'cfgMismatchCount',
    'ssaMismatchCount', 'memorySsaMismatchCount', 'abiMismatchCount', 'decompilerMismatchCount', 'viewerMismatchCount',
    'provenanceLossCount', 'unknownStoreSafetyFailures', 'unknownCallSafetyFailures', 'silentPreserveFallbackCount',
    'hiddenFallbackCount', 'genericArchitectureLeakCount', 'arm64RegressionFailures', 'phase4RegressionFailures',
    'wholeFileMaterializationFailures', 'viewerPeakRetainedBytes', 'viewerBoundedDecodeFailures',
    'artifactDeterminismFailures', 'cancellationFailures', 'budgetFailures', 'firstDivergenceCount',
    'finalCutoverStatus', 'phase5ExitGateFullySatisfied', 'phase6Started',
  ];
  for (const field of required) {
    assert.equal(SCHEMA.required.includes(field), true, `schema does not require ${field}`);
    assert.ok(SCHEMA.properties[field], `schema has no property ${field}`);
  }
  assert.equal(SCHEMA.properties.phase6Started.const, false);
  assert.equal(SCHEMA.$defs.nullableCount.oneOf.some((entry) => entry.type === 'null'), true);
  assert.equal(SCHEMA.$defs.measurement.oneOf.some((entry) => entry.properties.status.const === 'not-proven'), true);
  assert.match(SCHEMA.description, /never replace a missing measurement with zero/i);
});
