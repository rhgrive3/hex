/**
 * Function-discovery lane metrics.
 *
 * Start and extent are scored independently (§17.2), and false split and false
 * merge are counted from candidate-to-truth association rather than inferred
 * from one extent number — a single score would let a good start rate hide bad
 * region ownership, which is FM-8 exactly.
 *
 * `falseStarts` is the counter the verifier blocks on: a start reported as
 * exact that the corpus says is not a function start, or a start reported as
 * exact where only heuristic evidence exists.
 */

import {
  DiscoveryProducerRegistry,
  fuseFunctionCandidates,
} from '../../../../js/analysis/discovery/fusion.js';
import {
  GENERIC_PRODUCERS,
  createPatternProducer,
} from '../../../../js/analysis/discovery/producers.js';
import { DISCOVERY_TRUTH, buildDiscoveryCase } from '../../../../tests/phase7/corpus/discovery.mjs';

const STATE_RANK = { heuristic: 0, probable: 1, exact: 2, contradicted: 0 };

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * Runs one corpus case through the fusion.
 *
 * `architectureId` is threaded through so the same case can be replayed on
 * every mandatory lane. The fusion must produce the same conclusions regardless,
 * which is the point of the metamorphic laws.
 */
export function runDiscoveryCase(truth, { architectureId = 'generic' } = {}) {
  const input = buildDiscoveryCase(truth.case);
  const registry = new DiscoveryProducerRegistry();
  for (const producer of GENERIC_PRODUCERS) registry.register(producer);
  if (input.patterns) {
    // The pattern producer is registered *for this architecture* with patterns
    // supplied by the case. The fusion never learns what they mean.
    registry.register(createPatternProducer({
      id: `discovery.pattern.${architectureId}`,
      architectureId,
      patterns: input.patterns,
    }));
  }
  const { evidence } = registry.collect(input, architectureId);
  return fuseFunctionCandidates(evidence, { architectureId, snapshotId: 'snapshot_discovery_corpus' });
}

function regionsEqual(left, right) {
  if (left.length !== right.length) return false;
  const norm = (regions) => regions.map((region) => `${hex(region.start)}-${hex(region.end)}`).sort().join(',');
  return norm(left) === norm(right);
}

export function collectDiscoveryMetrics({ architectureId = 'generic' } = {}) {
  let matchedStarts = 0;
  let predictedStarts = 0;
  let truthStarts = 0;
  let falseStarts = 0;
  let missedStarts = 0;
  let exactExtents = 0;
  let extentsAvailable = 0;
  let wrongExtents = 0;
  let falseSplit = 0;
  let falseMerge = 0;
  let overclaimedExtents = 0;
  let missedConflicts = 0;
  const perCase = [];

  for (const truth of DISCOVERY_TRUTH) {
    const { candidates } = runDiscoveryCase(truth, { architectureId });
    const truthStartSet = new Set(truth.starts.map((value) => hex(value)));
    const predicted = candidates.map((candidate) => hex(candidate.start));
    const predictedSet = new Set(predicted);

    truthStarts += truthStartSet.size;
    predictedStarts += predictedSet.size;
    for (const start of predictedSet) {
      if (truthStartSet.has(start)) matchedStarts += 1;
      else {
        const candidate = candidates.find((item) => hex(item.start) === start);
        // A predicted start the corpus does not know about is only a *false*
        // start when it was asserted strongly. A heuristic candidate is a
        // proposal, and proposals are what heuristics are for.
        if (candidate.startState === 'exact') falseStarts += 1;
      }
    }
    for (const start of truthStartSet) if (!predictedSet.has(start)) missedStarts += 1;

    // A start the corpus caps at heuristic must not be reported stronger.
    if (truth.maxStartState) {
      for (const candidate of candidates) {
        if (STATE_RANK[candidate.startState] > STATE_RANK[truth.maxStartState]) falseStarts += 1;
      }
    }

    for (const candidate of candidates) {
      const start = hex(candidate.start);
      const expected = truth.regions[start] ?? null;
      if (expected) {
        extentsAvailable += 1;
        if (candidate.regions.length === 0) continue;
        if (regionsEqual(candidate.regions, expected)) exactExtents += 1;
        else {
          wrongExtents += 1;
          const predictedBytes = candidate.regions.reduce((sum, region) => sum + (BigInt(region.end) - BigInt(region.start)), 0n);
          const truthBytes = expected.reduce((sum, region) => sum + (BigInt(region.end) - BigInt(region.start)), 0n);
          // More predicted bytes than truth means the candidate absorbed
          // something; fewer means it was cut short.
          if (predictedBytes > truthBytes) falseMerge += 1;
          else falseSplit += 1;
        }
      } else if (candidate.regions.length > 0 && truth.extentKnowable === false) {
        // The corpus says no extent is determinable. Claiming one is an
        // invention, tracked separately from getting a knowable extent wrong.
        overclaimedExtents += 1;
      }
    }

    if (truth.requireExtentConflict) {
      const conflicted = candidates.some((candidate) => candidate.conflicts.some((conflict) => conflict.kind === 'extent'));
      if (!conflicted) missedConflicts += 1;
    }

    perCase.push({
      id: truth.id,
      predicted: predicted.map((start) => {
        const candidate = candidates.find((item) => hex(item.start) === start);
        return { start, startState: candidate.startState, extentState: candidate.extentState, regions: candidate.regions.length, conflicts: candidate.conflicts.length };
      }),
      truthStarts: [...truthStartSet],
    });
  }

  return {
    available: true,
    architectureId,
    candidate: {
      falseStarts,
      startPrecision: predictedStarts === 0 ? 0 : matchedStarts / predictedStarts,
      startRecall: truthStarts === 0 ? 0 : matchedStarts / truthStarts,
      missedStarts,
      // Extent metrics are deliberately separate: one good start score cannot
      // hide bad region ownership.
      extentPrecision: extentsAvailable === 0 ? 0 : exactExtents / extentsAvailable,
      exactExtents,
      extentsAvailable,
      wrongExtents,
      overclaimedExtents,
      falseSplit,
      falseMerge,
      missedConflicts,
    },
    perCase,
  };
}
