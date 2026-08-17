import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ArtifactStore,
  MemoryArtifactBackend,
} from '../../../js/core/artifacts/index.js';
import {
  ANALYSIS_ORCHESTRATION_ROUTE,
  ArtifactAnalysisOrchestrator,
  awaitCancellableProducer,
  createWorkerAnalysisArtifactDescriptor,
} from '../../../js/cache/artifact-orchestration.js';
import {
  AnalysisCache,
  ANALYSIS_CACHE_FALLBACK,
} from '../../../js/cache/analysis-cache.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const report = {
  shadowComparisons:0,
  oldRouteRuns:0,
  newColdRuns:0,
  newWarmRuns:0,
  semanticMismatches:0,
  provenanceMismatches:0,
  producerInvocations:0,
  cancellationChecks:0,
  hiddenFallbacks:0,
};

function memoryRuntime(label = 'migration-test') {
  const backend = new MemoryArtifactBackend({ reason:`explicit-${label}` });
  const store = new ArtifactStore({ backend });
  return new ArtifactAnalysisOrchestrator({ store, schedulerOptions:{ maxConcurrency:4 } });
}

function descriptor(overrides = {}) {
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:'binary:test',
    sliceId:'0',
    entityId:'analysis:0',
    producerVersion:'producer-v1',
    loaderVersion:'loader-v1',
    architectureSemanticVersion:'arch-v1',
    abiSemanticVersion:'abi-v1',
    semanticSchemaVersion:'semantic-v1',
    config:{ fixture:'shadow', ...(overrides.config || {}) },
    originRefs:['instruction:0x1000'],
    ...overrides,
  });
}

const oraclePayload = Object.freeze({
  publicResult:{ functions:[4096, 4128], summary:'same deterministic analysis result' },
  semanticIR:{ schema:'fixture-ir-v1', blocks:[{ id:0, ops:['load', 'add', 'store'] }] },
  provenance:{ originRefs:['instruction:0x1000'], producer:'existing-worker' },
  completeness:'complete',
});

// Exact old/current vs new ArtifactStore/scheduler comparison. The producer is
// the same function; the migration infrastructure does not duplicate semantics.
{
  let oldInvocations = 0;
  const existingProducer = async () => { oldInvocations++; return oraclePayload; };
  const oldResult = await existingProducer();
  report.oldRouteRuns++;

  const runtime = memoryRuntime('shadow');
  let newInvocations = 0;
  const d = descriptor();
  const cold = await runtime.request({
    descriptor:d,
    produce:async () => { newInvocations++; return existingProducer(); },
    completeness:oldResult.completeness,
  });
  report.shadowComparisons++;
  report.newColdRuns++;
  report.producerInvocations += newInvocations;
  assert.equal(cold.reused, false);
  assert.deepEqual(cold.payload, oldResult);
  assert.deepEqual(cold.payload.semanticIR, oldResult.semanticIR);
  assert.deepEqual(cold.payload.provenance, oldResult.provenance);
  assert.equal(cold.record.completeness, oldResult.completeness);
  assert.deepEqual(cold.record.originRefs, ['instruction:0x1000']);
  assert.equal(newInvocations, 1, 'cold new route must invoke the existing producer exactly once');

  const warm = await runtime.request({
    descriptor:d,
    produce:async () => { newInvocations++; return existingProducer(); },
    completeness:oldResult.completeness,
  });
  report.newWarmRuns++;
  assert.equal(warm.reused, true);
  assert.deepEqual(warm.payload, oldResult);
  assert.equal(newInvocations, 1, 'warm route must reuse the artifact instead of recomputing');
  assert.equal(runtime.stats().warmReuses, 1);
  assert.equal(runtime.stats().coldPublishes, 1);
  await runtime.close();
}

// Version invalidation is canonical ArtifactId invalidation, not a weak cache key.
{
  const runtime = memoryRuntime('version');
  let calls = 0;
  const v1 = descriptor({ config:{ fixture:'version' } });
  const v2 = descriptor({ producerVersion:'producer-v2', config:{ fixture:'version' } });
  assert.notEqual(v1.artifactId, v2.artifactId);
  await runtime.request({ descriptor:v1, produce:async () => { calls++; return oraclePayload; } });
  await runtime.request({ descriptor:v2, produce:async () => { calls++; return oraclePayload; } });
  assert.equal(calls, 2, 'producer version change must miss and recompute');
  await runtime.close();
}

// Parallel equivalent requests coalesce onto one scheduler producer execution.
{
  const runtime = memoryRuntime('coalescing');
  const d = descriptor({ config:{ fixture:'coalescing' } });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const produce = async () => { calls++; await gate; return oraclePayload; };
  const requests = Array.from({ length:32 }, () => runtime.request({ descriptor:d, produce }));
  await Promise.resolve();
  release();
  const results = await Promise.all(requests);
  assert.equal(calls, 1, 'parallel requests must not duplicate producer execution');
  assert.equal(results.length, 32);
  assert.ok(runtime.stats().scheduler.coalescedRequests >= 31);
  await runtime.close();
}

// Scheduler cancellation drives exactly one existing-worker cancel and leaves
// no publishable artifact behind. A late zombie completion is ignored.
{
  const runtime = memoryRuntime('cancel');
  const d = descriptor({ config:{ fixture:'cancel' } });
  const controller = new AbortController();
  let workerCancels = 0;
  let lateResolve;
  const workerOperation = new Promise((resolve) => { lateResolve = resolve; });
  workerOperation.cancel = () => { workerCancels++; };
  const pending = runtime.request({
    descriptor:d,
    signal:controller.signal,
    produce:({ signal }) => awaitCancellableProducer(workerOperation, signal),
  });
  controller.abort(new DOMException('cancel-test', 'AbortError'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  lateResolve(oraclePayload);
  await Promise.resolve();
  assert.equal(workerCancels, 1, 'scheduler cancellation must issue one worker cancellation');
  assert.equal((await runtime.store.get(d)).status, 'miss', 'cancelled worker must not publish an artifact');
  report.cancellationChecks++;
  await runtime.close();
}

// Budget exhaustion is surfaced; it is not converted into a cache hit or old route.
{
  const runtime = memoryRuntime('budget');
  const d = descriptor({ config:{ fixture:'budget' } });
  let calls = 0;
  await assert.rejects(
    runtime.request({
      descriptor:d,
      budget:{ workUnits:1 },
      produce:async ({ budget }) => { calls++; budget.consume('workUnits', 2); return oraclePayload; },
    }),
    (error) => error?.code === 'budget-exhausted',
  );
  assert.equal(calls, 1);
  assert.equal((await runtime.store.get(d)).status, 'miss');
  assert.equal(runtime.stats().budgetExhaustions, 1);
  await runtime.close();
}

// Worker crashes/errors propagate unchanged and do not create residue.
{
  const runtime = memoryRuntime('crash');
  const d = descriptor({ config:{ fixture:'crash' } });
  await assert.rejects(
    runtime.request({ descriptor:d, produce:async () => { throw new Error('worker-crash'); } }),
    /worker-crash/,
  );
  assert.equal((await runtime.store.get(d)).status, 'miss');
  await runtime.close();
}

// Persistent backend unavailability is explicit. No implicit memory fallback is
// permitted in the new migration runtime.
{
  assert.throws(
    () => new ArtifactAnalysisOrchestrator({ storeOptions:{ indexedDB:null } }),
    (error) => error?.code === 'artifact-persistence-unsupported',
  );
  assert.throws(
    () => new ArtifactAnalysisOrchestrator({ storeOptions:{ indexedDB:null, allowMemoryFallback:true } }),
    /explicit-store/,
  );
}

// Legacy cache audit: a canonical compatibility lookup never falls back to the
// old schema/analyzer/settings/hash key. Canonical misses remain misses.
{
  const entries = new Map();
  const cache = new AnalysisCache({ indexedDB:null, memory:entries, analyzerVersion:'legacy-v1' });
  await cache.put('binary-hash', { analysisSummaries:{ route:'legacy' } });
  assert.deepEqual(await cache.get('binary-hash'), { analysisSummaries:{ route:'legacy' } });
  assert.equal(await cache.get('binary-hash', { artifactId:'artifact-A' }), null, 'canonical miss must not consult weak legacy key');
  await cache.put('binary-hash', { analysisSummaries:{ route:'canonical' } }, { artifactId:'artifact-A' });
  assert.deepEqual(await cache.get('binary-hash', { artifactId:'artifact-A' }), { analysisSummaries:{ route:'canonical' } });
  assert.equal(await cache.get('binary-hash', { artifactId:'artifact-B' }), null);
  assert.notEqual(cache.legacyKey('binary-hash'), cache.canonicalKey('artifact-A'));

  const strict = new AnalysisCache({ indexedDB:null, fallbackMode:ANALYSIS_CACHE_FALLBACK.ERROR });
  await assert.rejects(() => strict.get('binary-hash'), /IndexedDB unavailable/);
}

// Determinism: same canonical descriptor + same existing producer => same ID,
// payload and checksum across independent cold stores.
{
  const d1 = descriptor({ config:{ fixture:'determinism' } });
  const d2 = descriptor({ config:{ fixture:'determinism' } });
  assert.equal(d1.artifactId, d2.artifactId);
  const a = memoryRuntime('determinism-a');
  const b = memoryRuntime('determinism-b');
  const r1 = await a.request({ descriptor:d1, produce:async () => oraclePayload });
  const r2 = await b.request({ descriptor:d2, produce:async () => oraclePayload });
  assert.deepEqual(r1.payload, r2.payload);
  assert.equal(r1.record.payloadChecksum, r2.record.payloadChecksum);
  await a.close();
  await b.close();
}

// Real Backend route integration uses explicit current/artifact routes while
// keeping current as the default. Fake Worker exercises actual Backend._callTo.
{
  const originalWorker = globalThis.Worker;
  const workers = [];
  const workerMetrics = { analyze:0, hash:0, cancel:0 };

  class FakeWorker {
    constructor(url) { this.url = String(url); this.onmessage = null; this.onerror = null; workers.push(this); }
    postMessage(message) {
      if (message.t === 'cancel') { workerMetrics.cancel++; return; }
      if (message.t === 'hash') {
        workerMetrics.hash++;
        queueMicrotask(() => this.onmessage?.({ data:{ t:'ok', id:message.id, epoch:message.epoch, result:{ hash:'backend-binary-hash' } } }));
        return;
      }
      if (message.t === 'analyze') {
        workerMetrics.analyze++;
        if (message.sliceIndex === 99) return;
        const result = message.sliceIndex === 77
          ? null
          : oraclePayload;
        queueMicrotask(() => this.onmessage?.({ data:result
          ? { t:'ok', id:message.id, epoch:message.epoch, result }
          : { t:'err', id:message.id, epoch:message.epoch, error:'worker-crash' } }));
      }
    }
    terminate() {}
  }

  globalThis.Worker = FakeWorker;
  try {
    const { Backend } = await import(`../../../js/backend.js?migration-test=${Date.now()}`);
    const runtime = memoryRuntime('backend');
    const backend = new Backend({ artifactOrchestrator:runtime });
    backend.formatId = 'elf';
    backend.platformInfo = { capability:{ architecture:'arm64' }, slices:[{ capability:{ architecture:'arm64' } }] };

    assert.deepEqual(backend.analysisRouteInfo(), {
      route:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT,
      defaultCutover:false,
      artifactRuntimeCreated:true,
      artifactRuntime:runtime.stats(),
    });

    const oldResult = await backend.analyze(0, { route:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT });
    const cold = await backend.analyze(0, { route:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT });
    const warm = await backend.analyze(0, { route:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT });
    assert.deepEqual(cold, oldResult);
    assert.deepEqual(warm, oldResult);
    assert.equal(workerMetrics.analyze, 2, 'old + new cold only; new warm must not run worker producer');

    let oldError;
    let newError;
    try { await backend.analyze(77, { route:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT }); } catch (error) { oldError = error; }
    try { await backend.analyze(77, { route:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT, config:{ errorCase:true } }); } catch (error) { newError = error; }
    assert.equal(oldError?.message, 'worker-crash');
    assert.equal(newError?.message, 'worker-crash');

    const cancelController = new AbortController();
    const cancelling = backend.analyze(99, { route:ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT, signal:cancelController.signal, config:{ cancelCase:true } });
    await Promise.resolve();
    cancelController.abort(new DOMException('backend-cancel', 'AbortError'));
    await assert.rejects(cancelling, (error) => error?.name === 'AbortError');
    assert.ok(workerMetrics.cancel >= 1, 'backend scheduler cancellation must reach the worker');

    backend.dispose();
  } finally {
    globalThis.Worker = originalWorker;
  }
}

// Source-level no-hidden-fallback guard. The artifact route must not use a
// "try new; catch current" compatibility escape hatch.
{
  const source = fs.readFileSync(path.join(root, 'js/backend.js'), 'utf8');
  const start = source.indexOf('async _analyzeArtifact');
  const end = source.indexOf('\n  guessFunctions', start);
  const artifactRoute = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(artifactRoute, /catch[\s\S]*_analyzeCurrent/);
  assert.match(artifactRoute, /produce:\(\{ signal \}\) => this\._analyzeCurrent/);
  report.hiddenFallbacks = 0;
}

console.log('phase4 migration orchestration: PASS');
console.log('P4-5-METRICS ' + JSON.stringify(report));
