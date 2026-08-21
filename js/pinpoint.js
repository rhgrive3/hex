/*
 * Audited facade over the preserved implementation.
 *
 * The legacy engine already narrows exact/literal-name queries before
 * verification.  Its verification loop accidentally reset the Bayesian prior
 * to the full field universe.  Re-fuse the final evidence using the same
 * narrowed candidate set so additional verified evidence cannot reduce
 * confidence merely because a round ran.  See issue #274.
 *
 * Automatic analysis also arrives here with the already-built value-shape
 * index. Re-running fieldAccess over the whole executable region for every
 * goal defeats that one-pass index and can turn the pinpoint phase into
 * N * binary-size work. When shapes are present, use those already-observed
 * mutation sites and skip the redundant whole-region access scan. A direct
 * caller that explicitly needs the exhaustive access scan can opt back in with
 * forceAccessScan.
 */
import {
  pinpointField as legacyPinpointField,
  pinpointFunction as legacyPinpointFunction,
  pinpointLocation as legacyPinpointLocation,
  groupSites,
} from './pinpoint-legacy.js';
import { fuse, decide, explain, starsOf } from './evidence.js';

export * from './pinpoint-legacy.js';

const DEFAULT_PINPOINT_ANALYSIS_TIMEOUT_MS = 30_000;
const MAX_PINPOINT_ANALYSIS_TIMEOUT_MS = 120_000;
const ANALYZE_GUARDS = new WeakMap();

function narrowedPriorCount(candidates, universe) {
  if (!candidates.length) return Math.max(1, universe || 1);
  const exact = candidates.filter((c) => c && c.askedByName);
  if (exact.length && exact.length === candidates.length) return exact.length;
  const literal = candidates.filter((c) => c && (c.askedBySequence || c.askedByWords));
  if (literal.length && literal.length === candidates.length) return literal.length;
  return Math.max(1, universe || candidates.length);
}

function timeoutMs(opts) {
  const requested = Number(opts?.analysisTimeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PINPOINT_ANALYSIS_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_PINPOINT_ANALYSIS_TIMEOUT_MS, Math.floor(requested)));
}

function timeoutError(ms) {
  const error = new Error(`pinpoint analysis timed out after ${ms}ms`);
  error.code = 'pinpoint-analysis-timeout';
  return error;
}

/*
 * One stuck function analysis must not hold the whole automatic analysis open.
 * A short circuit breaker is shared by all pinpoint calls using the same
 * analyzer, so one orphaned backend request cannot spawn dozens more while the
 * remaining goals are being examined.
 */
function guardedAnalyze(analyze, opts) {
  if (typeof analyze !== 'function') return analyze;
  let state = ANALYZE_GUARDS.get(analyze);
  if (!state) {
    state = { blockedUntil: 0 };
    ANALYZE_GUARDS.set(analyze, state);
  }
  const ms = timeoutMs(opts);
  return async (...args) => {
    if (Date.now() < state.blockedUntil) throw timeoutError(ms);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(ms)), ms);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => analyze(...args)), timeout]);
    } catch (error) {
      if (error?.code === 'pinpoint-analysis-timeout') {
        // Fail fast for the rest of the current burst instead of accumulating
        // orphaned analyses. A later user action can retry after the breaker.
        state.blockedUntil = Date.now() + Math.min(5000, ms);
      }
      throw error;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  };
}

function preparedOptions(opts) {
  const shapeBacked = opts?.shapes != null && opts?.forceAccessScan !== true;
  return {
    ...(opts || {}),
    analyze: guardedAnalyze(opts?.analyze, opts),
    ...(shapeBacked ? { scanAccess: null } : {}),
  };
}

function shapeMutationSites(shapes, offset) {
  if (!shapes || typeof shapes.values !== 'function' || offset == null) return [];
  const wanted = Number(offset);
  if (!Number.isFinite(wanted)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of shapes.values()) {
    if (!entry || Number(entry.offset) !== wanted) continue;
    for (const site of entry.sites || []) {
      if (site?.addr == null) continue;
      const key = site.addr.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      // Shape events are observed mutations, so expose them as writes to the
      // existing grouping code. This retains function/owner prioritization.
      out.push({ addr: site.addr, kind: 'store' });
    }
  }
  return out;
}

function hydrateShapeChangeSites(pin, opts) {
  if (!pin?.top || opts?.shapes == null) return pin;
  const sites = shapeMutationSites(opts.shapes, pin.top.offset);
  if (!sites.length) return pin;
  const className = pin.kind === 'field' ? pin.top.className : null;
  const grouped = groupSites(sites, opts.program || null, opts.fields || null, className);
  pin.top.sites = grouped;
  pin.top.siteCount = sites.length;
  pin.changeSites = grouped;
  return pin;
}

export async function pinpointField(opts = {}) {
  const requestedLimit = opts.limit || 12;
  /* The preserved implementation internally keeps at most 400 candidates.
     Ask it to return that whole ranked set so the prior is not inferred from a
     UI-truncated top-12 list. */
  const raw = await legacyPinpointField({ ...preparedOptions(opts), limit: 400 });
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

  const result = {
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
  return hydrateShapeChangeSites(result, opts);
}

export async function pinpointLocation(opts = {}) {
  const result = await legacyPinpointLocation(preparedOptions(opts));
  return hydrateShapeChangeSites(result, opts);
}

export async function pinpointFunction(opts = {}) {
  return legacyPinpointFunction(preparedOptions(opts));
}
