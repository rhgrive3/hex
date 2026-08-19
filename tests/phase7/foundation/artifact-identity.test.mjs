import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE7_ARTIFACT_KINDS,
  createPhase7ArtifactDescriptor,
  dependencyClassFor,
  explainArtifactMismatch,
} from '../../../js/analysis/artifact-identity.js';

const base = (overrides = {}) => ({
  kind: 'phase7.pointsto.local',
  binaryId: 'binary_1',
  functionId: 'function_1',
  architectureId: 'arm64',
  snapshotId: 'snapshot_1',
  analyzerId: 'phase7.pointsto.a2-local',
  analyzerVersion: '1.0.0',
  semanticSchemaVersion: '2',
  cfgVersion: '2.0.0',
  ssaVersion: '2.0.0',
  memorySsaVersion: '2.0.0',
  ...overrides,
});

test('every declared artifact kind declares its dependency class', () => {
  for (const kind of PHASE7_ARTIFACT_KINDS) {
    const classes = dependencyClassFor(kind);
    assert.ok(Array.isArray(classes) && classes.length > 0, `no dependency class for ${kind}`);
    assert.ok(classes.includes('binary'), `${kind} must depend on binary identity`);
  }
});

test('the same inputs produce the same artifact id', () => {
  assert.equal(
    createPhase7ArtifactDescriptor(base()).artifactId,
    createPhase7ArtifactDescriptor(base()).artifactId,
  );
});

test('a change to any semantically relevant input changes the artifact id', () => {
  const reference = createPhase7ArtifactDescriptor(base()).artifactId;
  const mutations = [
    { binaryId: 'binary_2' },
    { functionId: 'function_2' },
    { architectureId: 'x86_64' },
    { snapshotId: 'snapshot_2' },
    { analyzerVersion: '1.0.1' },
    { semanticSchemaVersion: '3' },
    { cfgVersion: '2.1.0' },
    { ssaVersion: '2.1.0' },
    { memorySsaVersion: '2.1.0' },
    { options: { widenAfterIterations: 9 } },
    { upstreamArtifactIds: ['artifact_upstream_1'] },
  ];
  for (const mutation of mutations) {
    const mutated = createPhase7ArtifactDescriptor(base(mutation)).artifactId;
    assert.notEqual(mutated, reference, `mutation did not change artifact identity: ${JSON.stringify(mutation)}`);
  }
});

test('interprocedural results are keyed by exact callee summary identity', () => {
  const withCallee = (ids) => createPhase7ArtifactDescriptor(base({
    kind: 'phase7.summary.interprocedural',
    calleeSummaryIds: ids,
  })).artifactId;
  assert.notEqual(withCallee(['summary_a@1']), withCallee(['summary_a@2']),
    'a changed callee summary must invalidate the caller result (FM-4)');
  assert.equal(withCallee(['summary_a@1', 'summary_b@1']), withCallee(['summary_b@1', 'summary_a@1']),
    'callee summary order is not semantic');
});

test('debug-derived facts are keyed by provider version and matched build identity', () => {
  const withDebug = (providerVersion, buildIdentity) => createPhase7ArtifactDescriptor(base({
    kind: 'phase7.debug.facts',
    debugProviderVersion: providerVersion,
    debugBuildIdentity: buildIdentity,
  })).artifactId;
  assert.notEqual(withDebug('1.0.0', 'build_a'), withDebug('1.0.1', 'build_a'));
  assert.notEqual(withDebug('1.0.0', 'build_a'), withDebug('1.0.0', 'build_b'));
});

test('presentation state can never enter a semantic cache key', () => {
  // Keying alias analysis by the open tab or a user rename both over-invalidates
  // and makes the cache unreproducible, so it is rejected rather than hashed.
  for (const key of ['fileName', 'tabId', 'displayAddress', 'userName', 'userComment', 'selection']) {
    assert.throws(
      () => createPhase7ArtifactDescriptor(base({ options: { [key]: 'anything' } })),
      /phase7-artifact-presentation-state-in-key/,
      `presentation field accepted into the key: ${key}`,
    );
  }
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ options: { nested: { tabId: 'x' } } })),
    /phase7-artifact-presentation-state-in-key/,
  );
});

test('budget class enters the key only when completeness depends on it', () => {
  const bounded = createPhase7ArtifactDescriptor(base({ budgetClass: 'interactive' })).artifactId;
  const exhaustive = createPhase7ArtifactDescriptor(base({ budgetClass: 'exhaustive' })).artifactId;
  assert.notEqual(bounded, exhaustive, 'a bounded artifact must not be interchangeable with an exhaustive one');
  const ignored = createPhase7ArtifactDescriptor(base({ budgetClass: 'interactive', budgetAffectsCompleteness: false })).artifactId;
  const ignoredOther = createPhase7ArtifactDescriptor(base({ budgetClass: 'exhaustive', budgetAffectsCompleteness: false })).artifactId;
  assert.equal(ignored, ignoredOther);
});

test('a mismatch is always explained, never silently tolerated', () => {
  const expected = createPhase7ArtifactDescriptor(base());
  assert.equal(explainArtifactMismatch(expected, expected), null);
  assert.equal(explainArtifactMismatch(expected, null), 'missing');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ binaryId: 'binary_2' }))), 'binary');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ analyzerVersion: '9.9.9' }))), 'analyzer-version');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ upstreamArtifactIds: ['x'] }))), 'dependency');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ options: { a: 1 } }))), 'options');
});

test('required identity is enforced rather than defaulted', () => {
  assert.throws(() => createPhase7ArtifactDescriptor(base({ binaryId: '' })), /binary-id-required/);
  assert.throws(() => createPhase7ArtifactDescriptor(base({ snapshotId: null })), /snapshot-required/);
  assert.throws(() => createPhase7ArtifactDescriptor(base({ memorySsaVersion: null })), /memoryssa-version-required/);
  assert.throws(() => createPhase7ArtifactDescriptor(base({ kind: 'phase7.not.a.kind' })), /unknown-kind/);
});
