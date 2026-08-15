/*
 * Audited facade over the preserved implementation.
 *
 * The legacy engine already narrows exact/literal-name queries before
 * verification.  Its verification loop accidentally reset the Bayesian prior
 * to the full field universe.  Re-fuse the final evidence using the same
 * narrowed candidate set so additional verified evidence cannot reduce
 * confidence merely because a round ran.  See issue #274.
 */
import { pinpointField as legacyPinpointField } from './pinpoint-legacy.js';
import { fuse, decide, explain, starsOf } from './evidence.js';

export * from './pinpoint-legacy.js';

function narrowedPriorCount(candidates, universe) {
  if (!candidates.length) return Math.max(1, universe || 1);
  const exact = candidates.filter((c) => c && c.askedByName);
  if (exact.length && exact.length === candidates.length) return exact.length;
  const literal = candidates.filter((c) => c && (c.askedBySequence || c.askedByWords));
  if (literal.length && literal.length === candidates.length) return literal.length;
  return Math.max(1, universe || candidates.length);
}

export async function pinpointField(opts = {}) {
  const requestedLimit = opts.limit || 12;
  /* The preserved implementation internally keeps at most 400 candidates.
     Ask it to return that whole ranked set so the prior is not inferred from a
     UI-truncated top-12 list. */
  const raw = await legacyPinpointField({ ...opts, limit: 400 });
  if (!raw || !Array.isArray(raw.candidates) || !raw.candidates.length) return raw;

  const ranked = raw.candidates.slice();
  const priorCandidates = narrowedPriorCount(ranked, raw.universe);
  for (const c of ranked) c.fusion = fuse(c.evidence || [], { candidates: priorCandidates });
  ranked.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);
  const decision = decide(ranked);
  const oldTopKey = raw.top && raw.top.key;
  const newTopKey = decision.top && decision.top.key;

  for (const c of ranked) {
    c.probability = c.fusion.probability;
    c.stars = starsOf(c.fusion.probability, c === decision.top ? decision.verdict : null);
    c.why = explain(c.fusion);
  }

  return {
    ...raw,
    verdict: decision.verdict,
    top: decision.top || null,
    runnerUp: decision.runnerUp || null,
    margin: decision.margin,
    marginRatio: decision.marginRatio,
    missing: decision.missing,
    candidates: ranked.slice(0, requestedLimit),
    priorCandidates,
    priorStableAcrossVerification: true,
    changeSites: oldTopKey === newTopKey ? raw.changeSites : ((decision.top && decision.top.sites) || []),
  };
}
