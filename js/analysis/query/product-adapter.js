import { createAppAnalysisQueryAdapter as createBaseAdapter } from './app-adapter.js';

const SAFE_ROUTE = Symbol('analysis-query-safe-ui-route');

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
  } catch { /* compatibility-shaped state below */ }
  return app?.store?.[key] ?? null;
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
  try { route = backend?.analysisRouteInfo?.()?.route ?? route; } catch { /* stable conservative identity */ }
  const capability = storeValue(app, 'capability') || {};
  return {
    queryContract: 'analysis-query-public-product/v2',
    analysisRoute: String(route ?? 'unknown'),
    architecture: String(storeValue(app, 'architecture') ?? capability.architecture ?? 'unknown'),
    capabilityContract: String(capability.semanticVersion ?? capability.analysisVersion ?? capability.version ?? 'unspecified'),
    instructionAlignment: String(storeValue(app, 'instructionAlignment') ?? capability.instructionAlignment ?? 'unknown'),
    symbolsGeneration: String(app?.symbols?.gen ?? 0),
    sliceIndex: String(storeValue(app, 'sliceIndex') ?? -1),
  };
}

async function canonicalIdentity(app, options = {}) {
  abortIfNeeded(options.signal);
  const backend = app?.backend ?? null;
  const fileInfo = storeValue(app, 'fileInfo');
  const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.activeProject ?? app?.project ?? null;
  let binaryId = backend?.binaryId ?? null;

  // A live Backend can derive a content-addressed identity, so parser/project
  // metadata must never short-circuit it. Metadata is only a compatibility
  // fallback for adapter-shaped consumers without Backend identity support.
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
}

function settleUiRoute(app) {
  const routed = app?.analyzeFunctionAt;
  if (typeof routed !== 'function' || routed[SAFE_ROUTE]) return;
  const safe = async function routedAnalyzeFunctionAt(id, options = {}) {
    try {
      return await routed.call(app, id, options);
    } catch {
      // The historical App entry point is intentionally fire-and-forget from
      // navigation. Preserve its null-on-analysis-failure contract so a hash,
      // stale-snapshot, ABI, or producer failure cannot become an unhandled UI
      // rejection. Direct AnalysisQueryAPI calls remain fail-closed.
      return null;
    }
  };
  Object.defineProperty(safe, SAFE_ROUTE, { value: true });
  app.analyzeFunctionAt = safe;
}

export function createAppAnalysisQueryAdapter(app) {
  const base = createBaseAdapter(app);
  settleUiRoute(app);
  return {
    ...base,
    currentIdentity: (options = {}) => canonicalIdentity(app, options),
  };
}
