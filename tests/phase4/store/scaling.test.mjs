import assert from 'node:assert/strict';
import { ArtifactHotCache, ArtifactStore, ArtifactUnsupportedError, createArtifactBackend } from '../../../js/core/artifacts/index.js';
import { PersistentMemoryBackend, descriptor } from './support.mjs';

// Persistence capability failure is explicit; fallback never claims persistence.
assert.throws(
  () => createArtifactBackend({ indexedDB:null, allowMemoryFallback:false }),
  (error) => error instanceof ArtifactUnsupportedError && error.code === 'artifact-persistence-unsupported',
);
const fallback = createArtifactBackend({ indexedDB:null });
assert.equal(fallback.capabilities().persistent, false);
assert.equal(fallback.capabilities().reason, 'persistent-storage-unavailable');

// 10 / 100 / 1,000 / 10,000 entries: exact lookup is one keyed backend read.
const entries = new Map();
const backend = new PersistentMemoryBackend({ entries });
const store = new ArtifactStore({ backend, hotCache:new ArtifactHotCache({ maxEntries:0, maxBytes:0 }) });
const checkpoints = new Map();
for (let i = 1; i <= 10000; i++) {
  const d = descriptor(`scale-${i}`);
  await store.publish(d, { i });
  if (i === 10 || i === 100 || i === 1000 || i === 10000) checkpoints.set(i, d);
}
assert.equal(entries.size, 10000);
for (const [count, d] of checkpoints) {
  const before = backend.stats().reads;
  const result = await store.get(d);
  const after = backend.stats().reads;
  assert.equal(result.payload.i, count);
  assert.equal(after - before, 1, `${count} entry exact lookup must not scan the store`);
}
const stats = store.stats();
assert.equal(stats.writes, 10000);
assert.ok(stats.writeBytes > 0);
assert.equal(stats.backend.entries, 10000);
for (const value of [stats.reads, stats.hotHits, stats.persistentHits, stats.hotCache.evictions, stats.duplicatePuts, stats.validationFailures]) {
  assert.ok(Number.isFinite(value));
}

console.log('phase4 P4-1 store scaling: PASS entries=10000');
