import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceProvider } from '../../../js/runtime/trace-provider.js';

const binaryA = 'bin_sha256_' + '56'.repeat(32);
const binaryB = 'bin_sha256_' + '78'.repeat(32);

function recording(overrides = {}) {
  return {
    recordingId: 'recording:fixture',
    schemaVersion: '1',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '2',
    binaryId: binaryA,
    sliceId: 'slice:arm64',
    architecture: 'arm64',
    platform: 'darwin',
    completeness: 'complete',
    modules: [{
      bindingKey: 'main',
      runtimeBase: 0x7000n,
      runtimeSize: 0x1000n,
      staticBase: 0x1000n,
      binaryId: binaryA,
      sliceId: 'slice:arm64',
      identityState: 'exact',
      identityEvidenceIds: ['fixture:trace-module-match'],
    }],
    events: [
      { type: 'call', streamId: 't1', sequence: 1, moduleBindingKey: 'main', moduleGeneration: 1, payload: { target: '0x7100' }, completeness: 'complete' },
      { type: 'return', streamId: 't1', sequence: 2, moduleBindingKey: 'main', moduleGeneration: 1, payload: { value: 1 }, completeness: 'complete' },
    ],
    ...overrides,
  };
}

test('P10.5 import -> normalize -> replay is deterministic', async () => {
  const provider = new TraceProvider(recording(), { id: 'trace-provider' });
  const session = await provider.openSession({ targetIdentity: { recording: 'fixture' } });
  assert.equal(session.state, 'ready');
  assert.ok(session.facets.trace);
  assert.equal(session.facets.debugger, undefined);

  const first = await session.facets.trace.replay();
  const second = await session.facets.trace.replay();
  assert.equal(first.completeness, 'complete');
  assert.deepEqual(first.events.map((event) => event.eventId), second.events.map((event) => event.eventId));
  assert.deepEqual(first.events.map((event) => event.kind), ['call', 'return']);
  await session.close();
});

test('P10.5 trace gaps survive replay and downgrade completeness', async () => {
  const provider = new TraceProvider(recording({ completeness: 'complete', dropped: 4, truncated: true }), { id: 'trace-gap-provider' });
  const session = await provider.openSession();
  const replay = await session.facets.trace.replay();
  assert.equal(replay.completeness, 'truncated');
  assert.ok(replay.events.some((event) => event.kind === 'dropped-events'));
  await session.close();
});

test('P10.5 same runtime address on a different binary does not attach by filename or VA', async () => {
  const provider = new TraceProvider(recording(), { id: 'trace-identity-provider' });
  const session = await provider.openSession();
  const exact = session.facets.trace.resolveAddress(0x7010n, { binaryId: binaryA, sliceId: 'slice:arm64' });
  assert.equal(exact.state, 'exact');
  const mismatch = session.facets.trace.resolveAddress(0x7010n, { binaryId: binaryB, sliceId: 'slice:arm64' });
  assert.equal(mismatch.state, 'mismatch');
  await session.close();
});

test('P10.5 recording-level binary identity does not implicitly authenticate the first trace module', async () => {
  const provider = new TraceProvider(recording({
    modules: [{ bindingKey: 'main', runtimeBase: 0x7000n, runtimeSize: 0x1000n, staticBase: 0x1000n }],
  }), { id: 'trace-unproven-module-provider' });
  const session = await provider.openSession();
  const [module] = session.modules.active();
  assert.equal(module.identityState, 'unresolved');
  assert.equal(module.binaryId, null);
  assert.equal(session.facets.trace.resolveAddress(0x7010n, { binaryId: binaryA }).state, 'unresolved');
  await session.close();
});

test('P10.5 event streaming is bounded, batched and cancellable', async () => {
  const provider = new TraceProvider(recording(), { id: 'trace-stream-provider' });
  const session = await provider.openSession();
  const batches = [];
  for await (const batch of session.facets.trace.events({ batchSize: 1 })) batches.push(batch);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((batch) => batch.events.length <= 1));

  const controller = new AbortController();
  controller.abort('fixture');
  await assert.rejects(async () => {
    for await (const _batch of session.facets.trace.events({ signal: controller.signal })) { /* unreachable */ }
  }, /cancelled/i);
  await session.close();
});
