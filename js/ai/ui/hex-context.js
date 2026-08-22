/* Final QueryAPI correctness layer for the first-party AI context.
 * The reviewed implementation lives in hex-context-query-base.js. This facade
 * preserves its surface while fixing completeness/cancellation propagation that
 * cannot be represented by its historical helpers.
 */
import {
  analyzeModelAt as analyzeBaseModelAt,
  createHexAIContext as createBaseHexAIContext,
} from './hex-context-query-base.js';

const QUERY_AUTHORITY = 'AnalysisQueryAPI';
const MAX_QUERY_PAGE = 5_000;

function toBigInt(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  try { return BigInt(typeof value === 'string' && /^0x/i.test(value) ? value : String(value)); }
  catch { return null; }
}
function completenessOf(result) { return result?.completeness ?? result?.status?.completeness ?? 'partial'; }
function reasonOf(result) { return result?.status?.reason ?? result?.reason ?? null; }
function isStale(error) { return error?.name === 'AnalysisSnapshotStaleError' || error?.code === 'ANALYSIS_SNAPSHOT_STALE'; }
function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason != null) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}
function hasExplicitFalsyAbortReason(signal) {
  return signal?.aborted === true && signal.reason != null && !signal.reason;
}
function rethrowWithExactAbortReason(signal, error) {
  if (hasExplicitFalsyAbortReason(signal)) throw signal.reason;
  throw error;
}
function bounded(value, fallback, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(max, number) : fallback;
}
async function withFreshSnapshot(app, operation, options = {}) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    abortIfNeeded(options.signal);
    const snapshot = await app.analysisQueries.snapshot({ signal:options.signal ?? null });
    try {
      const value = await operation(app.analysisQueries, snapshot);
      abortIfNeeded(options.signal);
      return value;
    } catch (error) {
      last = error;
      if (!isStale(error) || attempt > 0) throw error;
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}
function define(context, name, value) {
  Object.defineProperty(context, name, { value, enumerable:true, configurable:true, writable:false });
}

export async function analyzeModelAt(app, address, end = null, options = {}) {
  try {
    return await analyzeBaseModelAt(app, address, end, options);
  } catch (error) {
    rethrowWithExactAbortReason(options.signal, error);
  }
}

export function createHexAIContext(app) {
  const context = createBaseHexAIContext(app);
  if (context?.analysisAuthority !== QUERY_AUTHORITY || !app?.analysisQueries) return context;

  // The reviewed base predates the repository-wide exact AbortSignal.reason
  // invariant. Restore explicit falsy reasons at every inherited async Query
  // capability without changing the base compatibility implementation.
  const wrapAbortReason = (name, optionsIndex) => {
    const base = context[name];
    if (typeof base !== 'function') return;
    define(context, name, async (...args) => {
      const options = args[optionsIndex] || {};
      try {
        return await base(...args);
      } catch (error) {
        rethrowWithExactAbortReason(options?.signal, error);
      }
    });
  };
  wrapAbortReason('analyze', 2);
  wrapAbortReason('searchFunctions', 1);
  wrapAbortReason('getInstructions', 1);
  wrapAbortReason('getCFG', 1);
  wrapAbortReason('getXrefs', 1);
  wrapAbortReason('getCallers', 1);
  wrapAbortReason('getCallees', 1);

  define(context, 'searchStrings', async (query, options = {}) => {
    const offset = bounded(options.offset, 0, 1_000_000);
    const limit = Math.max(1, bounded(options.limit, 50, 200));
    const need = Math.min(MAX_QUERY_PAGE, offset + limit + 1);
    return withFreshSnapshot(app, async (api, snapshot) => {
      const info = await api.binaryInfo(snapshot, { signal:options.signal ?? null });
      if (completenessOf(info) === 'unsupported' || !info?.value) {
        return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason:reasonOf(info) || 'binary-info-unavailable' };
      }
      const all = [];
      let anySupported = false;
      let complete = completenessOf(info) === 'complete';
      let reason = complete ? null : (reasonOf(info) || 'binary-info-incomplete');
      for (const region of info.value.regions || []) {
        abortIfNeeded(options.signal);
        if (all.length >= need) { complete = false; reason ||= 'result-limit'; break; }
        const remaining = Math.max(1, need - all.length);
        const result = await api.search(snapshot, {
          regionId:region.id,
          kind:'text',
          query:String(query ?? ''),
          from:0,
        }, { offset:0, limit:remaining }, { signal:options.signal ?? null });
        if (completenessOf(result) === 'unsupported') {
          reason ||= reasonOf(result) || 'typed-search-producer-unavailable';
          continue;
        }
        anySupported = true;
        if (completenessOf(result) !== 'complete' || result?.page?.next != null) {
          complete = false;
          reason ||= reasonOf(result) || 'search-incomplete';
        }
        for (const row of result?.value || []) {
          const address = toBigInt(row?.addr ?? row?.address);
          all.push({ ...row, addr:undefined, address:undefined, stringAddress:address, regionId:region.id });
          if (all.length >= need) break;
        }
      }
      if (!anySupported) complete = false;
      const rows = all.slice(offset, offset + limit);
      const exhausted = offset + rows.length >= all.length;
      const pageComplete = anySupported && complete && exhausted;
      return {
        results:rows,
        offset,
        returned:rows.length,
        total:pageComplete ? all.length : null,
        complete:pageComplete,
        truncated:!pageComplete,
        reason:pageComplete ? null : (reason || 'typed-search-producer-unavailable'),
      };
    }, options);
  });

  const getDecompile = async (address, options = {}) => withFreshSnapshot(app, async (api, snapshot) => {
    const result = await api.decompile(snapshot, address, { signal:options.signal ?? null });
    const completeness = completenessOf(result);
    if (completeness === 'unsupported' || result?.value == null) {
      return { text:null, complete:false, truncated:true, unsupported:true, reason:reasonOf(result) || 'decompiler-projection-unavailable' };
    }
    const text = typeof result.value === 'string'
      ? result.value
      : (result.value.pseudocode ?? result.value.text ?? result.value.code ?? null);
    return {
      value:result.value,
      text:typeof text === 'string' ? text : null,
      complete:completeness === 'complete',
      truncated:completeness !== 'complete',
      reason:reasonOf(result),
      analysisAuthority:QUERY_AUTHORITY,
    };
  }, options);
  define(context, 'getDecompile', getDecompile);
  define(context, 'decompile', async (address, options = {}) => (await getDecompile(address, options)).text);

  define(context, 'findPaths', async (from, to, options = {}) => withFreshSnapshot(app, async (api, snapshot) => {
    const result = await api.causalPath(snapshot, { functionId:from }, { functionId:to }, { ...options, signal:options.signal ?? null });
    const completeness = completenessOf(result);
    if (completeness === 'unsupported' || result?.value == null) {
      return { paths:[], returned:0, total:null, complete:false, truncated:true, unsupported:true, reason:reasonOf(result) || 'causal-path-unavailable', analysisAuthority:QUERY_AUTHORITY };
    }
    return {
      ...result.value,
      complete:completeness === 'complete',
      truncated:completeness !== 'complete',
      reason:reasonOf(result) ?? result.value?.reason ?? null,
      analysisAuthority:QUERY_AUTHORITY,
    };
  }, options));

  return context;
}

export default createHexAIContext;
