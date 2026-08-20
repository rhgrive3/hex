import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase8ArtifactDescriptor, PHASE8_ARTIFACT_KINDS } from '../../../js/decompiler/phase8/artifact-identity.js';
import { artifactIdentityFailures } from '../../../tools/validation/phase8/metrics.mjs';

const BASE = Object.freeze({
  kind: 'phase8.valueNumbers',
  binaryId: 'binary_probe',
  functionId: 'function_probe',
  architectureId: 'arm64',
  snapshotId: 'snapshot_probe',
  semanticSchemaVersion: 'semantic-ir/v2',
  cfgVersion: 'cfg/1',
  ssaVersion: 'ssa/1',
  memorySsaVersion: 'mssa/1',
  producerId: 'phase8.gvn',
  producerVersion: '1.0.0',
  passRegistryDigest: 'digest-a',
});

test('every declared artifact kind names its upstream dependency classes', () => {
  for (const [kind, classes] of Object.entries(PHASE8_ARTIFACT_KINDS)) {
    assert.ok(Array.isArray(classes) && classes.length > 0, `${kind} declares no dependency class`);
  }
});

test('an undeclared artifact kind cannot be published', () => {
  assert.throws(() => createPhase8ArtifactDescriptor({ ...BASE, kind: 'phase8.vibes' }), /unknown-kind/);
});

test('the key discriminates on everything a Phase 8 result actually depends on', () => {
  assert.deepEqual(artifactIdentityFailures(), []);
});

test('a memory-dependent kind must declare its MemorySSA version', () => {
  const { memorySsaVersion, ...withoutMemory } = BASE;
  assert.throws(() => createPhase8ArtifactDescriptor(withoutMemory), /memoryssa-version-required/);
  // A kind that does not depend on memory must not be forced to invent one.
  assert.ok(createPhase8ArtifactDescriptor({ ...withoutMemory, kind: 'phase8.constants' }).artifactId);
});

test('upstream artifact ids are part of the key', () => {
  const withoutUpstream = createPhase8ArtifactDescriptor(BASE);
  const withUpstream = createPhase8ArtifactDescriptor({ ...BASE, upstreamArtifactIds: ['artifact_alias_1'] });
  assert.notEqual(withoutUpstream.artifactId, withUpstream.artifactId);
});

test('presentation state may not enter an artifact key', () => {
  // A cached analysis that depends on the pretty printer's column width is not
  // an analysis. This is checked, not documented.
  assert.throws(() => createPhase8ArtifactDescriptor({ ...BASE, options: { columnWidth: 88 } }),
    /presentation-state-in-key:columnWidth/);
  assert.throws(() => createPhase8ArtifactDescriptor({ ...BASE, options: { render: { theme: 'dark' } } }),
    /presentation-state-in-key:theme/);
});

test('a budget class that cannot affect completeness is kept out of the key', () => {
  const keyed = createPhase8ArtifactDescriptor({ ...BASE, budgetClass: 'interactive' });
  const unkeyed = createPhase8ArtifactDescriptor({ ...BASE, budgetClass: 'interactive', budgetAffectsCompleteness: false });
  const otherUnkeyed = createPhase8ArtifactDescriptor({ ...BASE, budgetClass: 'exhaustive', budgetAffectsCompleteness: false });
  assert.notEqual(keyed.artifactId, unkeyed.artifactId);
  assert.equal(unkeyed.artifactId, otherUnkeyed.artifactId);
});
