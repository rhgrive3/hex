import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, observeCorpus } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenBaseline, qualityVector, safetyCounters } from '../../../tools/validation/phase8/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * P8-I keeps the P8-0 frozen-baseline proof but no longer requires a no-op:
 * the final product is expected to improve its high-level projection. The
 * invariant is now same questions + conservative safety + preserved provenance
 * + the profile's required strict readability improvements.
 */

const baseline = loadFrozenBaseline();
const observations = observeCorpus();
const byId = new Map(baseline.observations.map((observation) => [observation.id, observation]));

test('the frozen baseline was captured against the frozen corpus', () => {
  const corpus = loadCorpus();
  assert.equal(baseline.corpusDigest, corpus.corpusDigest,
    'the baseline and the corpus have drifted apart; a comparison across two question sets proves nothing');
  assert.equal(baseline.observationsDigest, stableDigest(baseline.observations),
    'the frozen baseline does not match its own digest');
  assert.equal(baseline.observations.length, corpus.functions.length);
  assert.match(baseline.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(baseline.baseCommit, 'bd03d1a860863814dbdcc00559709794d460189d');
});

test('the corpus carries all mandatory architecture and toolchain identities', () => {
  const corpus = loadCorpus();
  assert.match(corpus.toolchain.compiler, /clang/i);
  assert.deepEqual(corpus.toolchain.targets.map((target) => target.architectureId).sort(), ['arm64', 'riscv64', 'x86_64']);
  assert.deepEqual([...new Set(corpus.functions.map((entry) => entry.architectureId))].sort(), ['arm64', 'riscv64', 'x86_64']);
  assert.deepEqual(Object.fromEntries(['arm64', 'x86_64', 'riscv64'].map((architectureId) => [architectureId,
    corpus.functions.filter((entry) => entry.architectureId === architectureId).length])), {
    arm64:45, x86_64:45, riscv64:45,
  });
  assert.ok(corpus.toolchain.optimizationLevels.length >= 3);
});

test('every corpus function decompiles without throwing', () => {
  const failed = observations.filter((observation) => observation.failure);
  assert.deepEqual(failed.map((observation) => `${observation.id}: ${observation.failure}`), []);
});

test('candidate and baseline use exactly the same denominator', () => {
  assert.deepEqual(observations.map((observation) => observation.id), baseline.observations.map((observation) => observation.id));
  for (const observation of observations) assert.ok(byId.has(observation.id), `no baseline for ${observation.id}`);
});

test('every function on the semantic path reports complete, and no legacy value invents completeness', () => {
  for (const observation of observations) {
    if (observation.semantic) assert.equal(observation.completeness, 'complete', `${observation.id} did not run to its fixed point`);
    else assert.equal(observation.completeness, null, `${observation.id} reported pipeline completeness from the legacy path`);
  }
});

test('provenance coverage is preserved, and mapped product rows do not disappear', () => {
  for (const observation of observations.filter((item) => item.semantic)) {
    const before = byId.get(observation.id);
    assert.ok(before?.semantic, `semantic candidate ${observation.id} lost its semantic baseline identity`);
    assert.ok(observation.sourceMappedNodes >= before.sourceMappedNodes,
      `source mapping coverage regressed for ${observation.id}: ${before.sourceMappedNodes} -> ${observation.sourceMappedNodes}`);
  }
});

test('the direct baseline comparator keeps its three hard safety counters at zero', () => {
  // safetyCounters() intentionally owns only these direct candidate-vs-baseline
  // checks. The remaining hard-zero counters are independent recomputations in
  // collectPhase8Metrics()/verify.mjs and are covered by exact-head verifier tests.
  const counters = safetyCounters(observations, baseline);
  for (const key of ['semanticMismatchCount', 'provenanceLossCount', 'unknownSafetyRegressionCount']) {
    assert.equal(counters[key], 0, `${key}: ${JSON.stringify(counters.details)}`);
  }
});

test('the final quality vector makes both required strict improvements without directional regressions', () => {
  const before = qualityVector(baseline.observations);
  const after = qualityVector(observations);
  assert.equal(after.functions, before.functions);
  assert.equal(after.failures, 0);
  assert.ok(after.semanticCoverage >= before.semanticCoverage, `semantic coverage ${before.semanticCoverage} -> ${after.semanticCoverage}`);
  assert.ok(after.rawAssemblyFallbacks <= before.rawAssemblyFallbacks, `raw assembly ${before.rawAssemblyFallbacks} -> ${after.rawAssemblyFallbacks}`);
  assert.ok(after.gotos <= before.gotos, `gotos ${before.gotos} -> ${after.gotos}`);
  assert.ok(after.structuredFunctions >= before.structuredFunctions, `structured ${before.structuredFunctions} -> ${after.structuredFunctions}`);
  assert.ok(after.sourceMappedNodes >= before.sourceMappedNodes, `source map ${before.sourceMappedNodes} -> ${after.sourceMappedNodes}`);
  assert.ok(after.aggregateLayouts >= before.aggregateLayouts, `aggregates ${before.aggregateLayouts} -> ${after.aggregateLayouts}`);
  assert.ok(after.highVariableGroups >= before.highVariableGroups, `high variables ${before.highVariableGroups} -> ${after.highVariableGroups}`);
  assert.ok(after.redundantCasts < before.redundantCasts, `redundant casts must strictly improve: ${before.redundantCasts} -> ${after.redundantCasts}`);
  assert.ok(after.temporaries < before.temporaries, `temporaries must strictly improve: ${before.temporaries} -> ${after.temporaries}`);
});

test('the Phase 8 ledger reaches the product result for every semantic function', () => {
  for (const observation of observations.filter((item) => item.semantic)) {
    assert.ok(observation.phase8, `no Phase 8 ledger published for ${observation.id}`);
    assert.equal(observation.phase8.published, true);
    assert.equal(observation.phase8.completeness, 'complete', `${observation.id} did not reach a fixed point`);
    assert.deepEqual(observation.phase8.produced, ['aggregates', 'deadCode', 'induction', 'providerHints', 'ranges', 'structuredRegions', 'valueNumbers'],
      `${observation.id} did not publish the full middle-end fact set`);
    assert.deepEqual(observation.phase8.invalidated, [], 'publishing facts must not invalidate anything');
  }
});

test('the final projection is proof-carrying and actually cuts over on this corpus', () => {
  const transformed = observations.filter((observation) => (observation.phase8Projection?.transformCount ?? 0) > 0);
  assert.ok(transformed.length > 0, 'the P8-I product projection never consumed a proved Phase 8 fact');
});

test('the interactive path runs only the canonical-facts stage', () => {
  const entry = loadCorpus().functions.find((item) => item.id === 'quality.loop_nested.O2');
  const interactive = decompileEntry(entry, { phase8Optimize:false });
  assert.ok(interactive.result, interactive.failure);
  assert.deepEqual([...interactive.result.phase8.enabledStages], ['canonical-facts']);
  assert.equal(interactive.result.phase8.transformCount, 0);
  assert.equal(interactive.result.phase8.published, true);
});

test('the ledger publication digest is stable across runs', () => {
  const again = observeCorpus();
  for (let index = 0; index < observations.length; index += 1) {
    assert.equal(again[index].phase8?.publicationDigest, observations[index].phase8?.publicationDigest,
      `Phase 8 publication is not deterministic for ${observations[index].id}`);
  }
});

test('the frozen corpus and baseline identity are committed rather than rebuilt at test time', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/phase8/corpus/functions.json')));
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/phase8/corpus/pre-phase8-observations.json')));
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/phase8/corpus/pre-phase8-baseline-identity.json')));
});
