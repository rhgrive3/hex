/*
 * Audited facade over the preserved implementation.
 *
 * The legacy engine already narrows exact/literal-name queries before
 * verification. Its verification loop accidentally reset the Bayesian prior
 * to the full field universe. Re-fuse the final evidence using the same
 * narrowed candidate set so additional verified evidence cannot reduce
 * confidence merely because a round ran. See issue #274.
 *
 * Automatic analysis also arrives here with a whole-program value-shape index.
 * The legacy pinpoint stages used to call fieldAccess repeatedly per goal even
 * though that worker API can inspect many offsets in one pass. The facade now
 * turns those calls into one superset scan, caches the complete groups, and
 * serves each legacy request from that cache. Requested size filtering is
 * applied after the scan, so batching does not relax the caller's contract.
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
const DEFAULT_ACCESS_SCAN_TIMEOUT_MS = 45_000;
const MAX_ACCESS_SCAN_TIMEOUT_MS = 120_000;
const DEFAULT_AUTO_UNIQUE_ANALYSES = 48;
const MAX_AUTO_UNIQUE_ANALYSES = 256;
const ANALYZE_GUARDS = new WeakMap();
const ACCESS_BATCHES = new WeakMap();

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

function accessTimeoutMs(opts) {
  const requested = Number(opts?.accessScanTimeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_ACCESS_SCAN_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_ACCESS_SCAN_TIMEOUT_MS, Math.floor(requested)));
}

function uniqueAnalysisLimit(opts) {
  // `shapes` is the automatic-analysis marker: prepare() builds that one-pass
  // index before autoAnalyze. Direct pinpoint callers without shapes retain the
  // historical unlimited unique-function envelope.
  if (opts?.shapes == null) return Infinity;
  const requested = Number(opts?.maxPinpointAnalyses);
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_AUTO_UNIQUE_ANALYSES;
  return Math.max(1, Math.min(MAX_AUTO_UNIQUE_ANALYSES, Math.floor(requested)));
}

function timeoutError(ms) {
  const error = new Error(`pinpoint analysis timed out after ${ms}ms`);
  error.code = 'pinpoint-analysis-timeout';
  return error;
}

function accessTimeoutError(ms) {
  const error = new Error(`pinpoint access scan timed out after ${ms}ms`);
  error.code = 'pinpoint-access-timeout';
  return error;
}

function analysisBudgetError(limit) {
  const error = new Error(`pinpoint unique-analysis budget exhausted at ${limit} functions`);
  error.code = 'pinpoint-analysis-budget';
  return error;
}

function analysisKey(args) {
  return args.slice(0, 2).map((value) => value == null ? 'null' : value.toString()).join(':');
}

function analyzeArgsWithSignal(args, signal) {
  const out = args.slice();
  const third = out[2];
  if (third && typeof third === 'object' && !Array.isArray(third)) out[2] = { ...third, signal };
  else out[2] = { signal };
  return out;
}

function linkParentSignal(controller, parentSignal) {
  if (!parentSignal) return () => {};
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason || 'cancelled');
  };
  parentSignal.addEventListener('abort', abort, { once: true });
  if (parentSignal.aborted) abort();
  return () => parentSignal.removeEventListener('abort', abort);
}

/*
 * One stuck function analysis must not hold the whole automatic analysis open.
 * A short circuit breaker is shared by all pinpoint calls using the same
 * analyzer, so one orphaned backend request cannot spawn dozens more while the
 * remaining goals are being examined. Automatic analysis also has a shared
 * unique-function ceiling; repeated reads of the same function remain free.
 *
 * The timeout is not merely a UI race: it aborts the analysis signal and calls
 * a cancellable operation's cancel hook when available, so backend work cannot
 * survive as a detached orphan after the pinpoint phase has moved on.
 */
function guardedAnalyze(analyze, opts) {
  if (typeof analyze !== 'function') return analyze;
  let state = ANALYZE_GUARDS.get(analyze);
  if (!state) {
    state = { blockedUntil: 0, uniqueKeys: new Set() };
    ANALYZE_GUARDS.set(analyze, state);
  }
  const ms = timeoutMs(opts);
  const uniqueLimit = uniqueAnalysisLimit(opts);
  return async (...args) => {
    if (Date.now() < state.blockedUntil) throw timeoutError(ms);
    const key = analysisKey(args);
    if (!state.uniqueKeys.has(key)) {
      if (state.uniqueKeys.size >= uniqueLimit) throw analysisBudgetError(uniqueLimit);
      state.uniqueKeys.add(key);
    }
    const controller = new AbortController();
    const unlinkParent = linkParentSignal(controller, opts?.signal || null);
    let timer = null;
    let operation = null;
    const cancelOperation = () => {
      try { operation?.cancel?.(); } catch { /* abort remains authoritative */ }
    };
    controller.signal.addEventListener('abort', cancelOperation, { once: true });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort('pinpoint-analysis-timeout');
        else cancelOperation();
        reject(timeoutError(ms));
      }, ms);
    });
    try {
      operation = analyze(...analyzeArgsWithSignal(args, controller.signal));
      if (controller.signal.aborted) cancelOperation();
      return await Promise.race([Promise.resolve(operation), timeout]);
    } catch (error) {
      if (error?.code === 'pinpoint-analysis-timeout') {
        state.blockedUntil = Date.now() + Math.min(5000, ms);
      }
      throw error;
    } finally {
      if (timer != null) clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancelOperation);
      unlinkParent();
    }
  };
}

function addOffset(set, value) {
  if (value == null) return;
  try { set.add(BigInt(value).toString()); } catch { /* invalid metadata is ignored */ }
}

function automaticOffsets(opts, requested) {
  const keys = new Set();
  for (const item of requested || []) addOffset(keys, item?.offset);
  for (const entry of opts?.shapes?.values?.() || []) addOffset(keys, entry?.offset);
  for (const cls of opts?.fields?.classes?.values?.() || []) {
    for (const ivar of cls?.ivars || []) addOffset(keys, ivar?.offset);
  }
  // The worker indexes requested offsets by displacement. Scanning with size=0
  // captures a lossless superset once; each legacy request is size-filtered
  // when read back from the cache below.
  return Array.from(keys, (key) => ({ offset: BigInt(key), size: 0 }));
}

function emptyGroups() { return new Map(); }
function groupAt(groups, key) {
  if (!groups) return [];
  return (groups.get ? groups.get(key) : groups[key]) || [];
}
function sizeMatches(site, size) {
  const wanted = Number(size) || 0;
  if (wanted <= 0) return true;
  return site?.size === wanted || (wanted > 8 && site?.size === 8);
}

/*
 * fieldAccessMany is specifically designed to inspect many displacements in a
 * single executable-region pass. Build that superset on the first pinpoint
 * request and reuse it for every later goal. A failed/timed-out scan is cached
 * as empty for this analysis burst so an unhealthy worker is not hammered by
 * N identical full-region retries. Timeout also cancels the underlying worker
 * request when the adapter exposes a cancel hook.
 */
function batchedScanAccess(scanAccess, opts) {
  if (typeof scanAccess !== 'function') return scanAccess;
  let state = ACCESS_BATCHES.get(scanAccess);
  if (!state) {
    state = { promise: null, groups: null };
    ACCESS_BATCHES.set(scanAccess, state);
  }
  return async (requested = []) => {
    if (!state.groups && !state.promise) {
      const all = automaticOffsets(opts, requested);
      const ms = accessTimeoutMs(opts);
      const controller = new AbortController();
      const unlinkParent = linkParentSignal(controller, opts?.signal || null);
      let timer = null;
      let operation = null;
      const cancelOperation = () => {
        try { operation?.cancel?.(); } catch { /* abort remains authoritative */ }
      };
      controller.signal.addEventListener('abort', cancelOperation, { once: true });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (!controller.signal.aborted) controller.abort('pinpoint-access-timeout');
          else cancelOperation();
          reject(accessTimeoutError(ms));
        }, ms);
      });
      try {
        operation = scanAccess(all, { signal: controller.signal });
        if (controller.signal.aborted) cancelOperation();
      } catch (error) {
        unlinkParent();
        throw error;
      }
      state.promise = Promise.race([Promise.resolve(operation), timeout])
        .then((groups) => {
          state.groups = groups || emptyGroups();
          return state.groups;
        }, (error) => {
          state.groups = emptyGroups();
          throw error;
        })
        .finally(() => {
          if (timer != null) clearTimeout(timer);
          controller.signal.removeEventListener('abort', cancelOperation);
          unlinkParent();
          state.promise = null;
        });
    }
    let groups;
    try { groups = state.groups || await state.promise; }
    catch { groups = state.groups || emptyGroups(); }
    const out = new Map();
    for (const item of requested || []) {
      if (item?.offset == null) continue;
      const key = BigInt(item.offset).toString();
      out.set(key, groupAt(groups, key).filter((site) => sizeMatches(site, item.size)));
    }
    return out;
  };
}

function preparedOptions(opts) {
  const automaticBatch = opts?.shapes != null && opts?.forceAccessScan !== true;
  return {
    ...(opts || {}),
    analyze: guardedAnalyze(opts?.analyze, opts),
    scanAccess: automaticBatch ? batchedScanAccess(opts?.scanAccess, opts) : opts?.scanAccess,
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
      out.push({ addr: site.addr, kind: 'store' });
    }
  }
  return out;
}

/* Shape sites are only a fallback when the exhaustive batched access scan did
 * not produce a change site. Never replace stronger full-scan evidence. */
function hydrateShapeChangeSites(pin, opts) {
  if (!pin?.top || opts?.shapes == null || pin.changeSites?.length) return pin;
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
