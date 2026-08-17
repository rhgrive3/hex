import assert from 'node:assert/strict';
import { ArtifactHotCache, ArtifactStore } from '../../../js/core/artifacts/index.js';
import { artifactHotEntrySize } from '../../../js/core/artifacts/storage/integrity.js';
import { DelayedReadBackend, PersistentMemoryBackend, descriptor } from './support.mjs';

// put/get, cold miss, hot hit, deterministic encoding, mutable-return isolation.
{
  const entries = new Map();
  const store = new ArtifactStore({
    backend:new PersistentMemoryBackend({ entries }),
    hotCache:new ArtifactHotCache({ maxBytes:1024 * 1024, maxEntries:8 }),
  });
  const d = descriptor('basic');
  assert.equal((await store.get(d)).status, 'miss');
  const published = await store.publish(d, { z:3, nested:{ b:2, a:1 } });
  assert.equal(published.status, 'published');
  assert.deepEqual(published.payload, { nested:{ a:1, b:2 }, z:3 });
  assert.equal(new TextDecoder().decode(entries.get(d.artifactId).payload), '{"nested":{"a":1,"b":2},"z":3}');
  published.payload.nested.a = 999;
  const hot = await store.get(d);
  assert.equal(hot.source, 'hot');
  assert.equal(hot.payload.nested.a, 1);
  assert.equal(store.stats().hotHits, 1);
}

// Deterministic bounded LRU and exact eviction accounting.
{
  const hot = new ArtifactHotCache({ maxBytes:4, maxEntries:2 });
  assert.equal(hot.put('a', { a:true }, 2), true);
  assert.equal(hot.put('b', { b:true }, 2), true);
  assert.ok(hot.get('a'));
  assert.equal(hot.put('c', { c:true }, 2), true);
  assert.equal(hot.get('b'), null);
  assert.ok(hot.get('a'));
  assert.ok(hot.get('c'));
  const stats = hot.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.bytes, 4);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.evictionBytes, 2);
}

// Hot eviction preserves canonical ID semantics and persistent data remains a hit.
{
  const entries = new Map();
  const store = new ArtifactStore({
    backend:new PersistentMemoryBackend({ entries }),
    hotCache:new ArtifactHotCache({ maxBytes:4096, maxEntries:1 }),
  });
  const a = descriptor('evict-a');
  const b = descriptor('evict-b');
  await store.publish(a, { value:'a' });
  await store.publish(b, { value:'b' });
  const result = await store.get(a);
  assert.equal(result.source, 'persistent');
  assert.deepEqual(result.payload, { value:'a' });
  assert.equal(store.stats().persistentHits, 1);
  assert.ok(store.stats().hotCache.evictions >= 1);
}

// Large payload accounting counts retained record bytes plus raw payload bytes.
{
  const entries = new Map();
  const store = new ArtifactStore({
    backend:new PersistentMemoryBackend({ entries }),
    hotCache:new ArtifactHotCache({ maxBytes:128 * 1024, maxEntries:4 }),
  });
  const d = descriptor('large');
  await store.publish(d, { text:'x'.repeat(32 * 1024) });
  const raw = entries.get(d.artifactId);
  assert.equal(store.stats().hotCache.bytes, artifactHotEntrySize(raw.record, new Uint8Array(raw.payload)));
}

// Close/reopen and duplicate publication are deterministic.
{
  const entries = new Map();
  const d = descriptor('reopen');
  let store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const first = await store.publish(d, { reopened:true }, { creation:{ producerRun:'first' } });
  const duplicate = await store.publish(d, { reopened:true }, { creation:{ producerRun:'second' } });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.creation.producerRun, 'first');
  await store.close();
  store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const reopened = await store.get(d);
  assert.equal(reopened.source, 'persistent');
  assert.deepEqual(reopened.payload, { reopened:true });
}

// Non-key provenance cannot become a second ArtifactId implementation.
{
  const entries = new Map();
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const a = descriptor('canonical-id', { originRefs:['evidence_a'] });
  const b = descriptor('canonical-id', { originRefs:['evidence_b'] });
  assert.equal(a.artifactId, b.artifactId);
  await store.publish(a, { value:'same-cas' });
  const duplicate = await store.publish(b, { value:'same-cas' });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.record.originRefs, ['evidence_a']);
}

// Concurrent exact-ID operations cannot tear publication or reintroduce deleted data.
{
  const entries = new Map();
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const d = descriptor('concurrent-same');
  const same = await Promise.all([store.publish(d, { value:7 }), store.publish(d, { value:7 })]);
  assert.equal(same.filter((r) => r.duplicate).length, 1);
  assert.equal(store.stats().writes, 1);
  assert.equal(store.stats().duplicatePuts, 1);

  const conflict = descriptor('concurrent-conflict');
  const results = await Promise.allSettled([store.publish(conflict, { value:'first' }), store.publish(conflict, { value:'second' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'artifact-immutable-conflict');
  assert.deepEqual((await store.get(conflict)).payload, { value:'first' });

  store.evictHot(d.artifactId);
  const reads = await Promise.all(Array.from({ length:32 }, () => store.get(d)));
  assert.ok(reads.every((r) => r.status === 'hit' && r.payload.value === 7));
}

{
  const entries = new Map();
  const backend = new DelayedReadBackend({ entries });
  const store = new ArtifactStore({ backend, hotCache:new ArtifactHotCache({ maxEntries:0, maxBytes:0 }) });
  const d = descriptor('delete-race');
  await store.publish(d, { value:'old' });
  backend.armDelay();
  const reading = store.get(d);
  await backend.entered;
  const deleting = store.delete(d.artifactId);
  backend.releaseResolve();
  await Promise.allSettled([reading, deleting]);
  assert.equal((await store.get(d)).status, 'miss');
}

console.log('phase4 P4-1 store basic/concurrency: PASS');
