import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';
import { buildOverlay } from '../../narrate.js';

const QUERY_ROUTED_ANALYZE = Symbol('analysis-query-routed-analyze');
const QUERY_PRODUCER_VERSION = 'analysis-query-function-producer/v2';

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('AbortError');
  error.name ||= 'AbortError';
  throw error;
}

function storeValue(app, key) {
  try {
    if (typeof app?.store?.get === 'function') return app.store.get(key);
  } catch { /* fail through to compatibility-shaped state */ }
  return app?.store?.[key] ?? null;
}

function unsupported(functionId, reason) {
  return { value: null, functionId, status: { completeness: 'unsupported', reason } };
}

function completenessOf(value, fallbackCompleteness = 'complete') {
  const raw = value?.status?.completeness ?? value?.completeness;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    if (raw.complete === true) return value?.truncated === true ? 'truncated' : 'complete';
    if (raw.complete === false) return raw.reason === 'unsupported' ? 'unsupported' : 'partial';
  }
  if (value?.unsupported === true) return 'unsupported';
  if (value?.truncated === true) return 'truncated';
  if (value?.partial === true || value?.complete === false) return 'partial';
  return fallbackCompleteness;
}

function wrappedValue(value, fallbackCompleteness = 'complete') {
  if (value == null) return null;
  return { value, status: { completeness: completenessOf(value, fallbackCompleteness) } };
}

function semanticIRFromModel(model) {
  return model?.semanticAnalysis?.pipeline?.semanticIr ?? model?.semanticIR ?? model?.ir ?? null;
}

function cfgFromModel(model) {
  return model?.semanticAnalysis?.pipeline?.cfg ?? model?.cfg ?? null;
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function artifactVersionsFor(app) {
  const direct = app?.analysisArtifactVersions ?? app?.artifactVersions ?? null;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { ...direct };
  const backend = app?.backend;
  let route = backend?.analysisRoute ?? 'unknown';
  try { route = backend?.analysisRouteInfo?.()?.route ?? route; } catch { /* identity remains conservative */ }
  const capability = storeValue(app, 'capability') || {};
  const region = storeValue(app, 'currentRegion');
  return {
    queryProducer: QUERY_PRODUCER_VERSION,
    analysisRoute: String(route ?? 'unknown'),
    architecture: String(storeValue(app, 'architecture') ?? capability.architecture ?? 'unknown'),
    capabilityContract: String(capability.semanticVersion ?? capability.analysisVersion ?? capability.version ?? 'unspecified'),
    symbolsGeneration: String(app?.symbols?.gen ?? 0),
    sliceIndex: String(storeValue(app, 'sliceIndex') ?? -1),
    currentRegionIdentity: String(region?.id ?? 'none'),
    currentRegionRevision: String(region?.revision ?? region?.gen ?? region?.generation ?? 0),
  };
}

function asAddress(value) {
  if (value == null || typeof value === 'boolean') throw new TypeError('analysis-query-function-address-invalid');
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError('analysis-query-function-address-invalid');
  if (typeof value === 'string' && !value.trim()) throw new TypeError('analysis-query-function-address-invalid');
  try {
    const address = typeof value === 'bigint' ? value : BigInt(value);
    if (address < 0n) throw new Error('negative');
    return address;
  } catch {
    throw new TypeError('analysis-query-function-address-invalid');
  }
}

function liveFunctionProducer(app) {
  if (typeof app?.analysisFunctionProducer === 'function') return app.analysisFunctionProducer.bind(app);
  return async (functionId, options = {}) => {
    abortIfNeeded(options.signal);
    const address = asAddress(functionId);
    const symbols = app?.symbols;
    const range = app?.validatedFunctionRange?.(address);
    const capability = storeValue(app, 'capability');
    const architecture = storeValue(app, 'architecture') ?? capability?.architecture ?? null;
    if (!app?.backend || !symbols || !supportsArm64SemanticAnalysis(architecture)
        || !range?.ok || storeValue(app, 'canDisassemble') !== true || !symbols.functionCount) return null;
    const region = range.region;
    const alignment = Math.max(1, Number(storeValue(app, 'instructionAlignment') ?? capability?.instructionAlignment ?? 4));
    if (!Number.isSafeInteger(alignment) || alignment < 1) return null;
    const width = BigInt(alignment);
    if ((range.start - region.vmAddr) % width !== 0n) return null;
    const startRow = Number((range.start - region.vmAddr) / width);
    const endRow = Math.min(
      Number((range.end - region.vmAddr + width - 1n) / width) - 1,
      Math.max(0, Number(region.size / width) - 1),
    );
    if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || endRow < startRow) return null;
    const result = await analyzeFunctionCached(app.backend, region, startRow, endRow, symbols, options.onProgress, options.analysisOptions || {});
    abortIfNeeded(options.signal);
    if (storeValue(app, 'sliceIndex') < 0 || app?.executableRegionFor?.(range.start) !== region) return null;
    result.completeness = {
      complete: range.complete !== false && result.truncated !== true,
      reason: result.truncated === true ? 'function-analysis-budget' : range.reason || null,
      provenance: range.provenance,
      regionId: region.id,
    };
    return result;
  };
}

function publishFunctionAnalysis(app, address, result) {
  if (!result?.model) return result;
  const range = app?.validatedFunctionRange?.(address);
  if (!range?.ok || !range.region) return result;
  app.semantic = { regionId: range.region.id, model: result.model, result };
  if (storeValue(app, 'currentRegion') === range.region) app?.viewer?.setBlockOverlay?.(range.region.id, buildOverlay(result.model));
  return result;
}

function installLiveFunctionQueryRoute(app, producer) {
  if (!app || typeof app.analyzeFunctionAt !== 'function' || app.analyzeFunctionAt?.[QUERY_ROUTED_ANALYZE]) return;
  const routed = async function routedAnalyzeFunctionAt(functionId, options = {}) {
    const address = asAddress(functionId);
    const queries = app.analysisQueries;
    if (!queries || typeof queries.snapshot !== 'function' || typeof queries.function !== 'function') {
      return publishFunctionAnalysis(app, address, await producer(address, options));
    }
    const snapshot = await queries.snapshot(options);
    const result = await queries.function(snapshot, address, options);
    if (result.completeness === 'unsupported' || result.value == null) return null;
    return publishFunctionAnalysis(app, address, result.value);
  };
  Object.defineProperty(routed, QUERY_ROUTED_ANALYZE, { value: true });
  app.analyzeFunctionAt = routed;
}

export function createAppAnalysisQueryAdapter(app) {
  const producer = liveFunctionProducer(app);
  const adapter = {
    async currentIdentity(options = {}) {
      abortIfNeeded(options.signal);
      const fileInfo = storeValue(app, 'fileInfo');
      const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.activeProject ?? null;
      let binaryId = app?.backend?.binaryId
        ?? fileInfo?.binaryId
        ?? fileInfo?.sha256
        ?? fileInfo?.hash
        ?? project?.binaryHash
        ?? project?.binary?.hash
        ?? null;
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') binaryId = await app.ensureAnalysisIdentity();
      abortIfNeeded(options.signal);
      if (!binaryId) {
        const error = new Error('analysis-query-binary-unbound');
        error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
        throw error;
      }
      const projectRevision = safeInteger(project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0);
      const analysisEpoch = safeInteger(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      return {
        binaryId: String(binaryId),
        projectRevision,
        artifactVersions: artifactVersionsFor(app),
        analysisEpoch,
      };
    },

    async functionById(snapshot, functionId, options = {}) {
      const model = await producer(functionId, options);
      return wrappedValue(model) ?? unsupported(functionId, 'function-producer-unavailable');
    },

    async semanticIR(snapshot, functionId, options = {}) {
      if (typeof app?.getSemanticIR === 'function') {
        const value = await app.getSemanticIR(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const model = await producer(functionId, options);
      const ir = semanticIRFromModel(model?.model ?? model);
      return wrappedValue(ir, completenessOf(model)) ?? unsupported(functionId, model ? 'semantic-ir-unavailable' : 'function-producer-unavailable');
    },

    async cfg(snapshot, functionId, options = {}) {
      if (typeof app?.getCFG === 'function') {
        const value = await app.getCFG(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const model = await producer(functionId, options);
      const cfg = cfgFromModel(model?.model ?? model);
      return wrappedValue(cfg, completenessOf(model)) ?? unsupported(functionId, model ? 'cfg-unavailable' : 'function-producer-unavailable');
    },
  };

  installLiveFunctionQueryRoute(app, producer);
  return adapter;
}
