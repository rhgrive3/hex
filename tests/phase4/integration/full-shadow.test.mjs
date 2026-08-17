import assert from 'node:assert/strict';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { ArtifactAnalysisOrchestrator, createWorkerAnalysisArtifactDescriptor } from '../../../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'71'.repeat(32)}`;
const report = {
  semanticMismatchCount:0,
  provenanceMismatchCount:0,
  publicResultMismatchCount:0,
  coldWarmMismatchCount:0,
  errorClassificationMismatchCount:0,
  cancellationMismatchCount:0,
  budgetMismatchCount:0,
  publicResultTypeMismatchCount:0,
  producerInvocationCount:0,
  coalescedProducerInvocationCount:0,
  coalescedConsumerCount:100,
};

function payload(seed = 0) {
  return {
    publicResult:{
      addresses:new BigUint64Array([0x1000n + BigInt(seed), 0x1020n + BigInt(seed)]),
      kinds:new Uint8Array([1, 2]),
      bytes:new Uint8Array([0xaa, 0xbb, 0xcc]),
      big:0x1_0000_0000_0000_0001n,
    },
    semanticResult:{ schema:'shadow-semantic-v1', blocks:[{ id:0, ops:['load','add','store'] }] },
    provenance:{ originRefs:['instruction:0x1000'], producer:'existing-deterministic-producer' },
    completeness:'complete',
  };
}

function descriptor(extra = {}) {
  const { config = {}, ...rest } = extra;
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:BINARY_ID,
    sliceIndex:0,
    architecture:'arm64',
    producerVersion:'shadow-producer-v1',
    loaderVersion:'shadow-loader-v1',
    architectureSemanticVersion:'shadow-arch-v1',
    abiSemanticVersion:'shadow-abi-v1',
    semanticSchemaVersion:'shadow-schema-v1',
    config:{ fixture:'p4-7-full-shadow', ...config },
    originRefs:['instruction:0x1000'],
    ...rest,
  });
}

function runtime() {
  return new ArtifactAnalysisOrchestrator({
    store:new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'p4-7-full-shadow' }) }),
    schedulerOptions:{ maxConcurrency:4 },
  });
}

function mismatches(a, b) {
  try { assert.deepEqual(a, b); return false; } catch { return true; }
}

// Explicit old/current oracle versus explicit artifact route. No ambient default participates.
{
  let currentCalls = 0;
  let artifactProducerCalls = 0;
  const currentProducer = async () => { currentCalls++; return payload(); };
  const current = await currentProducer();
  const r = runtime();
  const d = descriptor();
  const cold = await r.request({ descriptor:d, completeness:'complete', produce:async () => { artifactProducerCalls++; return currentProducer(); } });
  const warm = await r.request({ descriptor:d, completeness:'complete', produce:async () => { artifactProducerCalls++; return currentProducer(); } });
  report.producerInvocationCount = artifactProducerCalls;
  if (mismatches(cold.payload.semanticResult, current.semanticResult)) report.semanticMismatchCount++;
  if (mismatches(cold.payload.provenance, current.provenance)) report.provenanceMismatchCount++;
  if (mismatches(cold.payload.publicResult, current.publicResult)) report.publicResultMismatchCount++;
  if (mismatches(cold.payload, warm.payload)) report.coldWarmMismatchCount++;
  const typesOk = cold.payload.publicResult.addresses instanceof BigUint64Array
    && cold.payload.publicResult.kinds instanceof Uint8Array
    && cold.payload.publicResult.bytes instanceof Uint8Array
    && typeof cold.payload.publicResult.big === 'bigint';
  if (!typesOk) report.publicResultTypeMismatchCount++;
  assert.equal(cold.reused, false);
  assert.equal(warm.reused, true);
  assert.equal(artifactProducerCalls, 1, 'warm artifact request must not reinvoke producer');
  assert.equal(currentCalls, 2, 'one explicit current plus one artifact cold producer invocation');
  await r.close();
}

// Error classification is identical: artifact orchestration propagates the existing producer error.
{
  const expected = Object.assign(new Error('shadow-worker-crash'), { code:'SHADOW_WORKER_CRASH' });
  let oldError = null, newError = null;
  try { throw expected; } catch (error) { oldError = error; }
  const r = runtime();
  try {
    await r.request({ descriptor:descriptor({ config:{ error:true } }), completeness:'complete', produce:async () => {
      throw Object.assign(new Error('shadow-worker-crash'), { code:'SHADOW_WORKER_CRASH' });
    }});
  } catch (error) { newError = error; }
  if (oldError?.message !== newError?.message || oldError?.code !== newError?.code) report.errorClassificationMismatchCount++;
  await r.close();
}

// Cancellation produces AbortError and cannot publish a late result.
{
  const r = runtime();
  const d = descriptor({ config:{ cancel:true } });
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = r.request({ descriptor:d, completeness:'complete', signal:controller.signal, produce:async ({ signal }) => {
    await gate;
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return payload(1);
  }});
  await Promise.resolve();
  controller.abort(new DOMException('shadow-cancel', 'AbortError'));
  release();
  let got = null;
  try { await pending; } catch (error) { got = error; }
  if (got?.name !== 'AbortError') report.cancellationMismatchCount++;
  assert.equal((await r.store.get(d)).status, 'miss');
  await r.close();
}

// Budget exhaustion stays fail-closed and produces no artifact.
{
  const r = runtime();
  const d = descriptor({ config:{ budget:true } });
  let got = null;
  try {
    await r.request({ descriptor:d, completeness:'complete', budget:{ workUnits:1 }, produce:async ({ budget }) => {
      budget.consume('workUnits', 2);
      return payload(2);
    }});
  } catch (error) { got = error; }
  if (got?.code !== 'budget-exhausted') report.budgetMismatchCount++;
  assert.equal((await r.store.get(d)).status, 'miss');
  await r.close();
}

// Required 100 identical missing ArtifactId requests coalesce to exactly one producer.
{
  const r = runtime();
  const d = descriptor({ config:{ coalesce100:true } });
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = Array.from({ length:100 }, () => r.request({
    descriptor:d,
    completeness:'complete',
    produce:async () => { calls++; await gate; return payload(3); },
  }));
  await Promise.resolve();
  release();
  const results = await Promise.all(requests);
  report.coalescedProducerInvocationCount = calls;
  assert.equal(results.length, 100);
  assert.equal(calls, 1);
  for (const result of results) assert.deepEqual(result.payload, results[0].payload);
  await r.close();
}

for (const [key, value] of Object.entries(report)) {
  if (key.endsWith('MismatchCount')) assert.equal(value, 0, `${key} must be zero`);
}
assert.equal(report.producerInvocationCount, 1);
assert.equal(report.coalescedProducerInvocationCount, 1);
console.log('PHASE4_FULL_SHADOW ' + JSON.stringify(report));
console.log('phase4 full shadow: PASS');
