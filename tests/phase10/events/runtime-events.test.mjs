import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeEventNormalizer,
  createRuntimeEvent,
  createRuntimeEventBatch,
  normalizeLegacyRuntimeEvent,
} from '../../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'runtime_fixture',
  providerId: 'fixture-provider',
  providerVersion: '1',
  sessionEpoch: 3,
};

test('P10.3 preserves epoch, stream ordering and module generation without fabricating global order', () => {
  const event = createRuntimeEvent({
    ...context,
    streamId: 'thread:1',
    sequence: 7,
    timestamp: '2026-08-20T00:00:00Z',
    moduleBindingKey: 'main',
    moduleGeneration: 2,
    kind: 'call',
    payload: { target: '0x1000' },
    completeness: 'partial',
  });
  assert.equal(event.sessionEpoch, 3);
  assert.equal(event.streamId, 'thread:1');
  assert.equal(event.sequence, 7);
  assert.equal(event.moduleGeneration, 2);
  assert.equal(event.predecessorIds.length, 0);
});

test('P10.3 dedupes only proven provider/stream identity, never payload equality', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 16, maxBytes: 65536 });
  assert.ok(normalizer.push({ type: 'call', streamId: 't1', sequence: 1, target: 'foo' }));
  assert.equal(normalizer.push({ type: 'call', streamId: 't1', sequence: 1, target: 'bar' }), null);
  assert.ok(normalizer.push({ type: 'call', target: 'foo' }));
  assert.ok(normalizer.push({ type: 'call', target: 'foo' }));
  const batch = normalizer.flush();
  assert.equal(batch.events.length, 3);
});

test('P10.3 event pressure creates explicit loss and cannot return complete evidence', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 1, maxBytes: 65536 });
  assert.ok(normalizer.push({ type: 'call', streamId: 't1', sequence: 1 }));
  assert.equal(normalizer.push({ type: 'return', streamId: 't1', sequence: 2 }), null);
  const batch = normalizer.flush();
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.events[0].kind, 'dropped-events');
  assert.equal(batch.events[0].payload.dropped, 1);
  assert.throws(() => createRuntimeEventBatch({ ...context, completeness: 'complete', events: [batch.events[0]] }), /cannot be complete|upgrade/i);
});

test('P10.3 legacy stream truncation remains a gap', () => {
  const event = normalizeLegacyRuntimeEvent({ type: 'stream-truncated', epoch: 3, dropped: 99 }, context);
  assert.equal(event.kind, 'gap');
  assert.equal(event.completeness, 'truncated');
});

test('P10.3 stale epoch events are rejected by the normalizer', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  assert.equal(normalizer.push({ type: 'call', epoch: 2, streamId: 't1', sequence: 1 }), null);
  normalizer.resetEpoch(4);
  assert.ok(normalizer.push({ type: 'call', epoch: 4, streamId: 't1', sequence: 1 }));
});
