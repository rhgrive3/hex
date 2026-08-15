import assert from 'node:assert/strict';
import {
  createBinaryId, createSliceId, createImageId, createArtifactId, createEntityId,
  createFunctionId, createInstructionId, createVmOperationId, createEvidenceId,
  createRuntimeSessionId,
} from '../js/core/identity/index.js';
import { createOriginSet, mergeOriginSets, createTransformRecord } from '../js/core/identity/origin.js';
import { createAnalysisSnapshot, createDeterminismMetadata } from '../js/core/identity/snapshot.js';

const bytes = new TextEncoder().encode('same binary content');
const binaryA = await createBinaryId(bytes);
const binaryB = await createBinaryId(bytes.slice());
assert.equal(binaryA, binaryB, 'binary identity must depend on content, not filename or object identity');

const slice = createSliceId({ binaryId: binaryA, index: 0, architecture: 'arm64' });
assert.equal(slice, createSliceId({ architecture: 'arm64', index: 0, binaryId: binaryA }), 'slice id must be deterministic');
const image = createImageId({ binaryId: binaryA, sliceId: slice, loaderId: 'macho', imageBase: 0x100000000n });
assert.equal(image, createImageId({ imageBase: '0x100000000', loaderId: 'macho', sliceId: slice, binaryId: binaryA }));

const functionId = createFunctionId({ binaryId: binaryA, sliceId: slice, canonicalStartIdentity: 0x100001000n });
assert.equal(functionId, createFunctionId({ sliceId: slice, binaryId: binaryA, canonicalStartIdentity: 0x100001000n }));
const instructionId = createInstructionId({ binaryId: binaryA, sliceId: slice, virtualAddress: 0x100001004n, decodeMode: 'arm64', decoderSemanticVersion: '1' });
assert.equal(instructionId, createInstructionId({ decoderSemanticVersion: '1', virtualAddress: '0x100001004', binaryId: binaryA, decodeMode: 'arm64', sliceId: slice }));
assert.ok(createVmOperationId({ binaryId: binaryA, sliceId: slice, vm: 'dex', methodId: 'm1', operationOffset: 7, semanticVersion: '1' }).startsWith('operation_'));
assert.ok(createEntityId({ binaryId: binaryA, sliceId: slice, kind: 'value', identity: { index: 1 } }).startsWith('entity_'));
assert.ok(createEvidenceId({ binaryId: binaryA, kind: 'semantic', identity: { value: 1 } }).startsWith('evidence_'));
assert.ok(createRuntimeSessionId({ binaryId: binaryA, provider: 'fake', targetIdentity: { pid: 123 }, sessionNonce: 'run-1' }).startsWith('runtime_'));
assert.ok(createArtifactId({ binaryId: binaryA, sliceId: slice, entityId: functionId, passId: 'cfg', passVersion: '1', inputArtifactIds: ['a','b'] }).startsWith('artifact_'));

const transform = createTransformRecord({
  passId: 'fold', passVersion: '1', ruleId: 'add-zero', consumedEntityIds: ['e1'], producedEntityIds: ['e2'],
  preconditions: ['rhs-is-zero'], proofKind: 'algebraic', timestampOrBuildId: 'build-1',
});
const left = createOriginSet({
  byteRanges: [{ binaryId: binaryA, offset: 10n, length: 4n }],
  virtualRanges: [{ imageId: image, address: 0x100001000n, length: 4n }],
  instructionIds: [instructionId], parentEntityIds: ['parent-a'], transforms: [transform],
});
const right = createOriginSet({
  byteRanges: [{ binaryId: binaryA, offset: 20n, length: 8n }],
  operationIds: ['vm-op-1'], parentEntityIds: ['parent-b'],
});
const merged = mergeOriginSets(left, right);
assert.equal(merged.byteRanges.length, 2, 'origin merge must not drop byte ranges');
assert.deepEqual(merged.parentEntityIds, ['parent-a', 'parent-b']);
assert.deepEqual(merged.operationIds, ['vm-op-1']);
assert.equal(merged.transforms.length, 1);
assert.ok(Object.isFrozen(merged));
assert.ok(Object.isFrozen(merged.byteRanges));
assert.throws(() => merged.byteRanges.push({}), TypeError);
assert.doesNotThrow(() => JSON.stringify(merged), 'origin schema must be serialization-safe');
assert.throws(() => createOriginSet({ byteRanges: [{ offset: 10, length: -1 }] }), /origin-invalid-byte-range/);

const artifactId = createArtifactId({ binaryId: binaryA, sliceId: slice, passId: 'ssa', passVersion: '2' });
const determinism = createDeterminismMetadata({
  engineBuild: 'test-build', schemaVersion: '1', passVersions: { ssa: '2' }, targetSemanticVersions: { arm64: '1' },
  optionsHash: 'opts', inputArtifactIds: ['input-b','input-a'], outputArtifactId: artifactId,
});
const snapshot = createAnalysisSnapshot({
  binaryId: binaryA, projectRevision: '7', artifactVersions: { [artifactId]: '2' }, analysisEpoch: '11', createdAt: '2026-08-16T00:00:00.000Z',
});
assert.ok(Object.isFrozen(determinism));
assert.ok(Object.isFrozen(snapshot));
assert.equal(snapshot.snapshotId, createAnalysisSnapshot({ binaryId: binaryA, projectRevision: '7', artifactVersions: { [artifactId]: '2' }, analysisEpoch: '11', createdAt: 'different-time' }).snapshotId,
  'snapshot identity must be based on analysis state, not wall-clock metadata');
assert.doesNotThrow(() => JSON.stringify({ determinism, snapshot }));

console.log('core identity contracts: ok');
