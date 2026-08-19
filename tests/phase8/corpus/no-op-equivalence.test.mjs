import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { observeCorpus } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenBaseline, qualityVector, safetyCounters } from '../../../tools/validation/phase8/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The P8-0 required proof: the Phase 8 path is semantically, textually and
 * provenance-wise identical to the pre-Phase-8 product on the whole corpus.
 *
 * The baseline is real output captured from the product at the Phase 8 base
 * commit, not a hand-written expectation. Once an optimizer lands this test
 * becomes the regression that says exactly which functions it changed, which is
 * the point: a quality change should be visible as a diff against evidence, not
 * as a claim.
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
});

test('the corpus carries its toolchain identity', () => {
  const corpus = loadCorpus();
  assert.match(corpus.toolchain.compiler, /clang/i);
  assert.equal(corpus.toolchain.target, 'aarch64-unknown-linux-gnu');
  assert.ok(corpus.toolchain.optimizationLevels.length >= 3);
});

test('every corpus function decompiles without throwing', () => {
  const failed = observations.filter((observation) => observation.failure);
  assert.deepEqual(failed.map((observation) => `${observation.id}: ${observation.failure}`), []);
});

test('the Phase 8 path is output-identical to the pre-Phase-8 product', () => {
  for (const observation of observations) {
    const before = byId.get(observation.id);
    assert.ok(before, `no baseline for ${observation.id}`);
    const { phase8, ...candidate } = observation;
    assert.deepEqual(candidate, before, `Phase 8 changed the output of ${observation.id} while it is still a no-op`);
  }
});

test('provenance is preserved exactly, not merely in count', () => {
  for (const observation of observations.filter((item) => item.semantic)) {
    const before = byId.get(observation.id);
    assert.equal(observation.provenanceDigest, before.provenanceDigest,
      `source addresses/rows changed for ${observation.id}`);
    assert.equal(observation.sourceMappedNodes, before.sourceMappedNodes);
  }
});

test('the hard-zero safety counters are zero against the frozen baseline', () => {
  const counters = safetyCounters(observations, baseline);
  assert.equal(counters.semanticMismatchCount, 0, JSON.stringify(counters.details));
  assert.equal(counters.provenanceLossCount, 0, JSON.stringify(counters.details));
  assert.equal(counters.unknownSafetyRegressionCount, 0, JSON.stringify(counters.details));
});

test('the readability vector has not moved', () => {
  assert.deepEqual(qualityVector(observations), qualityVector(baseline.observations));
});

test('the Phase 8 ledger reaches the product result for every semantic function', () => {
  for (const observation of observations.filter((item) => item.semantic)) {
    assert.ok(observation.phase8, `no Phase 8 ledger published for ${observation.id}`);
    assert.equal(observation.phase8.published, true);
    assert.equal(observation.phase8.transformCount, 0, 'the identity pass must not transform anything');
    assert.deepEqual(observation.phase8.invalidated, []);
  }
});

test('the ledger publication digest is stable across runs', () => {
  const again = observeCorpus();
  for (let index = 0; index < observations.length; index += 1) {
    assert.equal(again[index].phase8?.publicationDigest, observations[index].phase8?.publicationDigest,
      `Phase 8 publication is not deterministic for ${observations[index].id}`);
  }
});

test('the frozen corpus is committed rather than rebuilt at test time', () => {
  // A corpus regenerated per run is a different question set per run. The
  // builder exists to change it deliberately, not as a test-time dependency on
  // whichever clang happens to be installed.
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/phase8/corpus/functions.json')));
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/phase8/corpus/pre-phase8-observations.json')));
});
