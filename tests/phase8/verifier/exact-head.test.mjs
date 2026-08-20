import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectPhase8Metrics } from '../../../tools/validation/phase8/metrics.mjs';
import {
  PROFILE, SCHEMA_VERSION, VERIFIER_VERSION, mandatoryArchitectureLanes,
  publish, renderMarkdown, validateEvidence, verifyPhase8,
} from '../../../tools/validation/phase8/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The verifier exists from P8-0 and is exercised from the first checkpoint, so
 * final verification is a re-run rather than a first meeting (EP-011). These
 * tests prove verifier correctness — that it reports the truth and fails
 * closed — which is a separate question from product correctness (§3.5).
 */

// Collected once. Verifier-correctness cases reuse it; they are testing verdict
// logic, not re-measuring the product.
const metrics = collectPhase8Metrics({ repetitions: 1 });
const report = verifyPhase8({ shadow: true, metrics });

test('the verifier reports the truth at an early checkpoint, never READY by absence', () => {
  assert.notEqual(report.verdict, 'READY',
    'Phase 8 has no accepted checkpoints yet; READY here would mean the verifier passes on missing capability');
  assert.ok(report.failures.length > 0);
  assert.ok(report.failures.every((failure) => typeof failure.firstDivergence === 'string' && failure.firstDivergence.length > 0),
    'every failure must name the first divergence, not just a category');
});

test('a counter that is not measured yet is missing evidence, never zero', () => {
  // P8-5 landed the edge accounting, so `lostCfgEdgeCount` is now a measured
  // number. `forcedTypeContradictionCount` is not measurable until P8-6 and must
  // still read as missing evidence rather than as a passing zero.
  assert.equal(typeof report.safety.lostCfgEdgeCount, 'number');
  assert.equal(typeof report.safety.forcedTypeContradictionCount, 'number');
  const coverage = report.failures.filter((failure) => failure.category === 'coverage').map((failure) => failure.firstDivergence);
  assert.ok(!coverage.some((text) => text.includes('lostCfgEdgeCount')),
    'a measured counter must not still be reported as missing evidence');
  assert.ok(!coverage.some((text) => text.includes('forcedTypeContradictionCount')));

  // The rule itself, pinned independently of which counters happen to be
  // measured today: a null counter is a blocking coverage failure, never a pass.
  const withNull = verifyPhase8({
    shadow: true,
    metrics: { ...metrics, safety: { ...metrics.safety, lostCfgEdgeCount: null } },
  });
  const nulled = withNull.failures.filter((failure) => failure.category === 'coverage').map((failure) => failure.firstDivergence);
  assert.ok(nulled.some((text) => text.includes('lostCfgEdgeCount')));
});

test('no aggregate candidate was allowed to be certain over a contradiction', () => {
  const certainty = report.safety.aggregateCertainty;
  assert.ok(certainty, 'the verifier must carry the certainty it measured');
  assert.equal(certainty.forcedTypeContradictionCount, 0);
  assert.deepEqual(certainty.functionsWithoutFacts, []);
  assert.ok(certainty.regionCount > 0);
  // Regions that kept more than one shape are the point of the checkpoint, so a
  // corpus where nothing is ambiguous would mean the model is not being used.
  assert.ok(certainty.ambiguousRegionCount > 0);
});

test('providers refine without changing what they refine, and none exceeded its authority', () => {
  const evidence = report.safety.providerEvidence;
  assert.ok(evidence, 'the verifier must carry the provider evidence it measured');
  // Switching the refinement layer on must not move a single generic fact.
  assert.equal(evidence.providerOffDivergenceCount, 0, JSON.stringify(evidence.providerOffDivergences));
  assert.equal(evidence.providerAuthorityFailureCount, 0, JSON.stringify(evidence.providerAuthorityFailures));
  assert.deepEqual(evidence.functionsWithoutFacts, []);
  // Provider-on has to actually do something, or the layer is untested.
  assert.ok(evidence.hintCount > 0);
  assert.ok(evidence.functionsWithHints > 0);
  // And the cap has to have done work on real input, not only in a unit test.
  assert.ok(evidence.cappedCount > 0, 'no hint was ever capped, so the ceiling is unexercised');
});

test('the edge accounting covers every corpus function and loses nothing', () => {
  const accounting = report.safety.edgeAccounting;
  assert.ok(accounting, 'the verifier must carry the accounting it measured');
  assert.equal(accounting.lostCfgEdgeCount, 0);
  assert.deepEqual(accounting.functionsWithoutIr, []);
  assert.deepEqual(accounting.functionsWithoutFacts, []);
  assert.ok(accounting.edgeCount > 0);
  // Residual jumps are reported and not gated. Their presence or absence must
  // not appear in the failure list at all.
  assert.ok(!report.failures.some((failure) => String(failure.firstDivergence).includes('residualGoto')));
});

test('a mandatory architecture lane with no evidence is blocking', () => {
  const lanes = mandatoryArchitectureLanes();
  assert.ok(lanes.includes('arm64'));
  // Live capability truth is the source. If it lists a lane Phase 8 has no
  // corpus for, that is missing evidence and must appear as a failure.
  const uncovered = report.architectureLanes.filter((lane) => !lane.hasEvidence).map((lane) => lane.lane);
  for (const lane of uncovered) {
    assert.ok(report.failures.some((failure) => failure.category === 'architecture' && failure.actual === 'missing' && failure.firstDivergence.includes(lane)),
      `uncovered lane ${lane} did not produce a blocking failure`);
  }
  assert.ok(report.architectureLanes.some((lane) => lane.lane === 'arm64' && lane.hasEvidence));
});

test('every verdict binds product, verifier, profile, corpus and registry identity', () => {
  assert.match(report.product.commitSha, /^[0-9a-f]{40}$/);
  assert.match(report.product.treeSha, /^[0-9a-f]{40}$/);
  assert.equal(report.verifierVersion, VERIFIER_VERSION);
  assert.equal(report.profileVersion, PROFILE.profileVersion);
  assert.ok(report.corpus.corpusDigest);
  assert.ok(report.corpus.toolchain.compiler);
  assert.ok(report.corpus.frozenBaselineDigest);
  assert.ok(report.registry.passRegistryDigest);
  assert.match(report.verifierSourceSha256, /^[0-9a-f]{64}$/);
  assert.ok(report.evidenceDigest);
});

test('an exact-head mismatch is blocking', () => {
  const mismatched = verifyPhase8({ shadow: true, expectedSha: '0'.repeat(40), metrics });
  assert.ok(mismatched.failures.some((failure) => failure.category === 'identity'
    && failure.firstDivergence.includes('does not match the requested exact head')));
});

test('evidence is validated against its own schema before publication', () => {
  assert.deepEqual(validateEvidence(report), []);
  assert.ok(validateEvidence({ ...report, verdict: 'PROBABLY' }).some((error) => error.includes('invalid verdict')));
  assert.ok(validateEvidence({ ...report, schemaVersion: 'other' }).some((error) => error.includes('schemaVersion')));
  const { safety, ...withoutSafety } = report;
  assert.ok(validateEvidence(withoutSafety).some((error) => error.includes('missing field: safety')));
});

test('publication is atomic and refuses invalid evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-evidence-'));
  try {
    assert.throws(() => publish({ ...report, verdict: 'PROBABLY' }, directory), /failed its own schema/);
    assert.deepEqual(fs.readdirSync(directory), [], 'a rejected report must leave nothing behind');
    publish(report, directory);
    const written = fs.readdirSync(directory).sort();
    assert.deepEqual(written, ['phase8-release-evidence.json', 'phase8-release-evidence.md']);
    for (const name of written) assert.ok(fs.statSync(path.join(directory, name)).size > 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the rendered report names the verdict and the failures', () => {
  const markdown = renderMarkdown(report);
  assert.ok(markdown.startsWith(`# Phase 8 release evidence — ${report.verdict}`));
  assert.ok(markdown.includes('Hard-zero safety counters'));
  assert.ok(markdown.includes('not measured'));
});

test('the frozen profile still enumerates the gates and checkpoints Phase 8 is judged by', () => {
  assert.deepEqual(PROFILE.requiredCheckpoints, ['P8-0', 'P8-1', 'P8-2', 'P8-3', 'P8-4', 'P8-5', 'P8-6', 'P8-7', 'P8-I']);
  for (const gate of ['npm run phase8:test', 'npm run migration:test', 'npm run decompiler:test', 'npm run compiler-truth']) {
    assert.ok(PROFILE.requiredGates.includes(gate), `required gate missing from the frozen profile: ${gate}`);
  }
  assert.equal(PROFILE.quality.gotosAreNotACorrectnessGoal, true,
    'goto count is a readability signal; making it a correctness goal produces false structure');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const gate of PROFILE.requiredGates) {
    assert.ok(packageJson.scripts[gate.replace(/^npm run /, '')], `frozen profile names a script that does not exist: ${gate}`);
  }
});

test('the evidence schema version is the one the verifier writes', () => {
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
});
