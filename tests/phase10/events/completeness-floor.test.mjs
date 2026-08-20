import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeEventBatch } from '../../../js/runtime/events.js';

const base = { runtimeSessionId: 'runtime_fixture', providerId: 'fixture-provider', providerVersion: '1', sessionEpoch: 1 };

test('P10 review: a batch cannot upgrade partial or unsupported source completeness', () => {
  assert.throws(() => createRuntimeEventBatch({
    ...base,
    completeness: 'complete',
    events: [{ ...base, kind: 'call', payload: {}, completeness: 'partial' }],
  }), /cannot upgrade/i);
  assert.throws(() => createRuntimeEventBatch({
    ...base,
    completeness: 'bounded',
    events: [{ ...base, kind: 'provider-error', payload: {}, completeness: 'unsupported' }],
  }), /cannot upgrade/i);
});
