import assert from 'node:assert/strict';
import { createArtifactDescriptor } from '../../../js/core/artifacts/contracts.js';
import { ProjectArtifactIndex, createArtifactRef } from '../../../js/project/artifact-index.js';

const binaryId = `bin_sha256_${'a'.repeat(64)}`;
const baseInput = {
  binaryId,
  sliceId:'slice-p4-3',
  entityId:'function-p4-3',
  artifactKind:'semantic-ir',
  producerId:'semantic-lowering',
  producerVersion:'1',
  versions:{
    loader:'loader-v1',
    architectureSemantic:'arm64-effects-v2',
    abiSemantic:'aapcs64-v2',
    semanticSchema:'semantic-ir-v2',
  },
  config:{ mode:'precise', simplify:true },
  upstreamArtifactIds:['artifact_upstream_a'],
};

const descriptor = (changes = {}) => createArtifactDescriptor({
  ...baseInput,
  ...changes,
  versions:{ ...baseInput.versions, ...(changes.versions || {}) },
  config:changes.config === undefined ? baseInput.config : changes.config,
  upstreamArtifactIds:changes.upstreamArtifactIds === undefined ? baseInput.upstreamArtifactIds : changes.upstreamArtifactIds,
});

const base = descriptor();
const sameLogicalInput = descriptor({ config:{ simplify:true, mode:'precise' } });
assert.equal(sameLogicalInput.artifactId, base.artifactId, 'canonical config ordering must not invalidate');

const relevantChanges = [
  ['pass version', descriptor({ producerVersion:'2' })],
  ['semantic schema', descriptor({ versions:{ semanticSchema:'semantic-ir-v3' } })],
  ['upstream ArtifactId', descriptor({ upstreamArtifactIds:['artifact_upstream_b'] })],
  ['behavior config', descriptor({ config:{ mode:'precise', simplify:false } })],
];

for (const [name, changed] of relevantChanges) {
  assert.notEqual(changed.artifactId, base.artifactId, `${name} must change canonical ArtifactId`);
  const index = new ProjectArtifactIndex([createArtifactRef({ scope:'function:1', kind:'semantic-ir', artifactId:base.artifactId })]);
  const result = index.invalidateStale('function:1', 'semantic-ir', changed.artifactId);
  assert.equal(result.status, 'invalidated', `${name} must invalidate the stale ref`);
  assert.equal(index.get('function:1', 'semantic-ir'), null, `${name} stale ref must be removed`);
}

const unrelatedUiMetadataA = { selectedTab:'flow', zoom:1.0, panelWidth:320 };
const unrelatedUiMetadataB = { selectedTab:'evidence', zoom:1.4, panelWidth:480 };
const unrelatedUserFactA = { name:'coins', comment:'confirmed by analyst' };
const unrelatedUserFactB = { name:'currency', comment:'wording changed only' };
void unrelatedUiMetadataA; void unrelatedUiMetadataB; void unrelatedUserFactA; void unrelatedUserFactB;

const afterIrrelevantProjectChanges = descriptor();
assert.equal(afterIrrelevantProjectChanges.artifactId, base.artifactId, 'UI/user facts are outside ArtifactId key material');
const keptIndex = new ProjectArtifactIndex([createArtifactRef({ scope:'function:1', kind:'semantic-ir', artifactId:base.artifactId })]);
const kept = keptIndex.invalidateStale('function:1', 'semantic-ir', afterIrrelevantProjectChanges.artifactId);
assert.equal(kept.status, 'kept', 'irrelevant project changes must not over-invalidate');
assert.equal(keptIndex.get('function:1', 'semantic-ir')?.artifactId, base.artifactId);

let storeReads = 0;
const staleResolution = await keptIndex.resolve('function:1', 'semantic-ir', {
  async get() { storeReads++; return { status:'hit' }; },
}, { expectedArtifactId:relevantChanges[0][1].artifactId });
assert.equal(staleResolution.status, 'miss');
assert.equal(staleResolution.reason, 'stale-ref');
assert.equal(storeReads, 0, 'known-stale refs must not touch local ArtifactStore');

console.log('phase4 project invalidation: PASS');
