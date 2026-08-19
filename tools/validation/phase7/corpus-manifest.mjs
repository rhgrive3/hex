/**
 * Phase 7 corpus/query/truth/scoring manifest.
 *
 * The manifest is generated from live capability truth rather than copied from
 * the planning document, because the planning document's architecture matrix is
 * a review-time observation and goes stale (§5.1, §12.4). It is then frozen to
 * disk so a candidate cannot quietly change what is measured: baseline and
 * candidate must bind to the same manifest digest, or the comparison is a new
 * series and the baseline has to be re-run (FM-16).
 */

import { stableDigest } from '../../../js/core/identity/index.js';
import { currentSupportMatrix } from '../../../js/platform/capability-maturity.js';
import { ALIAS_QUERIES, CORPUS_ID, CORPUS_VERSION, FIXTURE_IDS, MEMORY_LINK_QUERIES } from '../../../tests/phase7/corpus/fixtures.mjs';
import { SCORING_ID, SCORING_VERSION, TRUTH_GENERATOR_ID, TRUTH_GENERATOR_VERSION } from './scoring.mjs';

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * An architecture is a mandatory Phase 7 semantic lane when live capability
 * truth says the shared middle end actually runs on it. `partial` coverage may
 * add supporting evidence but cannot stand in for a mandatory lane (§5.1).
 */
export function mandatoryArchitectureLanes(matrix = currentSupportMatrix()) {
  return matrix.architectures
    .filter((architecture) => architecture.features.cfgSemanticIR === 'supported'
      && architecture.features.ssaMemoryDataflow === 'supported')
    .map((architecture) => architecture.id)
    .sort();
}

export function supplementaryArchitectureLanes(matrix = currentSupportMatrix()) {
  const mandatory = new Set(mandatoryArchitectureLanes(matrix));
  return matrix.architectures
    .filter((architecture) => !mandatory.has(architecture.id)
      && architecture.features.cfgSemanticIR !== 'unsupported')
    .map((architecture) => architecture.id)
    .sort();
}

/** Formats whose loaders are proven enough to carry debug/discovery evidence. */
export function debugFormatLanes(matrix = currentSupportMatrix()) {
  return matrix.formats
    .filter((format) => format.features.parseStructures === 'supported' && format.features.correctMapping === 'supported')
    .map((format) => format.id)
    .sort();
}

export function buildCorpusManifest({ matrix = currentSupportMatrix() } = {}) {
  const body = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    corpusId: CORPUS_ID,
    corpusVersion: CORPUS_VERSION,
    architectureLanes: {
      mandatory: mandatoryArchitectureLanes(matrix),
      supplementary: supplementaryArchitectureLanes(matrix),
    },
    formatLanes: debugFormatLanes(matrix),
    fixtureIds: [...FIXTURE_IDS],
    aliasQueries: ALIAS_QUERIES.map((query) => ({
      id: query.id, fixture: query.fixture, left: query.left, right: query.right,
      truth: query.truth, expectStrong: query.expectStrong === true,
    })),
    memoryLinkQueries: MEMORY_LINK_QUERIES.map((query) => ({
      id: query.id, fixture: query.fixture, load: query.load, truth: query.truth,
      expectedStore: query.expectedStore ?? null,
    })),
    truthGenerator: { id: TRUTH_GENERATOR_ID, version: TRUTH_GENERATOR_VERSION },
    scoring: { id: SCORING_ID, version: SCORING_VERSION },
    // Exclusions are declared, never applied silently. An empty list is the
    // strongest possible statement: nothing was dropped from the denominator.
    exclusions: [],
  };
  return { ...body, manifestDigest: stableDigest(body) };
}
