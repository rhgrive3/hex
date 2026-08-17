import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import {
  ANALYSIS_ORCHESTRATION_ROUTE,
  ArtifactAnalysisOrchestrator,
  awaitCancellableProducer,
  createWorkerAnalysisArtifactDescriptor,
} from '../../../js/cache/artifact-orchestration.js';
import { AnalysisCache, ANALYSIS_CACHE_FALLBACK } from '../../../js/cache/analysis-cache.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BINARY_ID = `bin_sha256_${'11'.repeat(32)}`;
const BACKEND_BINARY_ID = `bin_sha256_${'33'.repeat(32)}`;
const CACHE_ARTIFACT_A = `artifact_${'aa'.repeat(16)}`;
const CACHE_ARTIFACT_B = `artifact_${'bb'.repeat(16)}`;
const report = {
  shadowComparisons:0, oldRouteRuns:0, newColdRuns:0, newWarmRuns:0,
  semanticMismatches:0, provenanceMismatches:0, shadowProducerInvocations:0,
  cancellationChecks:0, hiddenFallbacks:0, weakIdentityPromotions:0,
};

function runtime(label) {
  return new ArtifactAnalysisOrchestrator({
    store:new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:`explicit-${label}` }) }),
    schedulerOptions:{ maxConcurrency:4 },
  });
}
function descriptor(overrides = {}) {
  const { config = {}, ...rest } = overrides;
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:BINARY_ID, sliceIndex:0, architecture:'arm64',
    producerVersion:'producer-v1', loaderVersion:'loader-v1',
    architectureSemanticVersion:'arch-v1', abiSemanticVersion:'abi-v1', semanticSchemaVersion:'semantic-v1',
    config:{ fixture:'shadow', ...config }, originRefs:['instruction:0x1000'], ...rest,
  });
}
function oraclePayload() {
  return {
    publicResult:{ addrs:new BigUint64Array([0x1000n, 0x1020n]), kinds:new Uint8Array([1, 2]), functions:[4096, 4128] },
    semanticIR:{ schema:'fixture-ir-v1', blocks:[{ id:0, ops:['load', 'add', 'store'] }] },
    provenance:{ originRefs:['instruction:0x1000'], producer:'existing-worker' },
    completeness:'complete',
  };
}

// Explicit old/current oracle versus new cold/warm route.
{
  let oracleCalls = 0, newCalls = 0;
  const producer = async () => { oracleCalls++; return oraclePayload(); };
  const oldResult = await producer();
  report.oldRouteRuns++;
  const r = runtime('shadow');
  const d = descriptor();
  const cold = await r.request({ descriptor:d, completeness:'complete', produce:async () => { newCalls++; return producer(); } });
  report.shadowComparisons++; report.newColdRuns++;
  assert.equal(cold.reused, false);
  assert.deepEqual(cold.payload.publicResult, oldResult.publicResult);
  assert.deepEqual(cold.payload.semanticIR, oldResult.semanticIR);
  assert.deepEqual(cold.payload.provenance, oldResult.provenance);
  assert.equal(cold.payload.completeness, oldResult.completeness);
  assert.equal(cold.record.completeness, oldResult.completeness);
  const warm = await r.request({ descriptor:d, completeness:'complete', produce:async () => { newCalls++; return producer(); } });
  report.newWarmRuns++;
  assert.equal(warm.reused, true);
  assert.deepEqual(warm.payload, oldResult);
  assert.equal(newCalls, 1, 'warm new route must prove actual reuse');
  report.shadowProducerInvocations += newCalls;
  await r.close();
}

// Weak old identity cannot become the canonical ArtifactId input; version changes miss.
{
  assert.throws(() => createWorkerAnalysisArtifactDescriptor({
    binaryId:'fnv1a64:10:0123456789abcdef', sliceIndex:0, architecture:'arm64',
    producerVersion:'1', loaderVersion:'1', architectureSemanticVersion:'1', abiSemanticVersion:'1', semanticSchemaVersion:'1',
  }), /canonical-binary-id-invalid/);
  const r = runtime('version');
  let calls = 0;
  const v1 = descriptor({ config:{ fixture:'version' } });
  const v2 = descriptor({ producerVersion:'producer-v2', config:{ fixture:'version' } });
  assert.notEqual(v1.artifactId, v2.artifactId);
  assert.match(v1.sliceId, /^slice_[0-9a-f]{32}$/);
  assert.match(v1.entityId, /^entity_[0-9a-f]{32}$/);
  await r.request({ descriptor:v1, produce:async () => { calls++; return oraclePayload(); } });
  await r.request({ descriptor:v2, produce:async () => { calls++; return oraclePayload(); } });
  assert.equal(calls, 2);
  await r.close();
}

// Parallel equivalent requests coalesce to one producer.
{
  const r = runtime('coalesce');
  const d = descriptor({ config:{ fixture:'coalesce' } });
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = Array.from({ length:32 }, () => r.request({ descriptor:d, produce:async () => { calls++; await gate; return oraclePayload(); } }));
  await Promise.resolve(); release();
  assert.equal((await Promise.all(requests)).length, 32);
  assert.equal(calls, 1);
  assert.ok(r.stats().scheduler.coalescedRequests >= 31);
  await r.close();
}

// Cancellation reaches the existing worker once and late completion cannot publish.
{
  const r = runtime('cancel');
  const d = descriptor({ config:{ fixture:'cancel' } });
  const controller = new AbortController();
  let workerCancels = 0, resolveLate, markProducerStarted;
  const operation = new Promise((resolve) => { resolveLate = resolve; });
  const producerStarted = new Promise((resolve) => { markProducerStarted = resolve; });
  operation.cancel = () => { workerCancels++; };
  const pending = r.request({
    descriptor:d,
    signal:controller.signal,
    produce:({ signal }) => {
      markProducerStarted();
      return awaitCancellableProducer(operation, signal);
    },
  });
  await producerStarted;
  controller.abort(new DOMException('cancel-test', 'AbortError'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  resolveLate(oraclePayload()); await Promise.resolve();
  assert.equal(workerCancels, 1);
  assert.equal((await r.store.get(d)).status, 'miss');
  report.cancellationChecks++;
  await r.close();
}

// Budget exhaustion and worker crash leave no artifact residue.
{
  const r = runtime('failures');
  const budgetD = descriptor({ config:{ fixture:'budget' } });
  await assert.rejects(r.request({ descriptor:budgetD, budget:{ workUnits:1 }, produce:async ({ budget }) => {
    budget.consume('workUnits', 2); return oraclePayload();
  }}), (error) => error?.code === 'budget-exhausted');
  assert.equal((await r.store.get(budgetD)).status, 'miss');
  const crashD = descriptor({ config:{ fixture:'crash' } });
  await assert.rejects(r.request({ descriptor:crashD, produce:async () => { throw new Error('worker-crash'); } }), /worker-crash/);
  assert.equal((await r.store.get(crashD)).status, 'miss');
  await r.close();
}

// New route persistence is strict and never silently falls back to memory/current.
{
  assert.throws(() => new ArtifactAnalysisOrchestrator({ storeOptions:{ indexedDB:null } }), (e) => e?.code === 'artifact-persistence-unsupported');
  assert.throws(() => new ArtifactAnalysisOrchestrator({ storeOptions:{ indexedDB:null, allowMemoryFallback:true } }), /explicit-store/);
}

// Legacy cache remains an oracle, but canonical compatibility is strictly subordinate to ArtifactId.
{
  const cache = new AnalysisCache({ indexedDB:null, memory:new Map(), analyzerVersion:'legacy-v1' });
  await cache.put('binary-hash', { analysisSummaries:{ route:'legacy' } });
  assert.deepEqual(await cache.get('binary-hash'), { analysisSummaries:{ route:'legacy' } });
  assert.throws(() => cache.canonicalKey('artifact-A'), /not-canonical/);
  assert.equal(await cache.get('binary-hash', { artifactId:CACHE_ARTIFACT_A }), null);
  await cache.put('binary-hash', { analysisSummaries:{ route:'canonical' } }, { artifactId:CACHE_ARTIFACT_A });
  assert.deepEqual(await cache.get('binary-hash', { artifactId:CACHE_ARTIFACT_A }), { analysisSummaries:{ route:'canonical' } });
  assert.equal(await cache.get('binary-hash', { artifactId:CACHE_ARTIFACT_B }), null);
  assert.notEqual(cache.legacyKey('binary-hash'), cache.canonicalKey(CACHE_ARTIFACT_A));
  const strict = new AnalysisCache({ indexedDB:null, fallbackMode:ANALYSIS_CACHE_FALLBACK.ERROR });
  await assert.rejects(() => strict.get('binary-hash'), /IndexedDB unavailable/);
}

// Determinism across independent cold stores.
{
  const d1 = descriptor({ config:{ fixture:'determinism' } });
  const d2 = descriptor({ config:{ fixture:'determinism' } });
  assert.equal(d1.artifactId, d2.artifactId);
  const a = runtime('det-a'), b = runtime('det-b');
  const r1 = await a.request({ descriptor:d1, produce:async () => oraclePayload() });
  const r2 = await b.request({ descriptor:d2, produce:async () => oraclePayload() });
  assert.deepEqual(r1.payload, r2.payload);
  assert.equal(r1.record.payloadChecksum, r2.record.payloadChecksum);
  await a.close(); await b.close();
}

// Real Backend route: production default remains current pre-cutover, while the
// CI rehearsal may deliberately force the ambient configured route to artifact.
{
  const originalWorker = globalThis.Worker;
  const metrics = { analyze:0, hash:0, cancel:0 };
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(message) {
      if (message.t === 'cancel') { metrics.cancel++; return; }
      if (message.t === 'hash') { metrics.hash++; return; }
      if (message.t !== 'analyze') return;
      metrics.analyze++;
      if (message.sliceIndex === 98 || message.sliceIndex === 99) return;
      const result = message.sliceIndex === 77 ? null : oraclePayload();
      queueMicrotask(() => this.onmessage?.({ data:result
        ? { t:'ok', id:message.id, epoch:message.epoch, result }
        : { t:'err', id:message.id, epoch:message.epoch, error:'worker-crash' } }));
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
  try {
    const { Backend, BACKEND_DEFAULT_ANALYSIS_ROUTE } = await import(`../../../js/backend.js?migration-test=${Date.now()}`);
    const r = runtime('backend');
    const backend = new Backend({ artifactOrchestrator:r });
    backend.formatId = 'elf';
    backend.platformInfo = { capability:{ architecture:'arm64' }, slices:[{ capability:{ architecture:'arm64' } }] };
    const info = backend.analysisRouteInfo();
    const expectedConfiguredRoute = process.env.HEX_ANALYSIS_ROUTE === ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT
      ? ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT
      : BACKEND_DEFAULT_ANALYSIS_ROUTE;
    assert.equal(BACKEND_DEFAULT_ANALYSIS_ROUTE, ANALYSIS_ORCHESTRATION_ROUTE.CURRENT);
    assert.equal(info.route, expectedConfiguredRoute);
    assert.equal(info.defaultCutover, false);
    assert.equal(info.canonicalIdentityRequired, true); assert.equal(info.completenessRequired, true);

    const oldResult = await backend.analyze(0, { route:'current' }); report.oldRouteRuns++;
    await assert.rejects(backend.analyze(0, { route:'artifact', completeness:'complete' }), /canonical-binary-id-required/);
    assert.equal(metrics.analyze, 1); assert.equal(metrics.hash, 0);

    const opts = { route:'artifact', binaryId:BACKEND_BINARY_ID, completeness:'complete' };
    const cold = await backend.analyze(0, opts); const warm = await backend.analyze(0, opts);
    report.shadowComparisons++; report.newColdRuns++; report.newWarmRuns++; report.shadowProducerInvocations++;
    assert.deepEqual(cold, oldResult); assert.deepEqual(warm, oldResult);
    assert.equal(metrics.analyze, 2); assert.equal(metrics.hash, 0);

    let oldError, newError;
    try { await backend.analyze(77, { route:'current' }); } catch (e) { oldError = e; }
    try { await backend.analyze(77, { ...opts, config:{ errorCase:true } }); } catch (e) { newError = e; }
    assert.equal(oldError?.message, 'worker-crash'); assert.equal(newError?.message, 'worker-crash');

    const oldController = new AbortController();
    const oldCancelBefore = metrics.cancel;
    const oldCancelling = backend.analyze(98, { route:'current', signal:oldController.signal });
    for (let i=0;i<10 && metrics.analyze<5;i++) await Promise.resolve();
    oldController.abort(new DOMException('current-cancel', 'AbortError'));
    await assert.rejects(oldCancelling, (e) => e?.name === 'AbortError');
    assert.equal(metrics.cancel, oldCancelBefore + 1, 'current oracle must cancel its worker exactly once');
    report.cancellationChecks++;

    const controller = new AbortController();
    const artifactCancelBefore = metrics.cancel;
    const cancelling = backend.analyze(99, { ...opts, signal:controller.signal, config:{ cancelCase:true } });
    for (let i=0;i<10 && metrics.analyze<6;i++) await Promise.resolve();
    controller.abort(new DOMException('artifact-cancel', 'AbortError'));
    await assert.rejects(cancelling, (e) => e?.name === 'AbortError');
    assert.equal(metrics.cancel, artifactCancelBefore + 1, 'artifact route must drive the same worker cancel exactly once');
    report.cancellationChecks++;
    backend.dispose();
  } finally { globalThis.Worker = originalWorker; }
}

// No "try new; catch current" escape hatch exists in the artifact path.
{
  const source = fs.readFileSync(path.join(root, 'js/backend.js'), 'utf8');
  const start = source.indexOf('async _analyzeArtifact');
  const end = source.indexOf('\n  guessFunctions', start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(route, /catch[\s\S]*_analyzeCurrent/);
  assert.match(route, /produce:\(\{ signal \}\) => this\._analyzeCurrent/);
}

console.log('phase4 migration orchestration: PASS');
console.log('P4-5-METRICS ' + JSON.stringify(report));
