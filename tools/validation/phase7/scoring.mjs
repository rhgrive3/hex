/**
 * Phase 7 scoring — versioned, and versioned on purpose.
 *
 * Section 17 of the runbook makes measurement part of correctness: a candidate
 * must not be able to look better by changing what is counted. So the scoring
 * identity is frozen here and recorded in every evidence record. Changing any
 * rule below is an acceptance-semantics change and invalidates prior evidence
 * (§13.4) — the baseline has to be re-run under the new version.
 */

import { ALIAS_QUERIES, ALIAS_QUERIES_V2, MEMORY_LINK_QUERIES, buildFixture, memoryAccessOf, regionOf } from '../../../tests/phase7/corpus/fixtures.mjs';
import { reachingMemoryDefinition } from '../../../js/semantics/memoryssa/queries.js';

export const SCORING_ID = 'phase7.scoring';
export const SCORING_VERSION = '1.0.0';
export const TRUTH_GENERATOR_ID = 'phase7.corpus.declared-truth';
export const TRUTH_GENERATOR_VERSION = '1.0.0';

/**
 * Scores one alias answerer against the frozen query set.
 *
 * `answer(query)` returns a relation string. The two counters that matter are
 * `falseNoAlias` and `falseMustAlias`: both must be zero, and no amount of
 * precision elsewhere compensates for either (§24.1).
 */
export function scoreAliasQueries(answer, { queries = ALIAS_QUERIES } = {}) {
  const perQuery = [];
  const counts = { must: 0, may: 0, no: 0, unknown: 0 };
  let falseNoAlias = 0;
  let falseMustAlias = 0;
  let exactProven = 0;
  let exactAvailable = 0;

  for (const query of queries) {
    const relation = answer(query);
    counts[relation] = (counts[relation] ?? 0) + 1;
    const truthIsExact = query.truth === 'no' || query.truth === 'must';
    if (truthIsExact) exactAvailable += 1;

    // A strong answer is false when the truth is a different strong answer, or
    // when the truth says no strong answer exists at all.
    if (relation === 'no' && query.truth !== 'no') falseNoAlias += 1;
    if (relation === 'must' && query.truth !== 'must') falseMustAlias += 1;
    if (truthIsExact && relation === query.truth) exactProven += 1;

    perQuery.push({ id: query.id, relation, truth: query.truth, expectStrong: query.expectStrong === true });
  }

  const total = queries.length;
  return {
    scoringId: SCORING_ID,
    scoringVersion: SCORING_VERSION,
    truthGeneratorId: TRUTH_GENERATOR_ID,
    truthGeneratorVersion: TRUTH_GENERATOR_VERSION,
    total,
    counts,
    falseNoAlias,
    falseMustAlias,
    exactProven,
    exactAvailable,
    // `may` and `unknown` are reported separately. Combining them into one
    // "not resolved" number would let a candidate trade a tracked answer for an
    // untracked one and call it progress (§17.3).
    unknownRate: total === 0 ? 0 : counts.unknown / total,
    mayRate: total === 0 ? 0 : counts.may / total,
    strongProvenRate: total === 0 ? 0 : (counts.must + counts.no) / total,
    perQuery,
  };
}

/**
 * Scores reaching-definition answers.
 *
 * `blocked` truth means a barrier must stand between the store and the load.
 * Forwarding through it is a soundness failure even when the forwarded value
 * happens to be right (§17.4).
 */
export function scoreMemoryLinks({ queries = MEMORY_LINK_QUERIES, buildWith, providerId = 'none', queryAliasFactory = null } = {}) {
  const perQuery = [];
  let barrierBypasses = 0;
  let exactLinks = 0;
  let blockedCorrect = 0;
  let missedExact = 0;

  for (const query of queries) {
    const built = buildWith ? buildWith(query.fixture) : buildFixture(query.fixture, { providerId, queryAliasFactory });
    const loadNode = built.ir.nodes.find((node) => node.id === query.load);
    const uses = built.memorySsa.uses.filter((use) => use.sourceEntityId === loadNode.id);
    const definitions = uses.map((use) => reachingMemoryDefinition(built.memorySsa, use));
    const kinds = [...new Set(definitions.map((definition) => definition?.kind ?? 'missing'))].sort();
    const exact = definitions.length > 0 && definitions.every((definition) => definition?.kind === 'memory-def');
    const sources = [...new Set(definitions.map((definition) => definition?.sourceEntityId ?? null))];

    if (query.truth === 'blocked') {
      if (exact) barrierBypasses += 1;
      else blockedCorrect += 1;
    } else if (query.truth === 'exact') {
      if (exact && sources.length === 1 && sources[0] === query.expectedStore) exactLinks += 1;
      else missedExact += 1;
    }
    perQuery.push({ id: query.id, truth: query.truth, kinds, exact, sources });
  }

  return {
    scoringId: SCORING_ID,
    scoringVersion: SCORING_VERSION,
    providerId,
    total: queries.length,
    barrierBypasses,
    exactLinks,
    blockedCorrect,
    missedExact,
    perQuery,
  };
}

export function scoreAliasQueriesV2(answer, { queries = ALIAS_QUERIES_V2 } = {}) {
  const perQuery = [];
  const unknownReasonCounts = {};
  let mustAvailable = 0;
  let mustCorrect = 0;
  let noAliasAvailable = 0;
  let noAliasCorrect = 0;
  let mayAvailable = 0;
  let mayCorrect = 0;
  let exactAvailable = 0;
  let exactClaimed = 0;
  let exactCorrect = 0;
  let falseMustAlias = 0;
  let falseNoAlias = 0;
  let unknownCount = 0;

  for (const query of queries) {
    const rawRelation = answer(query);
    const relation = typeof rawRelation === 'string' ? rawRelation : rawRelation?.relation ?? 'unknown';
    const reason = typeof rawRelation === 'object' && rawRelation?.reason ? rawRelation.reason : 'unknown-unspecified';

    const truthIsMust = query.truth === 'must';
    const truthIsNo = query.truth === 'no';
    const truthIsMay = query.truth === 'may' || query.truth === 'may-or-weaker';

    if (truthIsMust) {
      mustAvailable += 1;
      exactAvailable += 1;
    } else if (truthIsNo) {
      noAliasAvailable += 1;
      exactAvailable += 1;
    } else {
      mayAvailable += 1;
    }

    if (relation === 'must') {
      exactClaimed += 1;
      if (truthIsMust) {
        mustCorrect += 1;
        exactCorrect += 1;
      } else {
        falseMustAlias += 1;
      }
    } else if (relation === 'no') {
      exactClaimed += 1;
      if (truthIsNo) {
        noAliasCorrect += 1;
        exactCorrect += 1;
      } else {
        falseNoAlias += 1;
      }
    } else if (relation === 'may') {
      if (truthIsMay) {
        mayCorrect += 1;
      }
    } else {
      unknownCount += 1;
      unknownReasonCounts[reason] = (unknownReasonCounts[reason] || 0) + 1;
    }

    perQuery.push({
      id: query.id,
      relation,
      truth: query.truth,
      truthSource: query.truthSource || null,
      proofClass: query.proofClass || null,
      category: query.category || null,
    });
  }

  const queryCount = queries.length;
  const exactPrecision = exactClaimed === 0 ? null : exactCorrect / exactClaimed;
  const exactRecall = exactAvailable === 0 ? null : exactCorrect / exactAvailable;

  return {
    scoringId: 'phase7.scoring.v2',
    scoringVersion: '2.0.0',
    truthGeneratorId: 'phase7.corpus.declared-truth.v2',
    truthGeneratorVersion: '2.0.0',
    queryCount,
    exactAvailable,
    exactClaimed,
    exactCorrect,
    exactPrecision,
    exactRecall,
    mustAvailable,
    mustCorrect,
    noAliasAvailable,
    noAliasCorrect,
    mayAvailable,
    mayCorrect,
    unknownCount,
    falseMustAlias,
    falseNoAlias,
    unknownReasonCounts: Object.freeze({ ...unknownReasonCounts }),
    perQuery: Object.freeze(perQuery),
  };
}

export { ALIAS_QUERIES, ALIAS_QUERIES_V2, MEMORY_LINK_QUERIES, buildFixture, memoryAccessOf, regionOf };

