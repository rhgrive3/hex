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

function wrappedValue(value, fallbackCompleteness = 'complete') {
  if (value == null) return null;
  const completeness = value?.status?.completeness ?? value?.completeness ?? fallbackCompleteness;
  return { value, status: { completeness } };
}

async function functionModel(app, functionId, options = {}) {
  if (typeof app?.analyzeFunction === 'function') {
    const value = await app.analyzeFunction(functionId, options);
    if (value != null) return value;
  }
  // App._fetchFunctionModel is deliberately non-UI-mutating: unlike
  // analyzeFunctionAt(), it does not publish navigation/workspace state. It is
  // therefore the compatibility bridge for the snapshot query layer until the
  // public App producer is promoted.
  if (typeof app?._fetchFunctionModel === 'function') {
    const value = await app._fetchFunctionModel(BigInt(functionId), options);
    if (value != null) return value;
  }
  return null;
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

export function createAppAnalysisQueryAdapter(app) {
  return {
    async currentIdentity(options = {}) {
      if (options.signal?.aborted) {
        const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('AbortError');
        error.name = 'AbortError';
        throw error;
      }
      const fileInfo = storeValue(app, 'fileInfo');
      const project = storeValue(app, 'project') ?? app?.project ?? null;
      let binaryId = app?.backend?.binaryId
        ?? fileInfo?.binaryId
        ?? fileInfo?.sha256
        ?? fileInfo?.hash
        ?? project?.binaryHash
        ?? project?.binary?.hash
        ?? null;
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
        try { binaryId = await app.ensureAnalysisIdentity(); } catch { /* remain explicitly unbound */ }
      }
      const projectRevision = Number(project?.revision ?? app?.projectRevision ?? 0);
      const analysisEpoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      return {
        binaryId: binaryId == null ? 'unbound' : String(binaryId),
        projectRevision: Number.isFinite(projectRevision) ? projectRevision : 0,
        artifactVersions: artifactVersionsFor(app),
        analysisEpoch: Number.isFinite(analysisEpoch) ? analysisEpoch : 0,
      };
    },

    async functionById(snapshot, functionId, options = {}) {
      const model = await functionModel(app, functionId, options);
      return wrappedValue(model) ?? unsupported(functionId, 'function-producer-unavailable');
    },

    async semanticIR(snapshot, functionId, options = {}) {
      if (typeof app?.getSemanticIR === 'function') {
        const value = await app.getSemanticIR(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const model = await functionModel(app, functionId, options);
      const ir = semanticIRFromModel(model);
      return wrappedValue(ir) ?? unsupported(functionId, model ? 'semantic-ir-unavailable' : 'function-producer-unavailable');
    },

    async cfg(snapshot, functionId, options = {}) {
      if (typeof app?.getCFG === 'function') {
        const value = await app.getCFG(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const model = await functionModel(app, functionId, options);
      const cfg = cfgFromModel(model);
      return wrappedValue(cfg) ?? unsupported(functionId, model ? 'cfg-unavailable' : 'function-producer-unavailable');
    },
  };
}
