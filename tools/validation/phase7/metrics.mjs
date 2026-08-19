import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { ALIAS_QUERIES, buildFixture, memoryAccessOf, regionOf, scoreAliasQueries, scoreMemoryLinks } from './scoring.mjs';

/**
 * Collects every Phase 7 measurement the verifier judges.
 *
 * The rule that shapes this file: a capability that is not implemented yet must
 * report *absent*, not zero. Zero looks like success to an aggregate, and
 * "green by absence" is exactly the failure the process guardrails call out.
 * Each lane below therefore probes for its module and returns an explicit
 * `available: false` when it is missing, which the verifier turns into a
 * blocking failure rather than a passing number.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECKPOINT_LEDGER = path.join(ROOT, 'reports/phase7/checkpoints.json');

async function optionalModule(specifier) {
  try { return await import(specifier); }
  catch { return null; }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timed(repetitions, run) {
  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = process.hrtime.bigint();
    run(index);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { medianMs: Number(median(samples).toFixed(3)), samples: samples.map((value) => Number(value.toFixed(3))) };
}

const solverCache = new Map();
function solverFor(built) {
  if (!solverCache.has(built)) {
    solverCache.set(built, createPhase7AliasSolver({
      ir: built.ir,
      cfg: built.cfg,
      ssa: built.ssa,
      options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
    }));
  }
  return solverCache.get(built);
}

/** The conservative pre-Phase-7 answer: the region safety floor, unchanged. */
function baselineAliasAnswer(query) {
  const built = buildFixture(query.fixture);
  return aliasMemoryRegions(regionOf(built, query.left), regionOf(built, query.right));
}

/** The candidate: A1 region identity refined by A2 field-sensitive points-to. */
function candidateAliasAnswer(query) {
  const built = buildFixture(query.fixture);
  return solverFor(built).alias(regionOf(built, query.left), regionOf(built, query.right), {
    leftAccess: memoryAccessOf(built, query.left),
    rightAccess: memoryAccessOf(built, query.right),
  }).relation;
}

const floorFactory = () => (left, right) => aliasMemoryRegions(left, right);
const phase7Factory = ({ ir, cfg, ssa }) => createPhase7AliasSolver({ ir, cfg, ssa }).queryAlias;

export { solverFor, phase7Factory, floorFactory };

function acceptedCheckpoints() {
  if (!fs.existsSync(CHECKPOINT_LEDGER)) return [];
  try {
    const ledger = JSON.parse(fs.readFileSync(CHECKPOINT_LEDGER, 'utf8'));
    return (ledger.checkpoints ?? [])
      .filter((checkpoint) => checkpoint.result === 'accepted')
      .map((checkpoint) => String(checkpoint.id));
  } catch { return []; }
}

async function summaryMetrics() {
  const module = await optionalModule('./lanes/summary.mjs');
  if (!module) return { available: false, reason: 'summary-analysis-not-implemented' };
  return module.collectSummaryMetrics();
}

async function escapeMetrics() {
  const module = await optionalModule('./lanes/summary.mjs');
  if (!module?.collectEscapeMetrics) return { available: false, reason: 'escape-analysis-not-implemented' };
  return module.collectEscapeMetrics();
}

async function typeMetrics() {
  const module = await optionalModule('./lanes/types.mjs');
  if (!module) return { available: false, candidate: { falseCertainty: Number.POSITIVE_INFINITY }, reason: 'type-constraint-graph-not-implemented' };
  return module.collectTypeMetrics();
}

async function debugMetrics() {
  const module = await optionalModule('./lanes/debug.mjs');
  if (!module) return { available: false, ecosystems: {}, reason: 'debug-providers-not-implemented' };
  return module.collectDebugMetrics();
}

async function discoveryMetrics() {
  const module = await optionalModule('./lanes/discovery.mjs');
  if (!module) {
    return {
      available: false,
      candidate: { falseStarts: Number.POSITIVE_INFINITY },
      reason: 'function-discovery-not-implemented',
    };
  }
  return module.collectDiscoveryMetrics();
}

async function architectureLaneMetrics(manifestLanes) {
  const module = await optionalModule('../../../tests/phase7/crossarch/laws.mjs');
  const lanes = {};
  for (const lane of manifestLanes) {
    if (!module) { lanes[lane] = { available: false, genericLawsHold: false, reason: 'metamorphic-laws-not-implemented' }; continue; }
    lanes[lane] = module.evaluateGenericLaws(lane);
  }
  return lanes;
}

export async function collectPhase7MetricsAsync({ manifestLanes = ['arm64', 'riscv64', 'x86_64'], repetitions = 5 } = {}) {
  const aliasBaseline = scoreAliasQueries(baselineAliasAnswer);
  const aliasCandidate = scoreAliasQueries(candidateAliasAnswer);
  const linksBaseline = scoreMemoryLinks({ providerId: 'floor', queryAliasFactory: floorFactory });
  const linksCandidate = scoreMemoryLinks({ providerId: 'phase7', queryAliasFactory: phase7Factory });

  // Cold measurement rebuilds every derived artifact; warm reuses the cached
  // per-function solve. Reporting only one of the two hides either the build
  // cost or the query cost.
  const coldActiveFunction = timed(repetitions, () => {
    solverCache.clear();
    for (const query of ALIAS_QUERIES) candidateAliasAnswer(query);
  });
  const warmActiveFunction = timed(repetitions, () => {
    for (const query of ALIAS_QUERIES) candidateAliasAnswer(query);
  });
  const pathologicalPointerPhi = timed(repetitions, () => {
    solverCache.clear();
    const built = buildFixture('cyclic-pointer-phi');
    solverFor(built).pointsToRun();
  });

  return {
    alias: {
      baseline: aliasBaseline,
      candidate: aliasCandidate,
      falseNoAlias: aliasCandidate.falseNoAlias,
      falseMustAlias: aliasCandidate.falseMustAlias,
    },
    memoryLinks: {
      baseline: linksBaseline,
      candidate: linksCandidate,
      barrierBypasses: linksCandidate.barrierBypasses,
    },
    summaries: await summaryMetrics(),
    escape: await escapeMetrics(),
    types: await typeMetrics(),
    debug: await debugMetrics(),
    discovery: await discoveryMetrics(),
    architectureLanes: await architectureLaneMetrics(manifestLanes),
    performance: { coldActiveFunction, warmActiveFunction, pathologicalPointerPhi },
    checkpoints: acceptedCheckpoints(),
  };
}

export { collectPhase7MetricsAsync as collectPhase7Metrics };
