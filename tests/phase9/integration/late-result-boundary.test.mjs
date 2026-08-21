import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceStore } from '../../../js/ai/evidence.js';
import { ToolRegistry } from '../../../js/ai/tools/registry.js';

test('publishable first-use results ingest evidence before cached reuse', async () => {
  const evidenceStore = new EvidenceStore();
  const registry = new ToolRegistry({ evidenceStore, context: { binaryIdentity: 'first-use-test' } });
  let executions = 0;
  registry.register({
    name: 'first_use_observation',
    execute: async () => {
      executions += 1;
      return { address: '0x1000', name: 'observed' };
    },
    modelProjection: (result, meta) => ({ result, evidenceIds: meta.evidenceIds }),
  });

  const first = await registry.execute('first_use_observation', {});
  const second = await registry.execute('first_use_observation', {});

  assert.ok(first.evidenceIds.length > 0);
  assert.deepEqual(second.evidenceIds, first.evidenceIds);
  assert.equal(executions, 1);
  assert.equal(registry.accounting.cacheHits, 1);
});

test('invalidated late solver results do not enter ObservationStore or EvidenceStore', async () => {
  const ingested = [];
  const evidenceStore = {
    ingest(...args) { ingested.push(args); return [{ id: 'must-not-exist' }]; },
  };
  const registry = new ToolRegistry({ evidenceStore, context: { binaryIdentity: 'late-test' } });
  registry.register({
    name: 'late_solver_result',
    deterministic: false,
    storeResult: true,
    modelProjection: (result) => result,
    execute: async () => ({
      verdict: 'unknown',
      solverResult: {
        status: 'unsat',
        lifecycle: { late: true, stale: true, publishable: false },
      },
    }),
  });

  const result = await registry.execute('late_solver_result', {});

  assert.deepEqual(result.evidence, []);
  assert.equal(ingested.length, 0);
  assert.equal(registry.observationStore.records.size, 0);
  assert.equal(registry.observationStore.getCached('late_solver_result', {}), null);
});
