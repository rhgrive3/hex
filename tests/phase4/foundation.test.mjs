import assert from 'node:assert/strict';
import {
  ArtifactHotCache,
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
  readArtifactPage,
} from '../../js/core/artifacts/index.js';
import { ResourceBudget } from '../../js/core/budgets/index.js';
import { createBinaryId, createSliceId } from '../../js/core/identity/index.js';
import { InstrumentedByteSource } from '../../js/bytesource/cached.js';
import { MemoryByteSource } from '../../js/binary/source.js';
import { createHexProject, serializeHexProject, parseHexProject } from '../../js/project/index.js';
import { ProjectArtifactIndex, createArtifactRef } from '../../js/project/artifact-index.js';

function descriptor(overrides = {}) {
  return createArtifactDescriptor({
    binaryId:'bin_test_a', sliceId:'slice_test_a', entityId:'function_test_a', artifactKind:'semantic-ir',
    producerId:'semantic-ir-v2', producerVersion:'1',
    versions:{ loader:'macho-1', architectureSemantic:'arm64-2', abiSemantic:'aapcs64-1', semanticSchema:'2' },
    config:{ mode:'precise', nested:{ a:1, b:2 } },
    ...overrides,
  });
}

// Identity determinism: repeated, object order, Map order, reopen-safe values.
const a = descriptor();
const b = descriptor({ config:{ nested:{ b:2, a:1 }, mode:'precise' } });
assert.equal(a.artifactId, b.artifactId);
const map1 = new Map([['alpha', 1], ['beta', 2]]);
const map2 = new Map([['beta', 2], ['alpha', 1]]);
assert.equal(descriptor({ config:{ table:map1 } }).artifactId, descriptor({ config:{ table:map2 } }).artifactId);
assert.notEqual(descriptor({ config:{ table:map1 } }).artifactId, descriptor({ config:{ table:new Map([['alpha', 1], ['beta', 3]]) } }).artifactId,
  'Map content must be key material while insertion order is not');
assert.equal(descriptor({ displayMetadata:{ selectedPanel:'ssa' } }).artifactId, descriptor({ displayMetadata:{ selectedPanel:'decompiler' } }).artifactId);
assert.equal(descriptor({ unrelatedUserFacts:{ comment:'one' } }).artifactId, descriptor({ unrelatedUserFacts:{ comment:'two' } }).artifactId);
assert.notEqual(a.artifactId, descriptor({ binaryId:'bin_test_b' }).artifactId);
assert.notEqual(a.artifactId, descriptor({ sliceId:'slice_test_b' }).artifactId);
assert.notEqual(a.artifactId, descriptor({ producerVersion:'2' }).artifactId);
assert.notEqual(a.artifactId, descriptor({ config:{ mode:'fast' } }).artifactId);
assert.notEqual(a.artifactId, descriptor({ upstreamArtifactIds:['artifact_deadbeef'] }).artifactId);
assert.notEqual(a.artifactId, descriptor({ versions:{ loader:'macho-1', architectureSemantic:'arm64-3', abiSemantic:'aapcs64-1', semanticSchema:'2' } }).artifactId);
assert.notEqual(a.artifactId, descriptor({ versions:{ loader:'macho-1', architectureSemantic:'arm64-2', abiSemantic:'aapcs64-2', semanticSchema:'2' } }).artifactId);
assert.notEqual(a.artifactId, descriptor({ versions:{ loader:'macho-1', architectureSemantic:'arm64-2', abiSemantic:'aapcs64-1', semanticSchema:'3' } }).artifactId);
const runtime1 = descriptor({ relevance:{ runtimeSnapshot:true }, runtimeSnapshotId:'runtime-snapshot-1' });
const runtime2 = descriptor({ relevance:{ runtimeSnapshot:true }, runtimeSnapshotId:'runtime-snapshot-2' });
assert.notEqual(runtime1.artifactId, runtime2.artifactId);

// Irrelevant semantic dimensions are explicitly fixed to n/a and therefore do not over-invalidate.
const nonSemantic1 = createArtifactDescriptor({
  binaryId:'bin_test_a', artifactKind:'source-page', producerId:'bytesource-page', producerVersion:'1',
  versions:{ loader:'1' }, relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
  config:{ offset:'0', length:4 },
});
const nonSemantic2 = createArtifactDescriptor({
  binaryId:'bin_test_a', artifactKind:'source-page', producerId:'bytesource-page', producerVersion:'1',
  versions:{ loader:'1', architectureSemantic:'changed', abiSemantic:'changed', semanticSchema:'changed' },
  relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false }, config:{ offset:'0', length:4 },
});
assert.equal(nonSemantic1.artifactId, nonSemantic2.artifactId);

// Hot cache is bounded and persistent/backend correctness is independent of eviction.
const entries = new Map();
const backend = new MemoryArtifactBackend({ entries });
const store = new ArtifactStore({ backend, hotCache:new ArtifactHotCache({ maxBytes:128, maxEntries:2 }) });
await store.publish(a, { answer:42, order:{ y:2, x:1 } });
let hit = await store.get(a);
assert.equal(hit.status, 'hit');
assert.equal(hit.source, 'hot');
store.evictHot(a.artifactId);
hit = await store.get(a);
assert.equal(hit.status, 'hit');
assert.deepEqual(hit.payload, { answer:42, order:{ x:1, y:2 } });
assert.equal(store.capabilities().persistent, false, 'memory fallback must never report persistent success');

// Corruption fails closed and is deterministically deleted.
store.evictHot(a.artifactId);
const raw = entries.get(a.artifactId);
new Uint8Array(raw.payload)[0] ^= 0xff;
const corrupt = await store.get(a);
assert.equal(corrupt.status, 'corrupt');
assert.equal(await backend.has(a.artifactId), false);

// Source-backed page reads stay bounded on a huge logical source.
class SparseSource extends MemoryByteSource {
  constructor() { super(new Uint8Array(4096)); this.size = 2n ** 34n; }
  async read(offset, length, options = {}) {
    this.validateRange(offset, length);
    if (length > 4096) throw new Error('whole-file-materialization-attempt');
    if (options.signal?.aborted) throw options.signal.reason;
    return new Uint8Array(length).fill(Number(BigInt(offset) & 0xffn));
  }
}
const instrumented = new InstrumentedByteSource(new SparseSource());
const pageBudget = new ResourceBudget({ bytesRead:8192, pagesFetched:4 });
const page = await readArtifactPage(instrumented, { offset:0x100000n, length:1024, budget:pageBudget });
assert.equal(page.bytes.byteLength, 1024);
const rangeMetrics = instrumented.metrics();
assert.equal(rangeMetrics.reads, 1);
assert.equal(rangeMetrics.totalRequested, 1024);
assert.ok(BigInt(rangeMetrics.totalRequested) < instrumented.size);

// .hexproj contains bounded references, not artifact payloads; user facts survive cache deletion.
const ref = createArtifactRef({ scope:'function:function_test_a', kind:'semantic-ir', artifactId:a.artifactId });
const index = new ProjectArtifactIndex([ref]);
const project = createHexProject({
  binaryHash:'abc', comments:[{ address:'0x1000', text:'keep me' }], bookmarks:[{ address:'0x1000' }],
  cacheReferences:index.toProjectReferences(),
});
const text = serializeHexProject(project);
assert.ok(text.includes(a.artifactId));
assert.ok(!text.includes('payloadChecksum'));
assert.ok(!text.includes('"payload"'));
await store.delete(a.artifactId);
const reopenedProject = parseHexProject(text);
assert.equal(reopenedProject.user.comments[0].text, 'keep me');
assert.equal(reopenedProject.user.bookmarks.length, 1);
const missing = await index.resolve('function:function_test_a', 'semantic-ir', store);
assert.equal(missing.status, 'miss');

// Binary content identity feeds ArtifactId rather than filename.
const bytes1 = new Uint8Array([1,2,3,4]);
const bytes2 = new Uint8Array([1,2,3,5]);
const binaryId1 = await createBinaryId(bytes1);
const binaryId2 = await createBinaryId(bytes2);
assert.notEqual(binaryId1, binaryId2);
const slice1 = createSliceId({ binaryId:binaryId1, index:0, architecture:'arm64' });
const slice2 = createSliceId({ binaryId:binaryId2, index:0, architecture:'arm64' });
assert.notEqual(slice1, slice2);

console.log('phase4 foundation contracts: PASS');
