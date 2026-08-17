import assert from 'node:assert/strict';
import { createHexProject, parseHexProject, serializeHexProject } from '../../../js/project/index.js';
import {
  ProjectArtifactIndex,
  artifactIndexFromProject,
  createArtifactRef,
} from '../../../js/project/artifact-index.js';

const oldArtifactId = `artifact_${'1'.repeat(32)}`;
const newArtifactId = `artifact_${'2'.repeat(32)}`;
const scope = 'function:portable';
const kind = 'semantic-ir';
const index = new ProjectArtifactIndex();
index.bind({
  scope,
  kind,
  artifactId:oldArtifactId,
  payload:{ mustNeverPersist:true },
  record:{ giantAnalysisGraph:true },
  arbitraryMetadata:{ nested:{ graph:[1,2,3] } },
});

// Persistence is defensive even if a caller bypasses bind() and mutates the
// public Map inherited from the P4-0 contract surface directly.
index.refs.set(ProjectArtifactIndex.key('function:injected', kind), {
  version:1,
  scope:'function:injected',
  kind,
  artifactId:newArtifactId,
  payload:{ directInjectionMustNotPersist:true },
  record:{ giantInjectedGraph:true },
});
const exportedRefs = index.toProjectReferences();
assert.equal(exportedRefs.length, 2);
assert.deepEqual(Object.keys(exportedRefs.find((ref) => ref.scope === 'function:injected')).sort(), ['artifactId', 'kind', 'scope', 'version']);

const userFacts = {
  names:[{ entityId:'function:portable', name:'currency_update' }],
  comments:[{ entityId:'function:portable', text:'analyst comment' }],
  types:[{ entityId:'function:portable', type:'uint32_t' }],
  bookmarks:[{ entityId:'function:portable', label:'review' }],
  patches:[{ offset:'0x10', before:'00', after:'01' }],
};
const confirmedFindings = [{ id:'finding-1', verdict:'confirmed' }];
const investigationSessions = [{ id:'session-1', state:'paused', query:'where is currency updated?' }];

const project = createHexProject({
  binaryHash:'sha256:portable',
  user:userFacts,
  confirmedFindings,
  investigationSessions,
  cacheReferences:exportedRefs,
});
const serialized = serializeHexProject(project);
assert.match(serialized, new RegExp(oldArtifactId));
assert.doesNotMatch(serialized, /mustNeverPersist|giantAnalysisGraph|arbitraryMetadata|directInjectionMustNotPersist|giantInjectedGraph/, 'derived payload/graphs must not enter .hexproj');

const reopened = parseHexProject(serialized);
const assertUserFactsIntact = () => {
  assert.deepEqual(reopened.user.names, userFacts.names);
  assert.deepEqual(reopened.user.comments, userFacts.comments);
  assert.deepEqual(reopened.user.types, userFacts.types);
  assert.deepEqual(reopened.user.bookmarks, userFacts.bookmarks);
  assert.deepEqual(reopened.user.patches, userFacts.patches);
  assert.deepEqual(reopened.findings.confirmed, confirmedFindings);
  assert.deepEqual(reopened.findings.investigationSessions, investigationSessions);
};
assertUserFactsIntact();

const reopenedIndex = artifactIndexFromProject(reopened);
const localStore = {
  async get(artifactId) {
    return artifactId === oldArtifactId
      ? { status:'hit', artifactId, source:'memory', payload:{ cached:true } }
      : { status:'miss', artifactId, source:'memory', reason:'not-found' };
  },
};
const available = await reopenedIndex.resolve(scope, kind, localStore, { expectedArtifactId:oldArtifactId });
assert.equal(available.status, 'hit', 'import should reuse matching local artifact when available');

const noLocalStore = await reopenedIndex.resolve(scope, kind, null, { expectedArtifactId:oldArtifactId });
assert.equal(noLocalStore.status, 'miss');
assert.equal(noLocalStore.reason, 'store-unavailable', 'project must remain usable without local ArtifactStore');

const stale = await reopenedIndex.resolve(scope, kind, localStore, { expectedArtifactId:newArtifactId });
assert.equal(stale.status, 'miss');
assert.equal(stale.reason, 'stale-ref');
const invalidated = reopenedIndex.invalidateStale(scope, kind, newArtifactId);
assert.equal(invalidated.status, 'invalidated');
assert.equal(reopenedIndex.get(scope, kind), null);
assertUserFactsIntact();

reopenedIndex.bind(createArtifactRef({ scope, kind, artifactId:oldArtifactId }));
const deletedArtifact = await reopenedIndex.resolve(scope, kind, {
  async get(artifactId) { return { status:'miss', artifactId, reason:'not-found' }; },
}, { expectedArtifactId:oldArtifactId });
assert.equal(deletedArtifact.status, 'miss');
assert.equal(deletedArtifact.reason, 'not-found');
assertUserFactsIntact();

const deletedStore = await reopenedIndex.resolve(scope, kind, {
  async get() { const error = new Error('database deleted'); error.name = 'InvalidStateError'; throw error; },
}, { expectedArtifactId:oldArtifactId });
assert.equal(deletedStore.status, 'miss');
assert.equal(deletedStore.reason, 'store-unavailable');
assert.equal(deletedStore.storeError.name, 'InvalidStateError');
assertUserFactsIntact();

reopenedIndex.bind(createArtifactRef({ scope, kind, artifactId:newArtifactId }));
const recomputed = await reopenedIndex.resolve(scope, kind, {
  async get(artifactId) { return { status:'hit', artifactId, source:'memory', payload:{ recomputed:true } }; },
}, { expectedArtifactId:newArtifactId });
assert.equal(recomputed.status, 'hit', 'later recomputation should replace stale local ref cleanly');
assert.equal(recomputed.artifact.payload.recomputed, true);
assertUserFactsIntact();

const hostileProject = createHexProject({
  cacheReferences:[
    createArtifactRef({ scope:'safe', kind, artifactId:oldArtifactId }),
    { ...createArtifactRef({ scope:'payload-bearing', kind, artifactId:newArtifactId }), payload:{ derived:true } },
    { ...createArtifactRef({ scope:'record-bearing', kind, artifactId:newArtifactId }), record:{ payloadSize:999999 } },
  ],
});
const sanitized = artifactIndexFromProject(hostileProject);
assert.ok(sanitized.get('safe', kind));
assert.equal(sanitized.get('payload-bearing', kind), null, 'payload-bearing pseudo refs must be rejected');
assert.equal(sanitized.get('record-bearing', kind), null, 'record-bearing pseudo refs must be rejected');

console.log('phase4 project portability: PASS');
