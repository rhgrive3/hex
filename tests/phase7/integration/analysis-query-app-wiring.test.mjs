import assert from 'node:assert/strict';
import { AnalysisQueryAPI, AnalysisSnapshotStaleError, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

let epoch = 7;
let revision = 3;
let artifactVersions = { semantic: 'v2', cfg: 'v1' };
let producerCalls = 0;
const semanticIr = Object.freeze({ schemaVersion: 'semantic-ir/v2', nodes: [{ id: 'n1' }] });
const canonicalCfg = Object.freeze({ schemaVersion: 'cfg/v2', blocks: [{ id: 'b0' }], edges: [] });
const compatibilityIr = Object.freeze({ schemaVersion: 'legacy-ir/v1', instructions: [] });
const compatibilityCfg = Object.freeze({ blocks: [{ id: 'legacy-b0' }], edges: [] });
const analysis = Object.freeze({
  id: 'fn_1000',
  model: Object.freeze({
    ir: compatibilityIr,
    cfg: compatibilityCfg,
    semanticAnalysis: Object.freeze({ pipeline: Object.freeze({ semanticIr, cfg: canonicalCfg }) }),
  }),
  completeness: Object.freeze({ complete: true }),
});
const app = {
  store: {
    get(key) {
      if (key === 'fileInfo') return { hash: 'metadata-hash-that-must-not-win-over-backend-id' };
      if (key === 'project') return { revision };
      return null;
    },
  },
  backend: {
    binaryId: 'bin_live',
    analysisRoute: 'artifact',
    get gen() { return epoch; },
  },
  symbols: { gen: 2 },
  get analysisArtifactVersions() { return artifactVersions; },
  async analysisFunctionProducer(address) {
    producerCalls++;
    assert.equal(address, 0x1000n);
    return analysis;
  },
  async analyzeFunctionAt() {
    throw new Error('legacy route must not run after query installation');
  },
  validatedFunctionRange() {
    return { ok: true, start: 0x1000n, region: { id: 'text' } };
  },
  executableRegionFor() {
    return this.validatedFunctionRange().region;
  },
};

const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
app.analysisQueries = api;
assert.equal(app.analyzeFunctionAt.name, 'routedAnalyzeFunctionAt', 'the actual App function entry point must be routed');

const snapshot = await api.snapshot();
assert.equal(snapshot.binaryId, 'bin_live');
assert.equal(snapshot.projectRevision, revision);
assert.equal(snapshot.analysisEpoch, epoch);
assert.deepEqual(snapshot.artifactVersions, artifactVersions);

const fn = await api.function(snapshot, '0x1000');
assert.equal(fn.completeness, 'complete');
assert.equal(fn.value.id, 'fn_1000');

const ir = await api.semanticIR(snapshot, '0x1000');
assert.equal(ir.completeness, 'complete');
assert.equal(ir.value, semanticIr, 'query layer must prefer canonical semantic-v2 truth over compatibility projection');

const cfg = await api.cfg(snapshot, '0x1000');
assert.equal(cfg.completeness, 'complete');
assert.equal(cfg.value, canonicalCfg, 'query layer must prefer canonical semantic CFG over compatibility projection');
assert.equal(producerCalls, 3, 'each public query resolves once through the non-mutating producer');

revision++;
await assert.rejects(() => api.function(snapshot, '0x1000'), (error) => error instanceof AnalysisSnapshotStaleError);
revision--;

const versionSnapshot = await api.snapshot();
artifactVersions = { semantic: 'v3', cfg: 'v1' };
await assert.rejects(() => api.cfg(versionSnapshot, '0x1000'), (error) => error instanceof AnalysisSnapshotStaleError);
artifactVersions = { semantic: 'v2', cfg: 'v1' };

const epochSnapshot = await api.snapshot();
epoch++;
await assert.rejects(() => api.semanticIR(epochSnapshot, '0x1000'), (error) => error instanceof AnalysisSnapshotStaleError);
epoch--;

let afterQueryRevision = 10;
const midQueryAdapter = {
  async currentIdentity() {
    return { binaryId: 'bin_mid', projectRevision: afterQueryRevision, analysisEpoch: 1, artifactVersions: { semantic: '1' } };
  },
  async functionById() {
    afterQueryRevision++;
    return { id: 'fn_mid', status: { completeness: 'complete' } };
  },
};
const midQueryApi = new AnalysisQueryAPI(midQueryAdapter);
const midQuerySnapshot = await midQueryApi.snapshot();
await assert.rejects(
  () => midQueryApi.function(midQuerySnapshot, 'fn_mid'),
  (error) => error instanceof AnalysisSnapshotStaleError,
  'identity changes during execution must fail closed after the producer returns',
);

const unavailableApp = {
  store: { get: (key) => key === 'fileInfo' ? { hash: 'bin_unavailable' } : null },
  backend: { gen: 0, binaryId: 'bin_unavailable', analysisRoute: 'artifact' },
  symbols: { gen: 0 },
  async analyzeFunctionAt() { return null; },
};
const unavailableApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(unavailableApp));
unavailableApp.analysisQueries = unavailableApi;
const unavailableSnapshot = await unavailableApi.snapshot();
for (const query of [
  () => unavailableApi.function(unavailableSnapshot, '0x2000'),
  () => unavailableApi.semanticIR(unavailableSnapshot, '0x2000'),
  () => unavailableApi.cfg(unavailableSnapshot, '0x2000'),
]) {
  const result = await query();
  assert.equal(result.completeness, 'unsupported');
  assert.equal(result.value, null, 'missing producers must not fabricate empty complete analysis');
}

const truncatedAnalysis = {
  id: 'fn_truncated',
  truncated: true,
  completeness: { complete: false, reason: 'budget' },
  model: { semanticAnalysis: { pipeline: { semanticIr: { nodes: [] }, cfg: { blocks: [], edges: [] } } } },
};
const truncatedApp = {
  store: { get: () => null },
  backend: { gen: 4, binaryId: 'bin_truncated', analysisRoute: 'artifact' },
  symbols: { gen: 0 },
  analysisFunctionProducer: async () => truncatedAnalysis,
  analyzeFunctionAt: async () => null,
};
const truncatedApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(truncatedApp));
truncatedApp.analysisQueries = truncatedApi;
const truncatedSnapshot = await truncatedApi.snapshot();
assert.equal((await truncatedApi.function(truncatedSnapshot, '0x3000')).completeness, 'truncated');
assert.equal((await truncatedApi.semanticIR(truncatedSnapshot, '0x3000')).completeness, 'truncated');
assert.equal((await truncatedApi.cfg(truncatedSnapshot, '0x3000')).completeness, 'truncated');

let ensureBinaryIdCalls = 0;
const lazyBackend = {
  gen: 6,
  binaryId: null,
  analysisRoute: 'artifact',
  async ensureBinaryId({ signal } = {}) {
    assert.equal(signal, null);
    ensureBinaryIdCalls++;
    this.binaryId = 'bin_lazy_backend';
    return this.binaryId;
  },
};
const lazyApp = {
  store: { get: (key) => key === 'fileInfo' ? { hash: 'parser-metadata-must-not-bypass-canonical-backend-id' } : null },
  backend: lazyBackend,
  symbols: { gen: 0 },
  analyzeFunctionAt: async () => null,
};
const lazyIdentityApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(lazyApp));
lazyApp.analysisQueries = lazyIdentityApi;
const lazySnapshot = await lazyIdentityApi.snapshot();
assert.equal(lazySnapshot.binaryId, 'bin_lazy_backend', 'Backend canonical identity must outrank parser/project metadata');
assert.equal(ensureBinaryIdCalls, 1);
await lazyIdentityApi.snapshot();
assert.equal(ensureBinaryIdCalls, 1, 'cached Backend binaryId must avoid repeated hashing');

const derivedIdentityApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter({
  store: { get: () => null },
  backend: { gen: 2, binaryId: null, analysisRoute: 'artifact' },
  symbols: { gen: 0 },
  async ensureAnalysisIdentity() { return 'bin_derived'; },
  async analyzeFunctionAt() { return null; },
}));
assert.equal((await derivedIdentityApi.snapshot()).binaryId, 'bin_derived');

const unboundIdentityApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter({
  store: { get: () => null },
  backend: { gen: 3, binaryId: null, analysisRoute: 'artifact' },
  symbols: { gen: 0 },
  async analyzeFunctionAt() { return null; },
}));
await assert.rejects(
  () => unboundIdentityApi.snapshot(),
  (error) => error?.code === 'ANALYSIS_QUERY_BINARY_UNBOUND',
  'unbound binary identity must not be converted into a reusable pseudo-snapshot',
);

console.log('phase7 AnalysisQueryAPI App wiring: PASS');
