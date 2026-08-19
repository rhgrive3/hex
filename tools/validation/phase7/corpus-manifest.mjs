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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import { currentSupportMatrix } from '../../../js/platform/capability-maturity.js';
import { ALIAS_QUERIES, CORPUS_ID, CORPUS_VERSION, ESCAPE_QUERIES, FIXTURE_IDS, MEMORY_LINK_QUERIES } from '../../../tests/phase7/corpus/fixtures.mjs';
import { SUMMARY_CORPUS_ID, SUMMARY_CORPUS_VERSION, SUMMARY_GRAPH_IDS, SUMMARY_QUERIES } from '../../../tests/phase7/corpus/summaries.mjs';
import { TYPE_CASES, TYPE_CORPUS_ID, TYPE_CORPUS_VERSION } from '../../../tests/phase7/corpus/types.mjs';
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

/**
 * Identity of the committed debug fixtures.
 *
 * The fixtures are real compiler and linker output, so what identifies them is
 * the build identity they carry plus a digest of their bytes: a regenerated
 * fixture has a different build id and is therefore a different corpus.
 */
function debugCorpusIdentity() {
  const read = (name) => {
    const file = path.join(ROOT, 'tests/phase7/corpus/debug', name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const dwarf = read('dwarf-fixtures.json');
  const pdb = read('pdb-fixtures.json');
  return {
    dwarf: dwarf == null ? null : {
      variants: dwarf.variants.map((variant) => ({
        name: variant.name,
        dwarfVersion: variant.dwarfVersion,
        compiler: variant.compiler ?? null,
        buildId: variant.buildId,
        sections: Object.keys(variant.sections).sort(),
        digest: stableDigest(variant.sections),
      })),
    },
    pdb: pdb == null ? null : {
      variants: pdb.variants.map((variant) => ({
        name: variant.name,
        codeView: variant.codeView,
        digest: stableDigest(variant.pdb),
      })),
    },
  };
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
    escapeQueries: ESCAPE_QUERIES.map((query) => ({
      id: query.id, fixture: query.fixture,
      expectedReasons: [...(query.expectedReasons ?? [])],
      expectNonEscapingRoots: query.expectNonEscapingRoots,
    })),
    summaryCorpus: {
      id: SUMMARY_CORPUS_ID,
      version: SUMMARY_CORPUS_VERSION,
      graphIds: [...SUMMARY_GRAPH_IDS],
      queries: SUMMARY_QUERIES.map((query) => ({
        id: query.id, graph: query.graph, root: query.root, functionId: query.functionId,
        mustIncludeWrites: [...query.mustIncludeWrites],
        mustExcludeWrites: [...query.mustExcludeWrites],
        mustBeBroad: query.mustBeBroad === true,
        completeness: query.completeness,
        converges: query.converges === true,
      })),
    },
    typeCorpus: {
      id: TYPE_CORPUS_ID,
      version: TYPE_CORPUS_VERSION,
      cases: TYPE_CASES.map((testCase) => ({
        id: testCase.id,
        entityId: testCase.entityId,
        hardKinds: testCase.hard.map((constraint) => constraint.kind).sort(),
        softKinds: testCase.soft.map((evidence) => evidence.kind).sort(),
        expectCertain: [...(testCase.expectCertain ?? [])],
        expectContradiction: [...(testCase.expectContradiction ?? [])],
        hasNoDebugVariant: testCase.noDebug != null,
      })),
    },
    debugCorpus: debugCorpusIdentity(),
    truthGenerator: { id: TRUTH_GENERATOR_ID, version: TRUTH_GENERATOR_VERSION },
    scoring: { id: SCORING_ID, version: SCORING_VERSION },
    // Exclusions are declared, never applied silently. An empty list is the
    // strongest possible statement: nothing was dropped from the denominator.
    exclusions: [],
  };
  return { ...body, manifestDigest: stableDigest(body) };
}
