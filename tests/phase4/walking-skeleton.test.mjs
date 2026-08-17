import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { InstrumentedByteSource } from '../../js/bytesource/cached.js';
import { MemoryByteSource } from '../../js/binary/source.js';
import {
  ArtifactHotCache,
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
  readArtifactPage,
} from '../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../js/core/scheduler/index.js';
import { createBinaryId, createBlockId, createFunctionId, createSliceId } from '../../js/core/identity/index.js';
import {
  SEMANTIC_IR_SCHEMA_VERSION,
  canonicalSerializeSemanticIr,
  lowerMachineEffectBundleToSemanticIr,
  validateSemanticIrFunction,
} from '../../js/semantics/ir/index.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';

// AArch64: add x0, x1, x2 => 0x8b020020, little-endian.
const codeBytes = new Uint8Array([0x20, 0x00, 0x02, 0x8b]);
const binaryId = await createBinaryId(codeBytes);
const sliceId = createSliceId({ binaryId, index:0, architecture:'arm64', sourceRange:{ offset:0, length:4 } });
const functionId = createFunctionId({ binaryId, sliceId, canonicalStartIdentity:'0x1000' });
const blockId = createBlockId({ functionId, canonicalBlockIdentity:'0x1000' });

function semanticDescriptor(producerVersion = '1', upstreamArtifactIds = []) {
  return createArtifactDescriptor({
    binaryId, sliceId, entityId:functionId, artifactKind:'semantic-ir-v2',
    producerId:'phase3-machine-effects-to-semantic-ir', producerVersion,
    versions:{
      loader:'raw-source-v1',
      architectureSemantic:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
      abiSemantic:AAPCS64_ABI.semanticVersion,
      semanticSchema:String(SEMANTIC_IR_SCHEMA_VERSION),
    },
    config:{ mode:'a64', region:{ start:'0x1000', length:4 } },
    upstreamArtifactIds,
  });
}

function semanticProducer(source, counter) {
  return async ({ signal, budget }) => {
    counter.count++;
    const page = await readArtifactPage(source, { offset:0n, length:4, signal, budget, maxPageBytes:4 });
    assert.deepEqual([...page.bytes], [...codeBytes], 'real source bytes must be consumed by the production route');
    budget.consume('workUnits', 1);
    const instructionId = `${functionId}:0x1000`;
    const decoded = {
      instructionId, mnemonic:'add', operands:'x0, x1, x2', ops:parseOperands('x0, x1, x2'),
      address:0x1000n, mode:'a64', origin:{ instructionIds:[instructionId], byteRanges:[{ offset:0, length:4 }] },
    };
    const effects = liftArm64MachineEffects(decoded, { signal });
    assert.equal(effects.completeness, 'exact');
    const semantic = lowerMachineEffectBundleToSemanticIr(effects, { functionId, blockId }, { signal });
    validateSemanticIrFunction(semantic, { signal });
    return semantic;
  };
}

const persistentEntries = new Map();
let source = new InstrumentedByteSource(new MemoryByteSource(codeBytes));
let store = new ArtifactStore({ backend:new MemoryArtifactBackend({ entries:persistentEntries }), hotCache:new ArtifactHotCache({ maxBytes:1024 * 1024, maxEntries:8 }) });
let scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
let invocations = { count:0 };
const v1 = semanticDescriptor('1');
const requestV1 = { descriptor:v1, priority:'foreground', produce:semanticProducer(source, invocations) };

// Cold production: real source -> MachineEffects -> Phase 3 Semantic IR -> ArtifactStore.
const cold = await scheduler.request(requestV1);
assert.equal(cold.reused, false);
assert.equal(invocations.count, 1);
assert.equal(source.metrics().totalRequested, 4);
const coldCanonical = canonicalSerializeSemanticIr(cold.payload);

// Hot hit requires no producer work.
const hot = await scheduler.request(requestV1);
assert.equal(hot.reused, true);
assert.equal(hot.source, 'hot');
assert.equal(invocations.count, 1);

// Explicit hot eviction, context/store recreation, same ArtifactId: no producer work.
store.evictHot(v1.artifactId);
await store.close();
source = new InstrumentedByteSource(new MemoryByteSource(codeBytes));
store = new ArtifactStore({ backend:new MemoryArtifactBackend({ entries:persistentEntries }), hotCache:new ArtifactHotCache({ maxBytes:1024 * 1024, maxEntries:8 }) });
scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
invocations = { count:0 };
const warm = await scheduler.request({ descriptor:v1, priority:'foreground', produce:semanticProducer(source, invocations) });
assert.equal(warm.reused, true);
assert.equal(invocations.count, 0, 'warm reopen must not rerun an unchanged producer');
assert.equal(source.metrics().totalRequested, 0, 'warm reopen must not reread source for a reused artifact');
assert.equal(canonicalSerializeSemanticIr(warm.payload), coldCanonical, 'cold/warm semantic payloads must be observationally identical');

// Producer/pass version changes identity and forces exactly one rerun.
const v2 = semanticDescriptor('2');
assert.notEqual(v2.artifactId, v1.artifactId);
const versionMiss = await scheduler.request({ descriptor:v2, priority:'foreground', produce:semanticProducer(source, invocations) });
assert.equal(versionMiss.reused, false);
assert.equal(invocations.count, 1);

// Record a dependent artifact, then invalidate/delete its upstream: stale dependent cannot hit.
const dependent = createArtifactDescriptor({
  binaryId, sliceId, entityId:functionId, artifactKind:'semantic-summary', producerId:'phase4-dependent-fixture', producerVersion:'1',
  versions:{ loader:'raw-source-v1', architectureSemantic:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, abiSemantic:AAPCS64_ABI.semanticVersion, semanticSchema:String(SEMANTIC_IR_SCHEMA_VERSION) },
  config:{ summary:'node-count' }, upstreamArtifactIds:[v2.artifactId],
});
let dependentInvocations = 0;
const dependentResult = await scheduler.request({
  descriptor:dependent,
  dependencies:[{ descriptor:v2, produce:semanticProducer(source, { count:0 }), priority:'foreground' }],
  produce:async ({ dependencies, budget }) => { dependentInvocations++; budget.consume('workUnits', 1); return { nodeCount:dependencies[0].payload.nodes.length }; },
});
assert.equal(dependentResult.reused, false);
assert.deepEqual(scheduler.dependencyIds(dependent.artifactId), [v2.artifactId]);
await store.delete(v2.artifactId);
store.evictHot(dependent.artifactId);
const stale = await store.get(dependent);
assert.equal(stale.status, 'miss');
assert.equal(stale.reason, 'missing-upstream');

// Request coalescing: 100 callers of one missing ArtifactId share one producer.
const coalescedDescriptor = createArtifactDescriptor({
  binaryId, sliceId, artifactKind:'coalescing-proof', producerId:'phase4-coalescing', producerVersion:'1',
  versions:{ loader:'1' }, relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false }, config:{ test:true },
});
let coalescedInvocations = 0;
const coalescedRequest = {
  descriptor:coalescedDescriptor,
  priority:'current',
  produce:async ({ budget }) => { coalescedInvocations++; budget.consume('workUnits', 1); await Promise.resolve(); return { ok:true }; },
};
const coalesced = await Promise.all(Array.from({ length:100 }, () => scheduler.request(coalescedRequest)));
assert.equal(coalescedInvocations, 1);
assert.equal(coalesced.length, 100);

// Cancellation must stop the producer and publish no partial artifact.
const cancelledDescriptor = createArtifactDescriptor({
  binaryId, sliceId, artifactKind:'cancel-proof', producerId:'phase4-cancel', producerVersion:'1',
  versions:{ loader:'1' }, relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false }, config:{ test:true },
});
const controller = new AbortController();
let readsAfterCancel = 0;
const cancelPromise = scheduler.request({
  descriptor:cancelledDescriptor, signal:controller.signal, priority:'foreground',
  produce:async ({ signal, budget }) => {
    for (let i=0;i<100;i++) {
      budget.consume('workUnits', 1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (signal.aborted) throw signal.reason;
      readsAfterCancel++;
      if (i === 1) controller.abort(new DOMException('test cancellation', 'AbortError'));
    }
    return { partial:true };
  },
});
await assert.rejects(cancelPromise, (error) => error?.name === 'AbortError');
const readsAtCancel = readsAfterCancel;
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(readsAfterCancel, readsAtCancel, 'cancelled producer must stop boundedly rather than continue zombie work');
store.evictHot(cancelledDescriptor.artifactId);
const cancelledMiss = await store.get(cancelledDescriptor);
assert.equal(cancelledMiss.status, 'miss');
assert.equal(await store.backend.has(cancelledDescriptor.artifactId), false, 'cancelled residue must not be publishable');

console.log('phase4 real walking skeleton: PASS');
