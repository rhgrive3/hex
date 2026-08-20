import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaimNode, EvidenceGraph } from '../../../js/core/evidence/index.js';
import { RuntimeEvidenceBridge, InterventionLedger, conservativeCompleteness } from '../../../js/runtime/evidence-bridge.js';
import { createRuntimeEvent } from '../../../js/runtime/events.js';

const binaryId = 'bin_sha256_' + '34'.repeat(32);
const resolution = {
  runtimeSessionId: 'runtime_fixture',
  state: 'exact',
  method: 'verified-module-offset',
  binaryId,
  staticAddress: 0x1234n,
  targetEntityIds: ['function:fixture'],
  evidenceIds: ['evidence:mapping'],
};

function runtimeEvent(overrides = {}) {
  return createRuntimeEvent({
    runtimeSessionId: 'runtime_fixture',
    providerId: 'fixture-provider',
    providerVersion: '1',
    sessionEpoch: 1,
    streamId: 'thread:1',
    sequence: 1,
    kind: 'call',
    payload: { target: '0x1234' },
    completeness: 'complete',
    ...overrides,
  });
}

test('P10.4 canonical runtime evidence links static entities only after identity resolution', () => {
  const graph = new EvidenceGraph({ nodes: [createClaimNode({
    id: 'claim:fixture',
    binaryId,
    targetEntityIds: ['function:fixture'],
    semanticKind: 'calls-target',
    verdict: 'unknown',
  })] });
  const bridge = new RuntimeEvidenceBridge({ graph });
  const evidence = bridge.eventToEvidence(runtimeEvent(), resolution, { semanticKind: 'calls-target', confidence: 0.9 });
  assert.equal(evidence.family, 'RuntimeEvidence');
  assert.deepEqual(evidence.targetEntityIds, ['function:fixture']);
  assert.equal(evidence.deterministic, false);
  const linked = bridge.linkClaim('claim:fixture', evidence.id, 'supports', resolution);
  assert.equal(linked.linked, true);
  assert.equal(graph.evaluateClaim('claim:fixture').verdict, 'supported');
});

test('P10.4 unresolved runtime evidence remains inspectable but cannot attach to a static claim', () => {
  const graph = new EvidenceGraph({ nodes: [createClaimNode({
    id: 'claim:unresolved',
    binaryId,
    targetEntityIds: ['function:fixture'],
    semanticKind: 'calls-target',
    verdict: 'unknown',
  })] });
  const bridge = new RuntimeEvidenceBridge({ graph });
  const unresolved = { runtimeSessionId: 'runtime_fixture', state: 'unresolved', method: 'jit', targetEntityIds: [], evidenceIds: [] };
  const evidence = bridge.eventToEvidence(runtimeEvent(), unresolved);
  assert.deepEqual(evidence.targetEntityIds, []);
  assert.equal(evidence.completeness, 'partial');
  const link = bridge.linkClaim('claim:unresolved', evidence.id, 'supports', unresolved);
  assert.equal(link.linked, false);
  assert.equal(link.reason, 'static-resolution-required');
});

test('P10.4 truncation never becomes complete after exact resolution', () => {
  const bridge = new RuntimeEvidenceBridge();
  const evidence = bridge.eventToEvidence(runtimeEvent({ completeness: 'truncated' }), resolution);
  assert.equal(evidence.completeness, 'truncated');
  assert.equal(conservativeCompleteness('truncated', 'complete'), 'truncated');
});

test('P10.4 intervention ancestry is preserved on later observations', () => {
  const interventions = new InterventionLedger();
  const first = interventions.add({
    runtimeSessionId: 'runtime_fixture', providerId: 'fixture-provider', kind: 'register-write', target: 'x0', requestedChange: 7,
  });
  const second = interventions.add({
    runtimeSessionId: 'runtime_fixture', providerId: 'fixture-provider', kind: 'function-replacement', target: 'foo', requestedChange: 'bar', parentInterventionIds: [first.interventionId],
  });
  const bridge = new RuntimeEvidenceBridge({ interventions });
  const evidence = bridge.eventToEvidence(runtimeEvent({ observationMode: 'intervened', interventionIds: [second.interventionId] }), resolution);
  assert.equal(evidence.payload.observationMode, 'intervened');
  assert.deepEqual(new Set(evidence.payload.interventionIds), new Set([first.interventionId, second.interventionId]));
});

test('P10.4 mismatch cannot be used to support or contradict a local static claim', () => {
  const graph = new EvidenceGraph({ nodes: [createClaimNode({
    id: 'claim:mismatch', binaryId, targetEntityIds: ['function:fixture'], semanticKind: 'branch-reachable', verdict: 'unknown',
  })] });
  const bridge = new RuntimeEvidenceBridge({ graph });
  const mismatch = { runtimeSessionId: 'runtime_fixture', state: 'mismatch', method: 'binary-id-mismatch', targetEntityIds: ['function:fixture'], evidenceIds: [] };
  const evidence = bridge.eventToEvidence(runtimeEvent(), mismatch);
  assert.equal(evidence.completeness, 'unsupported');
  const result = bridge.linkClaim('claim:mismatch', evidence.id, 'contradicts', mismatch);
  assert.equal(result.linked, false);
  assert.equal(result.reason, 'identity-mismatch');
});
