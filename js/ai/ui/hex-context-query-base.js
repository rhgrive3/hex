/*
 * First-party App -> AI context.
 *
 * Product analysis facts cross AnalysisQueryAPI. The historical direct-index
 * implementation is isolated in hex-context-legacy.js and is used only by
 * headless/compatibility hosts that do not expose the public query layer.
 */
import {
  analyzeModelAt as analyzeLegacyModelAt,
  createHexAIContext as createLegacyHexAIContext,
} from './hex-context-legacy.js';

const QUERY_AUTHORITY = 'AnalysisQueryAPI';
const MAX_QUERY_PAGE = 5_000;

function toBigInt(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  try { return BigInt(typeof value === 'string' && /^0x/i.test(value) ? value : String(value)); }
  catch { return null; }
}

function safeCount(value, fallback, max = MAX_QUERY_PAGE) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(max, n) : fallback;
}

function queryCompleteness(result) {
  return result?.completeness ?? result?.status?.completeness ?? 'partial';
}

function queryReason(result) {
  return result?.status?.reason ?? result?.reason ?? null;
}

function isStale(error) {
  return error?.name === 'AnalysisSnapshotStaleError'
    || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('AbortError');
  error.name = 'AbortError';
  if (!error.code) error.code = 'ABORT_ERR';
  throw error;
}

async function withFreshSnapshot(app, operation, options = {}) {
  const api = app?.analysisQueries;
  if (!api) throw new Error('analysis-query-api-unavailable');
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    abortIfNeeded(options.signal);
    const snapshot = await api.snapshot({
      signal:options.signal ?? null,
      onProgress:options.onProgress,
      onIdentityProgress:options.onIdentityProgress,
    });
    try {
      const value = await operation(api, snapshot);
      abortIfNeeded(options.signal);
      return value;
    } catch (error) {
      last = error;
      if (!isStale(error) || attempt > 0) throw error;
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}

function presentationModel(result) {
  const value = result?.value;
  if (!value) return null;
  if (value.model) return value.model;
  const legacy = value.pipeline?.legacyV1 ?? value.semanticAnalysis?.pipeline?.legacyV1 ?? null;
  if (!legacy) return null;
  const model = { ...legacy };
  model.truncated = model.truncated === true || value.truncated === true || queryCompleteness(result) !== 'complete';
  Object.defineProperties(model, {
    __analysisAuthority:{ value:QUERY_AUTHORITY, enumerable:false },
    __canonicalAnalysisResult:{ value:value, enumerable:false },
  });
  return model;
}

async function queryFunction(app, address, options = {}) {
  const addr = toBigInt(address);
  if (addr == null) return { result:null, model:null };
  const queryOptions = { ...options };
  const maxInstructions = Number(options.maxInstructions);
  if (Number.isFinite(maxInstructions)) {
    if (Math.floor(maxInstructions) <= 0) return { result:null, model:null };
    queryOptions.maxRows = Math.max(1, Math.floor(maxInstructions));
  }
  const result = await withFreshSnapshot(app,
    (api, snapshot) => api.function(snapshot, addr, queryOptions), queryOptions);
  if (queryCompleteness(result) === 'unsupported' || result?.value == null) return { result, model:null };
  return { result, model:presentationModel(result) };
}

/**
 * Semantic compatibility projection for deterministic AI tools.
 * Raw assembly remains a separate QueryAPI.instructions() capability and is
 * never synthesized from Semantic-v2 instruction objects.
 */
export async function analyzeModelAt(app, address, end = null, options = {}) {
  if (!app?.analysisQueries) return analyzeLegacyModelAt(app, address, end, options);
  const { model } = await queryFunction(app, address, options);
  return model;
}

function copyWithMetadata(result, key = 'results') {
  const rows = Array.isArray(result?.value) ? result.value : [];
  const completeness = queryCompleteness(result);
  const page = result?.page || {};
  return {
    [key]:rows,
    offset:Number(page.offset ?? 0),
    returned:Number(page.returned ?? rows.length),
    total:Number.isFinite(Number(page.total)) ? Number(page.total) : null,
    complete:completeness === 'complete' && page.next == null,
    truncated:completeness !== 'complete' || page.next != null,
    reason:queryReason(result),
    completeness:{
      complete:completeness === 'complete' && page.next == null,
      returned:Number(page.returned ?? rows.length),
      total:Number.isFinite(Number(page.total)) ? Number(page.total) : null,
      reason:queryReason(result),
    },
  };
}

function cloneContextDescriptors(source) {
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(source));
}

function define(context, name, descriptor) {
  Object.defineProperty(context, name, {
    configurable:true,
    enumerable:true,
    ...descriptor,
  });
}

function currentAddressOf(context) {
  try { return toBigInt(context.currentAddress); } catch { return null; }
}

/**
 * Build the live first-party AI capability object. Product App instances always
 * expose AnalysisQueryAPI; hosts without it are explicit compatibility oracles.
 */
export function createHexAIContext(app) {
  if (!app?.analysisQueries) return createLegacyHexAIContext(app);

  const legacy = createLegacyHexAIContext(app);
  const context = cloneContextDescriptors(legacy);
  const names = new Map();
  const remember = (row) => {
    const address = toBigInt(row?.address ?? row?.addr ?? row?.startAddress);
    if (address != null && row?.name) names.set(address.toString(), String(row.name));
    return address;
  };
  const nameOf = (address) => {
    const addr = toBigInt(address);
    return addr == null ? null : (names.get(addr.toString()) || null);
  };

  define(context, 'analysisAuthority', { value:QUERY_AUTHORITY, writable:false });
  define(context, 'binaryId', {
    get() { return app?.backend?.binaryId ?? legacy.binaryId ?? null; },
  });

  // Direct analysis indexes are intentionally not part of the production AI
  // context. Query callbacks below are the only first-party analysis authority.
  define(context, 'symbols', { get:() => null });
  define(context, 'program', { get:() => null });
  define(context, 'functions', { get:() => [] });
  define(context, 'strings', { get:() => [] });
  define(context, 'candidateFunctions', {
    get() {
      const address = currentAddressOf(context);
      return address == null ? [] : [address];
    },
  });
  define(context, 'activeFunction', {
    get() {
      const address = currentAddressOf(context);
      return address == null ? null : { address, name:nameOf(address) };
    },
  });
  define(context, 'functionName', { value:(address) => nameOf(address) });

  define(context, 'analyze', {
    value:async (address, _end = null, options = {}) => {
      const { result, model } = await queryFunction(app, address, options);
      remember(result?.value);
      return model;
    },
  });

  define(context, 'searchFunctions', {
    value:async (query, options = {}) => {
      const offset = safeCount(options.offset, 0, 1_000_000);
      const limit = Math.max(1, safeCount(options.limit, 40, 200));
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.functions(snapshot, { text:String(query ?? '') }, { offset, limit }, { signal:options.signal ?? null }),
        options);
      const page = copyWithMetadata(result);
      page.results = page.results.map((row) => {
        const address = remember(row);
        return { ...row, addr:address ?? row?.address ?? null };
      });
      page.matchCount = page.total;
      return page;
    },
  });

  define(context, 'searchStrings', {
    value:async (query, options = {}) => {
      const offset = safeCount(options.offset, 0, 1_000_000);
      const limit = Math.max(1, safeCount(options.limit, 50, 200));
      const need = Math.min(MAX_QUERY_PAGE, offset + limit + 1);
      return withFreshSnapshot(app, async (api, snapshot) => {
        const info = await api.binaryInfo(snapshot, { signal:options.signal ?? null });
        if (queryCompleteness(info) === 'unsupported' || !info?.value) {
          return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason:queryReason(info) || 'binary-info-unavailable' };
        }
        const all = [];
        let complete = true;
        let reason = null;
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
          if (queryCompleteness(result) === 'unsupported') continue;
          if (queryCompleteness(result) !== 'complete' || result?.page?.next != null) {
            complete = false;
            reason ||= queryReason(result) || 'search-incomplete';
          }
          for (const row of result?.value || []) {
            const address = toBigInt(row?.addr ?? row?.address);
            all.push({
              ...row,
              addr:undefined,
              address:undefined,
              stringAddress:address,
              regionId:region.id,
            });
            if (all.length >= need) break;
          }
        }
        const rows = all.slice(offset, offset + limit);
        const exhausted = offset + rows.length >= all.length;
        const pageComplete = complete && exhausted;
        return {
          results:rows,
          offset,
          returned:rows.length,
          total:pageComplete ? all.length : null,
          complete:pageComplete,
          truncated:!pageComplete,
          reason:pageComplete ? null : (reason || 'result-limit'),
        };
      }, options);
    },
  });

  define(context, 'getInstructions', {
    value:async (address, options = {}) => {
      const offset = safeCount(options.offset, 0, 1_000_000);
      const limit = Math.max(1, safeCount(options.limit, 160, 500));
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.instructions(snapshot, { functionId:address }, { offset, limit }, { signal:options.signal ?? null }),
        options);
      return copyWithMetadata(result);
    },
  });

  define(context, 'decompile', {
    value:async (address, options = {}) => {
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.decompile(snapshot, address, { signal:options.signal ?? null }), options);
      if (queryCompleteness(result) === 'unsupported' || result?.value == null) return null;
      return typeof result.value === 'string'
        ? result.value
        : (result.value.pseudocode ?? result.value.text ?? result.value.code ?? null);
    },
  });

  define(context, 'pseudocodeFor', { value:() => null });

  define(context, 'getCFG', {
    value:async (address, options = {}) => {
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.cfg(snapshot, address, { signal:options.signal ?? null }), options);
      if (queryCompleteness(result) === 'unsupported' || result?.value == null) {
        return { blocks:[], complete:false, truncated:true, reason:queryReason(result) || 'cfg-unavailable' };
      }
      return {
        ...result.value,
        complete:queryCompleteness(result) === 'complete',
        truncated:queryCompleteness(result) !== 'complete',
        reason:queryReason(result),
      };
    },
  });

  const graphPage = (method, address, options = {}) => {
    const offset = safeCount(options.offset, 0, 1_000_000);
    const limit = Math.max(1, safeCount(options.limit, 100, 1_000));
    return withFreshSnapshot(app, async (api, snapshot) => {
      const result = await api[method](snapshot, address, { offset, limit }, { signal:options.signal ?? null });
      return copyWithMetadata(result);
    }, options);
  };
  define(context, 'getXrefs', { value:(address, options = {}) => graphPage('xrefs', address, options) });
  define(context, 'getCallers', { value:(address, options = {}) => graphPage('callers', address, options) });
  define(context, 'getCallees', { value:(address, options = {}) => graphPage('callees', address, options) });

  define(context, 'findPaths', {
    value:async (from, to, options = {}) => withFreshSnapshot(app, async (api, snapshot) => {
      const result = await api.causalPath(snapshot, { functionId:from }, { functionId:to }, { ...options, signal:options.signal ?? null });
      if (queryCompleteness(result) === 'unsupported' || result?.value == null) {
        return { paths:[], returned:0, total:0, complete:false, truncated:true, unsupported:true, reason:queryReason(result) || 'causal-path-unavailable' };
      }
      return result.value;
    }, options),
  });

  return context;
}

export default createHexAIContext;
