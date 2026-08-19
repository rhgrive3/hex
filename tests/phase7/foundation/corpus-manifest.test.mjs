import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { currentSupportMatrix } from '../../../js/platform/capability-maturity.js';
import {
  buildCorpusManifest,
  mandatoryArchitectureLanes,
} from '../../../tools/validation/phase7/corpus-manifest.mjs';
import { ALIAS_QUERIES, FIXTURE_IDS, MEMORY_LINK_QUERIES, buildFixture } from '../corpus/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FROZEN = path.join(ROOT, 'tests/phase7/corpus/manifest.json');

test('the frozen manifest matches a regeneration on this head', () => {
  // If these diverge, the measured question set moved underneath the candidate
  // and every comparison against the old numbers is a different series.
  const frozen = JSON.parse(fs.readFileSync(FROZEN, 'utf8'));
  const regenerated = buildCorpusManifest();
  assert.equal(frozen.manifestDigest, regenerated.manifestDigest,
    'regenerate with tools/validation/phase7/corpus-manifest.mjs and re-run the baseline');
  assert.deepEqual(frozen.aliasQueries.map((query) => query.id), regenerated.aliasQueries.map((query) => query.id));
});

test('mandatory architecture lanes come from live capability truth, not the runbook', () => {
  const matrix = currentSupportMatrix();
  const lanes = mandatoryArchitectureLanes(matrix);
  assert.ok(lanes.length >= 3, 'Phase 7 requires at least the three proven middle-end lanes');
  for (const lane of lanes) {
    const architecture = matrix.architectures.find((item) => item.id === lane);
    assert.equal(architecture.features.cfgSemanticIR, 'supported');
    assert.equal(architecture.features.ssaMemoryDataflow, 'supported');
  }
  // A partial architecture may add supporting evidence but cannot stand in for
  // a mandatory lane.
  const partial = matrix.architectures.filter((item) => item.features.cfgSemanticIR === 'partial').map((item) => item.id);
  for (const id of partial) assert.ok(!lanes.includes(id), `partial architecture admitted as mandatory: ${id}`);
});

test('every query points at a fixture that exists and builds', () => {
  for (const query of [...ALIAS_QUERIES, ...MEMORY_LINK_QUERIES]) {
    assert.ok(FIXTURE_IDS.includes(query.fixture), `query ${query.id} names an unknown fixture`);
    assert.doesNotThrow(() => buildFixture(query.fixture), `fixture failed to build: ${query.fixture}`);
  }
});

test('query ids are unique and truth is declared for every query', () => {
  const ids = ALIAS_QUERIES.map((query) => query.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate alias query id');
  for (const query of ALIAS_QUERIES) {
    assert.ok(['no', 'must', 'may-or-weaker'].includes(query.truth), `query ${query.id} has no declared truth`);
  }
  for (const query of MEMORY_LINK_QUERIES) {
    assert.ok(['exact', 'blocked'].includes(query.truth), `link query ${query.id} has no declared truth`);
    if (query.truth === 'exact') assert.ok(query.expectedStore, `exact link query ${query.id} must name its store`);
  }
});

test('the manifest declares no silent exclusions', () => {
  // A fixture or query may only leave the denominator through a versioned
  // manifest change, never quietly (FM-16).
  assert.deepEqual(buildCorpusManifest().exclusions, []);
});

test('the manifest covers every fixture in the corpus', () => {
  const manifest = buildCorpusManifest();
  assert.deepEqual([...manifest.fixtureIds].sort(), [...FIXTURE_IDS].sort());
});
