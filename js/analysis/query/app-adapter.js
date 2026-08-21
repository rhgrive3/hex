const QUERY_ROUTED_FETCH = Symbol('analysis-query-routed-fetch');

function storeValue(app, key) {
  try {
    if (typeof app?.store?.get === 'function') return app.store.get(key);
  } catch { /* fall through to compatibility-shaped state */ }
  return app?.store?.[key] ?? null;
}

function unsupported(functionId, reason) {
  return {
    value: null,
    functionId,
    status: { completeness: 'unsupported', reason },
  };
}

function completenessOf(value, fallbackCompleteness = 'complete') {
  if (value?.status?.completeness != null) return value.status.completeness;
  if (value?.completeness != null) return value.completeness;
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

function artifactVersionsFor(app) {
  const direct = app?.analysisArtifactVersions ?? app?.artifactVersions ?? null;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { ...direct };
  return {};
}

function installFunctionQueryRoute(app, directFetch) {
  if (!app || typeof directFetch !== 'function') return;
  const current = app._fetchFunctionModel;
  if (current?.[QUERY_ROUTED_FETCH]) return;
  const routed = async function routedFunctionModel(functionId, options = {}) {
    const queries = app.analysisQueries;
    if (!queries || typeof queries.snapshot !== 'function' || typeof queries.function !== 'function') {
      return directFetch(BigInt(functionId), options);
    }
    const snapshot = await queries.snapshot(options);
    const result = await queries.function(snapshot, functionId, options);
    if (result.completeness === 'unsupported' || result.value == null) {
      const error = new Error('analysis-query-function-unavailable');
      error.code = 'ANALYSIS_QUERY_FUNCTION_UNAVAILABLE';
      throw error;
    }
    return result.value;
  };
  Object.defineProperty(routed, QUERY_ROUTED_FETCH, { value: directFetch });
  app._fetchFunctionModel = routed;
}

export function createAppAnalysisQueryAdapter(app) {
  const existingFetch = typeof app?._fetchFunctionModel === 'function' ? app._fetchFunctionModel : null;
  const directFetch = existingFetch?.[QUERY_ROUTED_FETCH]
    ?? (existingFetch ? existingFetch.bind(app) : null);

  const loadFunction = async (functionId, options = {}) => {
    if (typeof app?.analyzeFunction === 'function') {
      const value = await app.analyzeFunction(functionId, options);
      if (value != null) return value;
    }
    // Capture the producer before installing the query route. The adapter must
    // terminate at the actual producer rather than recursively re-enter itself.
    if (directFetch) {
      const value = await directFetch(BigInt(functionId), options);
      if (value != null) return value;
    }
    return null;
  };

  const adapter = {
    async currentIdentity(options = {}) {
      if (options.signal?.aborted) {
        const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('AbortError');
        error.name = 'AbortError';
        throw error;
      }
      const fileInfo = storeValue(app, 'fileInfo');
      const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
      let binaryId = app?.backend?.binaryId
        ?? fileInfo?.binaryId
        ?? fileInfo?.sha256
        ?? fileInfo?.hash
        ?? project?.binaryHash
        ?? project?.binary?.hash
        ?? null;
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
        try { binaryId = await app.ensureAnalysisIdentity(); } catch { /* handled below */ }
      }
      if (!binaryId) {
        const error = new Error('analysis-query-binary-unbound');
        error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
        throw error;
      }
      const projectRevision = Number(
        project?.revision
        ?? app?.projectRevision
        ?? app?.workspace?.bindingRevision
        ?? 0
      );
      const analysisEpoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      return {
        binaryId: String(binaryId),
        projectRevision: Number.isFinite(projectRevision) ? projectRevision : 0,
        artifactVersions: artifactVersionsFor(app),
        analysisEpoch: Number.isFinite(analysisEpoch) ? analysisEpoch : 0,
      };
    },

    async functionById(snapshot, functionId, options = {}) {
      const model = await loadFunction(functionId, options);
      return wrappedValue(model) ?? unsupported(functionId, 'function-producer-unavailable');
    },

    async semanticIR(snapshot, functionId, options = {}) {
      if (typeof app?.getSemanticIR === 'function') {
        const value = await app.getSemanticIR(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const model = await loadFunction(functionId, options);
      const ir = semanticIRFromModel(model);
      return wrappedValue(ir, completenessOf(model)) ?? unsupported(functionId, model ? 'semantic-ir-unavailable' : 'function-producer-unavailable');
    },

    async cfg(snapshot, functionId, options = {}) {
      if (typeof app?.getCFG === 'function') {
        const value = await app.getCFG(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const model = await loadFunction(functionId, options);
      const cfg = cfgFromModel(model);
      return wrappedValue(cfg, completenessOf(model)) ?? unsupported(functionId, model ? 'cfg-unavailable' : 'function-producer-unavailable');
    },
  };

  // App constructs the adapter and query API together. Routing the existing
  // non-mutating function producer here makes every current first-party
  // Function Workspace read cross the immutable snapshot boundary without
  // changing navigation/UI side effects or introducing a second analyzer.
  installFunctionQueryRoute(app, directFetch);
  return adapter;
}
