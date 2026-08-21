import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';
import { buildOverlay } from '../../narrate.js';

const QUERY_ROUTED_ANALYZE = Symbol('analysis-query-routed-analyze');
const QUERY_PRODUCER_VERSION = 'analysis-query-function-producer/v3';
const COMPLETENESS = new Set(['complete', 'partial', 'truncated', 'unsupported']);

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  throw error;
}

function storeValue(app, key) {
  try {
    if (typeof app?.store?.get === 'function') return app.store.get(key);
  } catch { /* fall through to compatibility-shaped state */ }
  return app?.store?.[key] ?? null;
}

function unsupported(functionId, reason) {
  return { value: null, functionId, status: { completeness: 'unsupported', reason } };
}

function completenessOf(value, fallbackCompleteness = 'complete') {
  const raw = value?.status?.completeness ?? value?.completeness;
  if (typeof raw === 'string') return COMPLETENESS.has(raw) ? raw : 'partial';
  if (raw && typeof raw === 'object') {
    if (raw.complete === true) return value?.truncated === true ? 'truncated' : 'complete';
    if (raw.complete === false) return raw.reason === 'unsupported' ? 'unsupported' : 'partial';
  }
  if (value?.unsupported === true) return 'unsupported';
  if (value?.truncated === true) return 'truncated';
  if (value?.partial === true || value?.complete === false) return 'partial';
  return COMPLETENESS.has(fallbackCompleteness) ? fallbackCompleteness : 'partial';
}

function wrappedValue(value, fallbackCompleteness = 'complete') {
  if (value == null) return null;
  return { value, status: { completeness: completenessOf(value, fallbackCompleteness) } };
}

function semanticIRFromAnalysis(analysis) {
  const model = analysis?.model ?? analysis;
  return model?.semanticAnalysis?.pipeline?.semanticIr ?? model?.semanticIR ?? model?.ir ?? null;
}

function cfgFromAnalysis(analysis) {
  const model = analysis?.model ?? analysis;
  return model?.semanticAnalysis?.pipeline?.cfg ?? model?.cfg ?? null;
}

function nonNegativeSafeInteger(value, fallback, code) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(code);
  return number;
}

function artifactVersionsFor(app) {
  const direct = app?.analysisArtifactVersions ?? app?.artifactVersions ?? null;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { ...direct };
  const backend = app?.backend;
  let route = backend?.analysisRoute ?? 'unknown';
  try { route = backend?.analysisRouteInfo?.()?.route ?? route; } catch { /* conservative identity below */ }
  const capability = storeValue(app, 'capability') || {};
  return {
    queryProducer: QUERY_PRODUCER_VERSION,
    analysisRoute: String(route ?? 'unknown'),
    architecture: String(storeValue(app, 'architecture') ?? capability.architecture ?? 'unknown'),
    capabilityContract: String(capability.semanticVersion ?? capability.analysisVersion ?? capability.version ?? 'unspecified'),
    instructionAlignment: String(storeValue(app, 'instructionAlignment') ?? capability.instructionAlignment ?? 'unknown'),
    symbolsGeneration: String(app?.symbols?.gen ?? 0),
    sliceIndex: String(storeValue(app, 'sliceIndex') ?? -1),
  };
}

function asAddress(value) {
  if (value == null || typeof value === 'boolean') throw new TypeError('analysis-query-function-address-invalid');
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('analysis-query-function-address-invalid');
  }
  if (typeof value === 'string' && !value.trim()) throw new TypeError('analysis-query-function-address-invalid');
  try {
    const address = typeof value === 'bigint' ? value : BigInt(value);
    if (address < 0n) throw new Error('negative-address');
    return address;
  } catch {
    throw new TypeError('analysis-query-function-address-invalid');
  }
}

function createLiveFunctionProducer(app) {
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
    if (!region || range.start == null || range.end == null || region.vmAddr == null || region.size == null) return null;
    const alignment = Number(storeValue(app, 'instructionAlignment') ?? capability?.instructionAlignment ?? 4);
    if (!Number.isSafeInteger(alignment) || alignment < 1) return null;
    const width = BigInt(alignment);
    const start = BigInt(range.start);
    const end = BigInt(range.end);
    const vmAddr = BigInt(region.vmAddr);
    const size = BigInt(region.size);
    if (start < vmAddr || end <= start || size <= 0n || (start - vmAddr) % width !== 0n) return null;

    const startRow = Number((start - vmAddr) / width);
    const endRow = Math.min(
      Number((end - vmAddr + width - 1n) / width) - 1,
      Math.max(0, Number(size / width) - 1),
    );
    if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || endRow < startRow) return null;

    const result = await analyzeFunctionCached(
      app.backend,
      region,
      startRow,
      endRow,
      symbols,
      options.onProgress,
      options.analysisOptions || {},
    );
    abortIfNeeded(options.signal);

    const sliceIndex = Number(storeValue(app, 'sliceIndex'));
    if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0 || app?.executableRegionFor?.(start) !== region) return null;
    const truncated = result?.truncated === true;
    return {
      ...result,
      completeness: {
        complete: range.complete !== false && !truncated,
        reason: truncated ? 'function-analysis-budget' : range.reason || null,
        provenance: range.provenance,
        regionId: region.id,
      },
    };
  };
}

function publishFunctionAnalysis(app, address, result) {
  if (!result?.model) return result;
  const range = app?.validatedFunctionRange?.(address);
  if (!range?.ok || !range.region || app?.executableRegionFor?.(range.start) !== range.region) return null;
  app.semantic = { regionId: range.region.id, model: result.model, result };
  if (storeValue(app, 'currentRegion') === range.region) {
    app?.viewer?.setBlockOverlay?.(range.region.id, buildOverlay(result.model));
  }
  return result;
}

function installLiveFunctionQueryRoute(app) {
  if (!app || typeof app.analyzeFunctionAt !== 'function' || app.analyzeFunctionAt?.[QUERY_ROUTED_ANALYZE]) return;
  const original = app.analyzeFunctionAt.bind(app);
  const routed = async function routedAnalyzeFunctionAt(functionId, options = {}) {
    try {
      const address = asAddress(functionId);
      const queries = app.analysisQueries;
      if (!queries || typeof queries.snapshot !== 'function' || typeof queries.function !== 'function') {
        return await original(address, options);
      }
      const snapshot = await queries.snapshot(options);
      const result = await queries.function(snapshot, address, options);
      if (result.completeness === 'unsupported' || result.value == null) return null;
      return publishFunctionAnalysis(app, address, result.value);
    } catch {
      // App.analyzeFunctionAt is a fire-and-forget UI compatibility entry point.
      // Direct AnalysisQueryAPI callers keep the fail-closed error contract.
      return null;
    }
  };
  Object.defineProperty(routed, QUERY_ROUTED_ANALYZE, { value: true });
  app.analyzeFunctionAt = routed;
}

export function createAppAnalysisQueryAdapter(app) {
  const producer = createLiveFunctionProducer(app);
  const adapter = {
    async currentIdentity(options = {}) {
      abortIfNeeded(options.signal);
      const fileInfo = storeValue(app, 'fileInfo');
      const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.activeProject ?? app?.project ?? null;
      const backend = app?.backend ?? null;
      let binaryId = backend?.binaryId ?? null;

      // When a real Backend is present, its content-derived binary ID is the
      // canonical authority. Parser/project metadata is only a compatibility
      // fallback for adapter-shaped consumers that cannot derive content ID.
      if (!binaryId && typeof backend?.ensureBinaryId === 'function') {
        binaryId = await backend.ensureBinaryId({
          signal: options.signal ?? null,
          onProgress: options.onIdentityProgress ?? options.onProgress,
        });
      }
      if (!binaryId) {
        binaryId = fileInfo?.binaryId
          ?? fileInfo?.sha256
          ?? fileInfo?.hash
          ?? project?.binaryHash
          ?? project?.binary?.hash
          ?? null;
      }
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
        binaryId = await app.ensureAnalysisIdentity(options);
      }
      abortIfNeeded(options.signal);
      if (!binaryId) {
        const error = new Error('analysis-query-binary-unbound');
        error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
        throw error;
      }

      return {
        binaryId: String(binaryId),
        projectRevision: nonNegativeSafeInteger(
          project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision,
          0,
          'analysis-query-project-revision-invalid',
        ),
        artifactVersions: artifactVersionsFor(app),
        analysisEpoch: nonNegativeSafeInteger(
          backend?.gen ?? app?.analysisEpoch,
          0,
          'analysis-query-epoch-invalid',
        ),
      };
    },

    async functionById(snapshot, functionId, options = {}) {
      const analysis = await producer(asAddress(functionId), options);
      return wrappedValue(analysis) ?? unsupported(functionId, 'function-producer-unavailable');
    },

    async semanticIR(snapshot, functionId, options = {}) {
      const analysis = await producer(asAddress(functionId), options);
      const ir = semanticIRFromAnalysis(analysis);
      return wrappedValue(ir, completenessOf(analysis))
        ?? unsupported(functionId, analysis ? 'semantic-ir-unavailable' : 'function-producer-unavailable');
    },

    async cfg(snapshot, functionId, options = {}) {
      const analysis = await producer(asAddress(functionId), options);
      const cfg = cfgFromAnalysis(analysis);
      return wrappedValue(cfg, completenessOf(analysis))
        ?? unsupported(functionId, analysis ? 'cfg-unavailable' : 'function-producer-unavailable');
    },
  };

  installLiveFunctionQueryRoute(app);
  return adapter;
}
