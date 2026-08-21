import assert from 'node:assert/strict';
import {
  AnalysisQueryAPI,
  AnalysisSnapshotStaleError,
  createAppAnalysisQueryAdapter,
} from '../../../js/analysis/query/index.js';

let epoch = 7;
let revision = 3;
let producerCalls = 0;
const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, revision: 2 };
const otherRegion = { id: 'other', vmAddr: 0x2000n, size: 0x100n };
const semanticIr = Object.freeze({ schemaVersion: 'semantic-ir/v2', nodes: [{ id: 'n1' }] });
const canonicalCfg = Object.freeze({ schemaVersion: 'cfg/v2', blocks: [{ id: 'b0' }], edges: [] });
const result = {
  model: {
    semanticAnalysis: { pipeline: { semanticIr, cfg: canonicalCfg } },
    semanticIR: { schemaVersion: 'legacy-ir/v1' },
    cfg: { blocks: [{ id: 'legacy' }] },
  },
  completeness: { complete: true, reason: null, regionId: region.id },
  truncated: false,
};

const state = new Map([
  ['fileInfo', { hash: 'file-hash-that-must-not-win' }],
  ['architecture', 'arm64'],
  ['capability', { architecture: 'arm64', semanticVersion: 'arm64-semantic/test' }],
  ['canDisassemble', true],
  ['instructionAlignment', 4],
  ['sliceIndex', 0],
  ['currentRegion', otherRegion],
]);
const app = {
  store: { get: (key) => state.get(key) ?? null },
  backend: {
    binaryId: 'bin_live',
    get gen() { return epoch; },
    analysisRoute: 'artifact',
    analysisRouteInfo: () => ({ route: 'artifact' }),
  },
  workspace: { get bindingRevision() { return revision; }, project: null },
  symbols: { functionCount: 1, gen: 11 },
  validatedFunctionRange(address) {
    assert.equal(address, 0x1000n);
    return { ok: true, start: 0x1000n, end: 0x1040n, region, complete: true, provenance: 'test-range' };
  },
  executableRegionFor: () => region,
  async analysisFunctionProducer(address) {
    producerCalls++;
    assert.equal(address, 0x1000n);
    return result;
  },
  async analyzeFunctionAt() {
    throw new Error('legacy UI-mutating producer must be replaced');
  },
};

const adapter = createAppAnalysisQueryAdapter(app);
const api = new AnalysisQueryAPI(adapter);
app.analysisQueries = api;
assert.equal(app.analyzeFunctionAt.name, 'routedAnalyzeFunctionAt');

const snapshot = await api.snapshot();
assert.equal(snapshot.binaryId, 'bin_live');
assert.equal(snapshot.projectRevision, revision);
assert.equal(snapshot.analysisEpoch, epoch);
assert.equal(snapshot.artifactVersions.queryProducer, 'analysis-query-function-producer/v2');
assert.equal(snapshot.artifactVersions.analysisRoute, 'artifact');
assert.equal(snapshot.artifactVersions.symbolsGeneration, '11');

const direct = await api.function(snapshot, 0x1000n);
assert.equal(direct.completeness, 'complete');
assert.equal(direct.value, result);
assert.equal(app.semantic, undefined, 'query producer must remain UI-nonmutating');

const ir = await api.semanticIR(snapshot, 0x1000n);
assert.equal(ir.value, semanticIr, 'canonical Semantic IR must beat compatibility projections');
const cfg = await api.cfg(snapshot, 0x1000n);
assert.equal(cfg.value, canonicalCfg, 'canonical CFG must beat compatibility projections');

const workspaceResult = await app.analyzeFunctionAt(0x1000n);
assert.equal(workspaceResult, result);
assert.equal(app.semantic?.model, result.model, 'legacy Function Workspace entry point must publish only after QueryAPI validation');
assert.equal(producerCalls, 4, 'each public read must terminate once at the non-mutating producer');

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

const tampered = JSON.parse(JSON.stringify(snapshot));
tampered.projectRevision++;
await assert.rejects(() => api.function(tampered, 0x1000n), /analysis-snapshot-identity-mismatch/);

const partialApp = {
  store: { get: (key) => key === 'fileInfo' ? { hash: 'partial-bin' } : key === 'sliceIndex' ? 0 : null },
  backend: { binaryId: 'partial-bin', gen: 0, analysisRoute: 'artifact' },
  symbols: { gen: 0 },
  analysisFunctionProducer: async () => ({ model: {}, completeness: { complete: false, reason: 'budget' } }),
  analyzeFunctionAt: async () => null,
};
const partialApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(partialApp));
partialApp.analysisQueries = partialApi;
const partialSnapshot = await partialApi.snapshot();
assert.equal((await partialApi.function(partialSnapshot, 0x10n)).completeness, 'partial');

const unavailableApp = {
  store: { get: (key) => key === 'fileInfo' ? { hash: 'bin_unavailable' } : key === 'sliceIndex' ? 0 : null },
  backend: { gen: 0, binaryId: 'bin_unavailable', analysisRoute: 'artifact' },
  symbols: { gen: 0, functionCount: 0 },
  analyzeFunctionAt: async () => null,
};
const unavailableApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(unavailableApp));
unavailableApp.analysisQueries = unavailableApi;
const unavailableSnapshot = await unavailableApi.snapshot();
for (const query of [
  () => unavailableApi.function(unavailableSnapshot, 0x20n),
  () => unavailableApi.semanticIR(unavailableSnapshot, 0x20n),
  () => unavailableApi.cfg(unavailableSnapshot, 0x20n),
]) {
  const value = await query();
  assert.equal(value.completeness, 'unsupported');
  assert.equal(value.value, null, 'missing producers must not fabricate empty complete results');
}

assert.throws(() => createAppAnalysisQueryAdapter({
  store: { get: () => null }, backend: { binaryId: 'x', gen: 0 }, symbols: { gen: 0 },
  analysisFunctionProducer: async () => null, analyzeFunctionAt: async () => null,
}).functionById(null, true), /analysis-query-function-address-invalid/);

console.log('phase4 AnalysisQueryAPI live product wiring: PASS');
