import assert from 'node:assert/strict';
import { ArtifactStore, MemoryArtifactBackend, createArtifactDescriptor } from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';
import { ByteSource } from '../../../js/binary/source.js';
import { CachedByteSource, InstrumentedByteSource } from '../../../js/bytesource/cached.js';
import { createArtifactRef } from '../../../js/project/artifact-index.js';
import { createHexProject, parseHexProject, serializeHexProject } from '../../../js/project/index.js';

const report = {
  underInvalidationFailures:0,
  overInvalidationFailures:0,
  staleHitFailures:0,
  cancelledArtifactPublishFailures:0,
  zombiePublishFailures:0,
  coalescingProducerInvocationCount:0,
  wholeFileMaterializationViolations:0,
  boundedPagingStateFailures:0,
  projectUserFactLossFailures:0,
};

function descriptor(overrides = {}) {
  const versions = {
    loader:'loader-v1', architectureSemantic:'arch-v1', abiSemantic:'abi-v1', semanticSchema:'schema-v1',
    ...(overrides.versions || {}),
  };
  return createArtifactDescriptor({
    binaryId:'binary:p4-7-exit', sliceId:'slice:arm64', entityId:'function:0x1000',
    artifactKind:'semantic-ir', producerId:'exit-producer', producerVersion:'1',
    versions, config:{ mode:'strict', threshold:7 }, keyExtras:{ feature:'baseline' },
    upstreamArtifactIds:[], originRefs:['origin:baseline'], ...overrides, versions,
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortError = (message) => { const error = new Error(message); error.name='AbortError'; return error; };

// Exact invalidation dimensions: every semantic/key mutation must miss; pure
// provenance ordering/content must not over-invalidate.
{
  const baseline = descriptor({ originRefs:['origin:a','origin:b'] });
  const mutations = [
    { binaryId:'binary:changed' }, { sliceId:'slice:changed' }, { entityId:'function:changed' },
    { producerId:'producer:changed' }, { producerVersion:'2' },
    { versions:{ loader:'loader-v2' } }, { versions:{ architectureSemantic:'arch-v2' } },
    { versions:{ abiSemantic:'abi-v2' } }, { versions:{ semanticSchema:'schema-v2' } },
    { config:{ mode:'strict', threshold:8 } }, { keyExtras:{ feature:'changed' } },
    { upstreamArtifactIds:['artifact_upstream_changed'] },
  ];
  report.underInvalidationFailures = mutations.filter((mutation) => descriptor(mutation).artifactId === baseline.artifactId).length;
  const provenanceOnly = [
    descriptor({ originRefs:['origin:b','origin:a'] }),
    descriptor({ originRefs:['origin:unrelated'] }),
  ];
  report.overInvalidationFailures = provenanceOnly.filter((candidate) => candidate.artifactId !== baseline.artifactId).length;
}

// A derived artifact whose declared upstream vanished may never be returned as a stale hit.
{
  const backend = new MemoryArtifactBackend();
  const store = new ArtifactStore({ backend });
  const upstream = descriptor({ entityId:'exit:upstream' });
  const dependent = descriptor({ entityId:'exit:dependent', upstreamArtifactIds:[upstream.artifactId] });
  await store.publish(upstream, { value:'upstream' });
  await store.publish(dependent, { value:'dependent' });
  await backend.delete(upstream.artifactId);
  store.evictHot(dependent.artifactId);
  const got = await store.get(dependent);
  if (got.status !== 'miss' || got.reason !== 'missing-upstream') report.staleHitFailures++;
}

// Cancellation after durable backend commit must cause exact rollback, not a
// partially published/cancelled artifact.
{
  let committedResolve;
  const committed = new Promise((resolve) => { committedResolve = resolve; });
  class RacingBackend extends MemoryArtifactBackend {
    async putAtomic(record, payload, options = {}) {
      const result = await super.putAtomic(record, payload, options);
      committedResolve();
      await sleep(20);
      return result;
    }
  }
  const backend = new RacingBackend();
  const store = new ArtifactStore({ backend });
  const d = descriptor({ entityId:'exit:cancel-publish' });
  const controller = new AbortController();
  const publishing = store.publish(d, { value:'must-not-survive' }, { signal:controller.signal });
  await committed;
  controller.abort(abortError('cancel-after-commit'));
  let rejected = false;
  try { await publishing; } catch (error) { rejected = error?.name === 'AbortError'; }
  if (!rejected || await backend.has(d.artifactId)) report.cancelledArtifactPublishFailures++;
}

// A producer that resolves after cancellation cannot zombie-publish.
{
  const backend = new MemoryArtifactBackend();
  const store = new ArtifactStore({ backend });
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor({ entityId:'exit:zombie' });
  const controller = new AbortController();
  let release, startedResolve;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const pending = scheduler.request({
    descriptor:d,
    signal:controller.signal,
    produce:async () => { startedResolve(); await gate; return { late:true }; },
  });
  const settlement = pending.then(
    (value) => ({ status:'fulfilled', value }),
    (error) => ({ status:'rejected', error }),
  );
  await started;
  controller.abort(abortError('cancel-running-producer'));
  release();
  const result = await settlement;
  await Promise.resolve();
  const residue = await store.get(d);
  if (result.status !== 'rejected' || result.error?.name !== 'AbortError' || residue.status !== 'miss') report.zombiePublishFailures++;
}

// 100 identical missing ArtifactIds must invoke exactly one producer.
{
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:4 });
  const d = descriptor({ entityId:'exit:coalescing-100' });
  let calls = 0, release, startedResolve;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const requests = Array.from({ length:100 }, () => scheduler.request({
    descriptor:d,
    produce:async () => { calls++; startedResolve(); await gate; return { stable:true }; },
  }));
  await started;
  release();
  const results = await Promise.all(requests);
  assert.equal(results.length, 100);
  report.coalescingProducerInvocationCount = calls;
}

class SparseSource extends ByteSource {
  constructor(size) { super(size, { maxReadLength:1024 * 1024 }); }
  async read(offset, length) {
    const range = this.validateRange(offset, length);
    const bytes = new Uint8Array(range.length);
    for (let i=0;i<bytes.length;i++) bytes[i] = Number((range.offset + BigInt(i)) % 251n);
    return bytes;
  }
}

// One bounded region of a huge source must stay paged and bounded.
{
  const logicalSize = 1n << 30n;
  const pageSize = 4096;
  const maxCachedBytes = pageSize * 4;
  const instrumented = new InstrumentedByteSource(new SparseSource(logicalSize));
  const cached = new CachedByteSource(instrumented, { pageSize, maxCachedBytes });
  await cached.readExactly(128n * 1024n * 1024n + 17n, 33);
  await cached.readExactly(128n * 1024n * 1024n + 4090n, 40);
  await cached.readExactly(logicalSize - 257n, 257);
  const metrics = instrumented.metrics();
  const memory = cached.memoryStats();
  if (metrics.largestSingleRead >= Number(logicalSize) || BigInt(metrics.totalRequested) >= logicalSize) report.wholeFileMaterializationViolations++;
  if (memory.bytesCached > maxCachedBytes || memory.chunksCached > 4 || metrics.largestSingleRead > pageSize) report.boundedPagingStateFailures++;
}

// Deleting derived cache state must not delete or mutate portable user facts.
{
  const backend = new MemoryArtifactBackend();
  const store = new ArtifactStore({ backend });
  const d = descriptor({ entityId:'exit:project-derived' });
  await store.publish(d, { derivedGraph:{ blocks:[1,2,3] } });
  const ref = createArtifactRef({ scope:'function:0x1000', kind:'semantic-ir', artifactId:d.artifactId });
  const project = createHexProject({
    binaryHash:'binary:p4-7-exit',
    userNames:[{ address:'0x1000', name:'user_fact_name' }],
    comments:[{ address:'0x1000', text:'user fact comment' }],
    bookmarks:[{ address:'0x1000', label:'user fact bookmark' }],
    cacheReferences:[ref],
  });
  const before = parseHexProject(serializeHexProject(project));
  await store.delete(d.artifactId);
  const after = parseHexProject(serializeHexProject(project));
  const userFactsPreserved = JSON.stringify(before.user) === JSON.stringify(after.user)
    && after.user.names[0]?.name === 'user_fact_name'
    && after.user.comments[0]?.text === 'user fact comment'
    && after.user.bookmarks[0]?.label === 'user fact bookmark';
  if (!userFactsPreserved) report.projectUserFactLossFailures++;
  assert.equal(await backend.has(d.artifactId), false, 'derived cache must actually be deletable');
}

assert.equal(report.underInvalidationFailures, 0);
assert.equal(report.overInvalidationFailures, 0);
assert.equal(report.staleHitFailures, 0);
assert.equal(report.cancelledArtifactPublishFailures, 0);
assert.equal(report.zombiePublishFailures, 0);
assert.equal(report.coalescingProducerInvocationCount, 1);
assert.equal(report.wholeFileMaterializationViolations, 0);
assert.equal(report.boundedPagingStateFailures, 0);
assert.equal(report.projectUserFactLossFailures, 0);

console.log('PHASE4_EXIT_GATES ' + JSON.stringify(report));
console.log('phase4 exit gates: PASS');
