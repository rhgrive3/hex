import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { median, readJson, validateBaseline } from '../tools/benchmark/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const baselinePath = path.join(here, 'benchmark-baseline.json');
const fixtureManifestPath = path.join(here, 'fixtures', 'real-binaries.json');
const baseline = validateBaseline(readJson(baselinePath));
const fixtureManifest = readJson(fixtureManifestPath);

assert.equal(median([5, 1, 3]), 3);
assert.equal(median([4, 2]), 3);
assert.equal(median([]), null);

const expectedFixtures = Object.fromEntries(Object.entries(fixtureManifest.fixtures).map(([name, spec]) => [name, {
  size: spec.size,
  sha256: spec.sha256,
}]));
assert.deepEqual(baseline.fixtures, expectedFixtures, 'baseline fixture identity must exactly match the canonical pinned manifest');
assert.equal(baseline.baseline.sourceCommit, '9c20307faf02a56326fdb888db455eb8917612e2');
assert.equal(baseline.baseline.sourceTree, '624d2ee019184d6fbdf306d6415ab92ac5c939fe');
assert.deepEqual(Object.keys(baseline.observations.accuracy.targets).sort(), ['BattleCats', 'TsumTsum', 'YWP']);
assert.deepEqual(Object.keys(baseline.observations.binary.targets).sort(), ['TsumTsum', 'YWP', 'battlecats']);
assert.equal(baseline.observations.compilerTruth.semanticMismatches, 0);
assert.equal(baseline.observations.compilerTruth.semanticUnverified, 0);
assert.equal(baseline.observations.compilerTruth.decompilerSemanticRegressions, 0);
assert.deepEqual(baseline.observations.compilerTruth.ghidra, { status: 'ok', parsed: 6, expected: 6 });
assert.ok(baseline.regressionPolicy.deterministicWork.maxRatio >= 1);
assert.ok(baseline.regressionPolicy.deterministicWork.maxRatio <= 1.10, 'deterministic work tolerance is too loose');

for (const metric of Object.values(baseline.metrics.performance)) {
  if (metric.unit === 'ms') assert.notEqual(metric.gate, 'blocking', 'wall-clock metric must not block PRs');
}

for (const id of ['extentPrecision', 'extentRecall', 'cfgEdges', 'falseCertainty']) {
  assert.equal(baseline.metrics.accuracy[id].status, 'unmeasured');
  assert.equal(baseline.metrics.accuracy[id].gate, 'none');
}
for (const id of ['coldOpen', 'warmOpen', 'activeFunctionAnalysis', 'decompilerLatency', 'searchLatency', 'peakMemory', 'cancellationLatency', 'ttfua']) {
  assert.equal(baseline.metrics.performance[id].status, 'unmeasured');
  assert.equal(baseline.metrics.performance[id].gate, 'none');
}

const fabricated = structuredClone(baseline);
fabricated.metrics.performance.ttfua.value = 0;
assert.throws(() => validateBaseline(fabricated), /must not fabricate a value/);

function compare(args) {
  return spawnSync(process.execPath, ['tools/benchmark/compare.mjs', `--baseline=${path.relative(root, baselinePath)}`, ...args], { cwd: root, encoding: 'utf8' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-benchmark-baseline-'));
try {
  const accuracy = {
    schema: 1,
    kind: 'accuracy',
    completeness: 'complete',
    targets: structuredClone(baseline.observations.accuracy.targets),
  };
  for (const [name, target] of Object.entries(accuracy.targets)) {
    const fixtureKey = name === 'BattleCats' ? 'battlecats' : name;
    target.fixture = { ...baseline.fixtures[fixtureKey] };
    target.featureScores = { ...target.featureFloors };
    delete target.featureFloors;
  }
  const accuracyPath = path.join(tmp, 'accuracy.json');
  fs.writeFileSync(accuracyPath, JSON.stringify(accuracy));
  let result = compare([`--accuracy=${accuracyPath}`]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const badAccuracy = structuredClone(accuracy);
  badAccuracy.targets.BattleCats.functionStartRecall -= 0.001;
  fs.writeFileSync(accuracyPath, JSON.stringify(badAccuracy));
  result = compare([`--accuracy=${accuracyPath}`]);
  assert.notEqual(result.status, 0, 'accuracy regression comparator must fail closed');

  const compilerTruth = {
    schema: 1,
    kind: 'compiler-truth',
    completeness: 'complete',
    executed: 36,
    expectedCases: 36,
    semanticMismatches: 0,
    semanticUnverified: 0,
    hardFailures: 0,
    decompilerSemanticRegressions: 0,
    ghidra: { status: 'ok', parsed: 6, expected: 6 },
  };
  const compilerPath = path.join(tmp, 'compiler.json');
  fs.writeFileSync(compilerPath, JSON.stringify(compilerTruth));
  result = compare([`--compiler-truth=${compilerPath}`]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const badCompiler = structuredClone(compilerTruth);
  badCompiler.semanticMismatches = 1;
  fs.writeFileSync(compilerPath, JSON.stringify(badCompiler));
  result = compare([`--compiler-truth=${compilerPath}`]);
  assert.notEqual(result.status, 0, 'semantic mismatch must fail closed');

  const binary = { schema: 1, kind: 'binary-benchmark', samplesPerTarget: baseline.baseline.environment.binarySamplesPerTarget, targets: {} };
  for (const [name, expected] of Object.entries(baseline.observations.binary.targets)) {
    binary.targets[name] = {
      fixture: { ...baseline.fixtures[name] },
      ...expected.identity,
      work: { ...expected.work },
    };
  }
  const binaryPath = path.join(tmp, 'binary.json');
  fs.writeFileSync(binaryPath, JSON.stringify(binary));
  result = compare([`--binary=${binaryPath}`]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const badBinary = structuredClone(binary);
  badBinary.targets.battlecats.work.totalRequestedBytes = Math.ceil(
    baseline.observations.binary.targets.battlecats.work.totalRequestedBytes * baseline.regressionPolicy.deterministicWork.maxRatio,
  ) + 1;
  fs.writeFileSync(binaryPath, JSON.stringify(badBinary));
  result = compare([`--binary=${binaryPath}`]);
  assert.notEqual(result.status, 0, 'deterministic work amplification must fail');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('benchmark baseline schema/regression policy: PASS');
