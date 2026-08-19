/**
 * Summary and escape lane metrics.
 *
 * Scored per field rather than as one aggregate, because a single number can
 * hide a missing write effect behind accurate register effects (§17.5). The
 * counters the verifier blocks on are `missingEffects` (an effect that really
 * happens but is absent from the summary — unsound) and `falsePurity` (a
 * summary that reports no effects while its evidence is incomplete).
 */

import { analyzeLocalPointsTo } from '../../../../js/analysis/pointsto/local.js';
import { analyzeEscape } from '../../../../js/analysis/summary/escape.js';
import { buildLocalFunctionSummary } from '../../../../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../../../../js/analysis/summary/interprocedural.js';
import { summaryIsPure } from '../../../../js/analysis/summary/contract.js';
import { SUMMARY_QUERIES, buildSummaryGraph } from '../../../../tests/phase7/corpus/summaries.mjs';
import { ESCAPE_QUERIES, buildFixture } from '../../../../tests/phase7/corpus/fixtures.mjs';

export function collectSummaryMetrics() {
  const perQuery = [];
  let missingEffects = 0;
  let inventedEffects = 0;
  let falsePurity = 0;
  let wrongCompleteness = 0;
  let nonConvergent = 0;

  for (const query of SUMMARY_QUERIES) {
    const locals = buildSummaryGraph(query.graph);
    const solved = solveInterproceduralSummaries({ roots: [query.root], localSummaries: locals });
    const summary = solved.summaries.get(query.functionId);
    if (!summary) { missingEffects += 1; perQuery.push({ id: query.id, error: 'no-summary' }); continue; }

    const writeIds = summary.memoryWriteRegions.map((effect) => effect.regionId).filter(Boolean);
    const broad = summary.memoryWriteRegions.some((effect) => effect.broad);

    for (const required of query.mustIncludeWrites) {
      if (!writeIds.includes(required) && !broad) missingEffects += 1;
    }
    for (const forbidden of query.mustExcludeWrites) {
      if (writeIds.includes(forbidden)) inventedEffects += 1;
    }
    if (query.mustBeBroad && !broad) missingEffects += 1;
    if (summary.status.completeness !== query.completeness) wrongCompleteness += 1;
    if (query.completeness !== 'complete' && summaryIsPure(summary)) falsePurity += 1;
    if (query.converges && solved.status.stopReason === 'iteration-limit') nonConvergent += 1;

    perQuery.push({
      id: query.id,
      writes: writeIds,
      broad,
      unknownCalls: summary.unknownCallEffects.map((effect) => effect.reason),
      completeness: summary.status.completeness,
      expectedCompleteness: query.completeness,
      iterations: solved.iterations,
    });
  }

  // Determinism: the same graph solved twice must produce the same result. A
  // fixed point that depends on traversal luck is not a fixed point.
  let nondeterministic = 0;
  for (const query of SUMMARY_QUERIES) {
    const first = solveInterproceduralSummaries({ roots: [query.root], localSummaries: buildSummaryGraph(query.graph) });
    const second = solveInterproceduralSummaries({ roots: [query.root], localSummaries: buildSummaryGraph(query.graph) });
    if (first.iterations !== second.iterations) nondeterministic += 1;
  }

  return {
    available: true,
    total: SUMMARY_QUERIES.length,
    missingEffects,
    inventedEffects,
    falsePurity,
    wrongCompleteness,
    nonConvergent,
    nondeterministic,
    perQuery,
  };
}

export function collectEscapeMetrics() {
  const perQuery = [];
  let missedEscapes = 0;
  let falseNonEscape = 0;

  for (const query of ESCAPE_QUERIES) {
    const built = buildFixture(query.fixture);
    const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
      canonicalOptions: built.rootDescriptors == null ? {} : { rootDescriptors: built.rootDescriptors },
    });
    const escape = analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {});
    const reasons = escape.escapes.map((record) => record.reason);
    const boundaries = escape.escapes.map((record) => record.boundary);

    for (const required of query.expectedReasons ?? []) {
      if (!reasons.includes(required)) missedEscapes += 1;
    }
    // A root reported non-escaping when the corpus says it escaped is the
    // unsound direction: separation proofs would be built on it.
    if (query.expectNonEscapingRoots === 0 && escape.nonEscapingRoots.size > 0) falseNonEscape += 1;

    perQuery.push({
      id: query.id,
      reasons,
      boundaries,
      nonEscapingRoots: escape.nonEscapingRoots.size,
      expectedNonEscapingRoots: query.expectNonEscapingRoots,
      completeness: escape.status.completeness,
    });
  }

  // Local summaries must never report an unresolved call as pure.
  let localFalsePurity = 0;
  for (const fixtureId of ['unknown-call-barrier', 'stack-disjoint', 'pure-call-no-barrier']) {
    const built = buildFixture(fixtureId);
    const { summary } = buildLocalFunctionSummary(built.ir, built.cfg, built.ssa, built.memorySsa, {
      resolveRegion: built.resolveRegion,
    });
    if (fixtureId === 'unknown-call-barrier' && summaryIsPure(summary)) localFalsePurity += 1;
  }

  return {
    available: true,
    total: ESCAPE_QUERIES.length,
    missedEscapes,
    falseNonEscape,
    localFalsePurity,
    perQuery,
  };
}
