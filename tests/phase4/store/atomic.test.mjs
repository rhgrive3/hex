import assert from 'node:assert/strict';
import { ArtifactStorageError, ArtifactStore } from '../../../js/core/artifacts/index.js';
import { AbortOnCommitBackend, FailingBackend, PersistentMemoryBackend, descriptor } from './support.mjs';

// Validation, serialization, backend and quota failures leave no publication.
{
  const backend = new PersistentMemoryBackend();
  const store = new ArtifactStore({ backend });
  const validation = descriptor('validation-failure');
  await assert.rejects(store.publish(validation, { value:1 }, { validate:async () => { throw new Error('fixture-validation-failed'); } }), /fixture-validation-failed/);
  assert.equal(await backend.has(validation.artifactId), false);
  assert.equal(store.stats().validationFailures, 1);

  const cyclic = {};
  cyclic.self = cyclic;
  const serialization = descriptor('serialization-failure');
  await assert.rejects(store.publish(serialization, cyclic));
  assert.equal(await backend.has(serialization.artifactId), false);
  assert.equal(store.stats().serializationFailures, 1);

  const failed = new ArtifactStore({ backend:new FailingBackend(new ArtifactStorageError('artifact-storage-failure', 'transaction aborted')) });
  await assert.rejects(failed.publish(descriptor('backend-failure'), { value:3 }), (error) => error.code === 'artifact-storage-failure');
  assert.equal(failed.stats().storageFailures, 1);

  const quota = new ArtifactStore({ backend:new FailingBackend(new ArtifactStorageError('artifact-storage-quota-exceeded', 'quota')) });
  const quotaDescriptor = descriptor('quota');
  await assert.rejects(quota.publish(quotaDescriptor, { value:1 }), (error) => error.code === 'artifact-storage-quota-exceeded');
  assert.equal((await quota.get(quotaDescriptor)).status, 'miss');
}

// Cancellation during staging, immediately before publish, and on publication boundary leaves no future hit.
{
  const entries = new Map();
  const backend = new PersistentMemoryBackend({ entries });
  const store = new ArtifactStore({ backend });
  const staged = descriptor('cancel-staging');
  const controller = new AbortController();
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const promise = store.publish(staged, { value:1 }, { signal:controller.signal, validate:async () => { enteredResolve(); await gate; } });
  await entered;
  controller.abort(new DOMException('cancelled while staged', 'AbortError'));
  release();
  await assert.rejects(promise, (error) => error?.name === 'AbortError');
  assert.equal(await backend.has(staged.artifactId), false);

  const before = descriptor('cancel-before-publish');
  const beforeController = new AbortController();
  await assert.rejects(store.publish(before, { value:2 }, {
    signal:beforeController.signal,
    validate:async () => { beforeController.abort(new DOMException('cancelled before publish', 'AbortError')); },
  }), (error) => error?.name === 'AbortError');
  assert.equal(await backend.has(before.artifactId), false);

  const boundaryController = new AbortController();
  const boundaryBackend = new AbortOnCommitBackend(boundaryController, { entries:new Map() });
  const boundaryStore = new ArtifactStore({ backend:boundaryBackend });
  const boundary = descriptor('cancel-publication-boundary');
  await assert.rejects(boundaryStore.publish(boundary, { value:3 }, { signal:boundaryController.signal }), (error) => error?.name === 'AbortError');
  assert.equal(await boundaryBackend.has(boundary.artifactId), false);
}

// During staging consumers only see the old state/miss; after publish they see a complete artifact.
{
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries:new Map() }) });
  const d = descriptor('staged-get');
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const publishing = store.publish(d, { complete:true, nested:{ x:1 } }, { validate:async () => { enteredResolve(); await gate; } });
  await entered;
  assert.equal((await store.get(d)).status, 'miss');
  release();
  await publishing;
  assert.deepEqual((await store.get(d)).payload, { complete:true, nested:{ x:1 } });
}

console.log('phase4 P4-1 store atomic/error: PASS');
