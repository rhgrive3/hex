import assert from 'node:assert/strict';
import {
  AnalysisQueryAPI,
  AnalysisSnapshotStaleError,
  createAnalysisSnapshot,
  createAppAnalysisQueryAdapter,
} from '../../../js/analysis/query/index.js';

function makeStore(entries) {
  const state = new Map(Object.entries(entries));
  return {
    state,
    get(key) { return state.get(key) ?? null; },
  };
}

/* The product route must wrap the method App actually owns: analyzeFunctionAt.
   No _fetchFunctionModel/analyzeFunction test-only producer exists here. */
{
  let epoch = 7;
  let revision = 3;
  let producerCalls = 0;
  let legacyCalls = 0;
  let overlayCalls = 0;
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, revision: 2 };
  const semanticIr = Object.freeze({ schemaVersion: 'semantic-ir/v2', nodes: [{ id: 'n1' }] });
  const canonicalCfg = Object.freeze({ schemaVersion: 'cfg/v2', blocks: [{ id: 'b0' }], edges: [] });
  const result = Object.freeze({
    model: Object.freeze({
      semanticAnalysis: Object.freeze({ pipeline: Object.freeze({ semanticIr, cfg: canonicalCfg }) }),
      semanticIR: Object.freeze({ schemaVersion: 'legacy-ir/v1' }),
      cfg: Object.freeze({ blocks: [{ id: 'legacy' }] }),
    }),
    completeness: Object.freeze({ complete: true, reason: null, regionId: region.id }),
    truncated: false,
  });
  const store = makeStore({
    fileInfo: { hash: 'file-hash-that-must-not-win' },
    architecture: 'arm64',
    capability: { architecture: 'arm64', semanticVersion: 'arm64-semantic/test', instructionAlignment: 4 },
    canDisassemble: true,
    instructionAlignment: 4,
    sliceIndex: 0,
    currentRegion: region,
  });
  const app = {
    store,
    backend: {
      binaryId: 'bin_live',
      analysisRoute: 'artifact',
      get gen() { return epoch; },
      analysisRouteInfo() { return { route: this.analysisRoute }; },
    },
    workspace: { get bindingRevision() { return revision; }, project: null },
    symbols: { gen: 11, functionCount: 1 },
    validatedFunctionRange(address) {
      assert.equal(address, 0x1000n);
      return { ok: true, start: 0x1000n, end: 0x1040n, region, complete: true, provenance: 'test-range' };
    },
    executableRegionFor() { return region; },
    viewer: { setBlockOverlay() { overlayCalls++; } },
    async analysisFunctionProducer(address) {
      producerCalls++;
      assert.equal(address, 0x1000n);
      return result;
    },
    async analyzeFunctionAt() {
      legacyCalls++;
      return { legacy: true };
    },
  };

  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);
  app.analysisQueries = api;
  assert.equal(app.analyzeFunctionAt.name, 'routedAnalyzeFunctionAt', 'the real App entry point must be routed');

  const snapshot = await api.snapshot();
  assert.equal(snapshot.binaryId, 'bin_live');
  assert.equal(snapshot.projectRevision, revision);
  assert.equal(snapshot.analysisEpoch, epoch);
  assert.equal(snapshot.artifactVersions.queryProducer, 'analysis-query-function-producer/v3');
  assert.equal(snapshot.artifactVersions.analysisRoute, 'artifact');
  assert.equal(snapshot.artifactVersions.symbolsGeneration, '11');

  const direct = await api.function(snapshot, 0x1000n);
  assert.equal(direct.completeness, 'complete');
  assert.equal(direct.value, result);
  assert.equal(app.semantic, undefined, 'read-only query must not publish UI state');
  assert.equal(overlayCalls, 0);

  const ir = await api.semanticIR(snapshot, 0x1000n);
  assert.equal(ir.value, semanticIr, 'canonical semantic-v2 IR must beat compatibility projection');
  const cfg = await api.cfg(snapshot, 0x1000n);
  assert.equal(cfg.value, canonicalCfg, 'canonical CFG must beat compatibility projection');

  const workspace = await app.analyzeFunctionAt(0x1000n);
  assert.equal(workspace, result);
  assert.equal(legacyCalls, 0, 'live workspace must not bypass QueryAPI through the legacy method');
  assert.equal(app.semantic?.model, result.model, 'workspace publishes only after snapshot validation succeeds');
  assert.equal(overlayCalls, 1);
  assert.equal(producerCalls, 4, 'each query terminates exactly once at the non-mutating producer');

  revision++;
  await assert.rejects(() => api.function(snapshot, 0x1000n), (error) => error instanceof AnalysisSnapshotStaleError);
  revision--;

  const artifactSnapshot = await api.snapshot();
  app.symbols.gen++;
  await assert.rejects(() => api.cfg(artifactSnapshot, 0x1000n), (error) => error instanceof AnalysisSnapshotStaleError);
  app.symbols.gen--;

  const epochSnapshot = await api.snapshot();
  epoch++;
  await assert.rejects(() => api.semanticIR(epochSnapshot, 0x1000n), (error) => error instanceof AnalysisSnapshotStaleError);
  epoch--;
}

/* App has no hidden producer in production. Prove the adapter's real ARM64
   fallback reaches analyzeFunctionCached and remains non-mutating until the
   routed workspace method publishes. */
{
  const region = { id: 'fallback-text', vmAddr: 0x4000n, size: 4n, revision: 1 };
  const store = makeStore({
    fileInfo: { name: 'fallback' },
    architecture: 'arm64',
    capability: { architecture: 'arm64', instructionAlignment: 4 },
    canDisassemble: true,
    instructionAlignment: 4,
    sliceIndex: 0,
    currentRegion: region,
  });
  let fetchChunkCalls = 0;
  let overlayCalls = 0;
  const app = {
    store,
    backend: {
      binaryId: 'bin_fallback',
      gen: 2,
      analysisRoute: 'artifact',
      analysisRouteInfo: () => ({ route: 'artifact' }),
      async fetchChunk(regionId, chunk, wantAsm) {
        fetchChunkCalls++;
        assert.equal(regionId, region.id);
        assert.equal(chunk, 0);
        assert.equal(wantAsm, true);
        return { mn: ['ret'], ops: [''], bytes: new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]) };
      },
      async readAt() { return null; },
    },
    workspace: { bindingRevision: 0, project: null },
    symbols: {
      gen: 1,
      functionCount: 1,
      nameAt() { return null; },
    },
    validatedFunctionRange(address) {
      return address === 0x4000n
        ? { ok: true, start: 0x4000n, end: 0x4004n, region, complete: true, provenance: 'fallback-range' }
        : { ok: false };
    },
    executableRegionFor(address) { return address === 0x4000n ? region : null; },
    viewer: { setBlockOverlay() { overlayCalls++; } },
    async analyzeFunctionAt() { throw new Error('legacy-direct-path-must-not-run'); },
  };
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  app.analysisQueries = api;
  const snapshot = await api.snapshot();
  const direct = await api.function(snapshot, 0x4000n);
  assert.equal(direct.completeness, 'complete');
  assert.ok(direct.value?.model, 'fallback producer must build the real semantic model');
  assert.equal(app.semantic, undefined);
  assert.equal(overlayCalls, 0);
  assert.equal(fetchChunkCalls, 1);

  const published = await app.analyzeFunctionAt(0x4000n);
  assert.ok(published?.model);
  assert.equal(app.semantic?.model, published.model);
  assert.equal(overlayCalls, 1);
  assert.equal(fetchChunkCalls, 1, 'analysis cache must prevent a second backend decode');
}

/* Snapshot identity is a capability boundary. Rewriting fields while keeping
   the original snapshotId must never be accepted. */
{
  const valid = createAnalysisSnapshot({
    binaryId: 'bin_snapshot',
    projectRevision: 2,
    analysisEpoch: 9,
    artifactVersions: { semantic: { schema: 2, producer: 'a' } },
  });
  const tampered = { ...valid, projectRevision: 3 };
  assert.throws(
    () => {
      // Validation happens before the adapter is touched.
      const api = new AnalysisQueryAPI({
        currentIdentity: async () => valid,
        functionById: async () => ({ value: null, status: { completeness: 'unsupported' } }),
      });
      return api.function(tampered, 0x10n);
    },
    /analysis-snapshot-identity-mismatch/,
  );
  assert.throws(() => createAnalysisSnapshot({ binaryId: 'x', analysisEpoch: Number.MAX_SAFE_INTEGER + 1 }), /analysis-snapshot-epoch-invalid/);
  assert.throws(() => createAnalysisSnapshot({ binaryId: 'x', analysisEpoch: 1, projectRevision: -1 }), /analysis-snapshot-project-revision-invalid/);
}

/* Nested artifact versions must participate structurally; String(object)
   equality would incorrectly treat both objects as "[object Object]". */
{
  let version = 1;
  const adapter = {
    async currentIdentity() {
      return {
        binaryId: 'bin_nested', projectRevision: 0, analysisEpoch: 1,
        artifactVersions: { semantic: { version } },
      };
    },
    async functionById() { return { value: 1, status: { completeness: 'complete' } }; },
  };
  const api = new AnalysisQueryAPI(adapter);
  const snapshot = await api.snapshot();
  version = 2;
  await assert.rejects(() => api.function(snapshot, 0x20n), (error) => error instanceof AnalysisSnapshotStaleError);
}

console.log('phase7 AnalysisQueryAPI live product route: PASS');
