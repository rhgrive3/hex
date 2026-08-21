import assert from 'node:assert/strict';
import { AnalysisQueryAPI, AnalysisSnapshotStaleError, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

let epoch = 7;
let revision = 3;
let artifactVersions = { semantic: 'v2', cfg: 'v1' };
let fetches = 0;
const semanticIr = Object.freeze({ schemaVersion: 'semantic-ir/v2', nodes: [{ id: 'n1' }] });
const canonicalCfg = Object.freeze({ schemaVersion: 'cfg/v2', blocks: [{ id: 'b0' }], edges: [] });
const compatibilityIr = Object.freeze({ schemaVersion: 'legacy-ir/v1', instructions: [] });
const compatibilityCfg = Object.freeze({ blocks: [{ id: 'legacy-b0' }], edges: [] });
const app = {
  store: {
    get(key) {
      if (key === 'fileInfo') return { hash: 'file-hash-that-must-not-win-over-backend-id' };
      if (key === 'project') return { revision };
      return null;
    },
  },
  backend: {
    binaryId: 'bin_live',
    get gen() { return epoch; },
  },
  get analysisArtifactVersions() { return artifactVersions; },
  async _fetchFunctionModel(address) {
    fetches++;
    assert.equal(address, 0x1000n);
    return {
      id: 'fn_1000',
      startAddress: 0x1000n,
      ir: compatibilityIr,
      cfg: compatibilityCfg,
      semanticAnalysis: { pipeline: { semanticIr, cfg: canonicalCfg } },
    };
  },
};

const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
app.analysisQueries = api; // mirrors App constructor assignment after adapter creation
assert.equal(app._fetchFunctionModel.name, 'routedFunctionModel', 'Function Workspace producer must be installed behind the query boundary');

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
assert.equal(fetches, 3, 'each public query resolves through the captured live non-UI-mutating producer');

const workspaceModel = await app._fetchFunctionModel(0x1000n);
assert.equal(workspaceModel.id, 'fn_1000');
assert.equal(fetches, 4, 'Function Workspace route must cross AnalysisQueryAPI and terminate once at the captured producer');

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
  backend: { gen: 0, binaryId: 'bin_unavailable' },
};
const unavailableApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(unavailableApp));
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

const truncatedModel = {
  id: 'fn_truncated',
  truncated: true,
  semanticAnalysis: {
    pipeline: {
      semanticIr: { nodes: [{ id: 'partial-node' }] },
      cfg: { blocks: [{ id: 'partial-block' }], edges: [] },
    },
  },
};
const truncatedApp = {
  store: { get: () => null },
  backend: { gen: 4, binaryId: 'bin_truncated' },
  async _fetchFunctionModel() { return truncatedModel; },
};
const truncatedApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(truncatedApp));
const truncatedSnapshot = await truncatedApi.snapshot();
assert.equal((await truncatedApi.function(truncatedSnapshot, '0x3000')).completeness, 'truncated');
assert.equal((await truncatedApi.semanticIR(truncatedSnapshot, '0x3000')).completeness, 'truncated');
assert.equal((await truncatedApi.cfg(truncatedSnapshot, '0x3000')).completeness, 'truncated');

const partialApp = {
  store: { get: () => null },
  backend: { gen: 5, binaryId: 'bin_partial' },
  async _fetchFunctionModel() {
    return {
      id: 'fn_partial',
      complete: false,
      semanticAnalysis: { pipeline: { semanticIr: { nodes: [] }, cfg: { blocks: [], edges: [] } } },
    };
  },
};
const partialApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(partialApp));
const partialSnapshot = await partialApi.snapshot();
assert.equal((await partialApi.function(partialSnapshot, '0x4000')).completeness, 'partial');
assert.equal((await partialApi.semanticIR(partialSnapshot, '0x4000')).completeness, 'partial');
assert.equal((await partialApi.cfg(partialSnapshot, '0x4000')).completeness, 'partial');

const derivedIdentityApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter({
  store: { get: () => null },
  backend: { gen: 2, binaryId: null },
  async ensureAnalysisIdentity() { return 'bin_derived'; },
}));
assert.equal((await derivedIdentityApi.snapshot()).binaryId, 'bin_derived');

const unboundIdentityApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter({
  store: { get: () => null },
  backend: { gen: 3, binaryId: null },
}));
await assert.rejects(
  () => unboundIdentityApi.snapshot(),
  (error) => error?.code === 'ANALYSIS_QUERY_BINARY_UNBOUND',
  'unbound binary identity must not be converted into a reusable pseudo-snapshot',
);

console.log('phase4 AnalysisQueryAPI App wiring: PASS');
