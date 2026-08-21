import assert from 'node:assert/strict';
import { ChangeLog, createCheckpoint, createProjectOperation, mergeOperations, replayOperations, restoreCheckpoint } from '../../../js/collaboration/index.js';

const base = { projectIdentity: 'hex-project:p', binaryIdentity: 'hex-binary:p:b:macho:arm64' };
const nameA = createProjectOperation({ ...base, operationId: 'op-a', targetEntityId: 'hex-entity:e', factKind: 'name', action: 'set', payload: 'alpha', authorIdentity: 'actor-a', timestampHint: '9999' });
const nameB = createProjectOperation({ ...base, operationId: 'op-b', targetEntityId: 'hex-entity:e', factKind: 'name', action: 'set', payload: 'beta', authorIdentity: 'actor-b', timestampHint: '0000' });
const comment = createProjectOperation({ ...base, operationId: 'op-c', targetEntityId: 'hex-entity:e', factKind: 'comment', action: 'add', payload: 'note' });
const log = new ChangeLog(base);
assert.equal(log.applyOperation(nameA).status, 'applied');
assert.equal(log.applyOperation(nameA).status, 'duplicate');
const reordered = new ChangeLog(base);
assert.equal(reordered.applyBatch([comment, nameB]).status, 'applied');
const ordered = new ChangeLog(base);
assert.equal(ordered.applyBatch([nameB, comment]).status, 'applied');
assert.equal(reordered.digest(), ordered.digest(), 'independent operation order must not change semantic state');
assert.equal(log.applyOperation(nameB).status, 'conflict');
assert.equal(log.snapshot().conflicts[0].type, 'meaningful-conflict');
assert.equal(log.snapshot().facts['hex-entity:e\u0000name'].values.length, 2);

const wrongProject = createProjectOperation({ ...nameA, operationId: 'wrong', projectIdentity: 'hex-project:other' });
const atomic = new ChangeLog(base);
const atomicResult = atomic.applyBatch([nameA, wrongProject]);
assert.equal(atomicResult.status, 'rejected');
assert.deepEqual(atomic.snapshot().facts, {});

const remove = createProjectOperation({ ...base, operationId: 'op-remove', targetEntityId: 'hex-entity:e', factKind: 'bookmark', action: 'remove', payload: true });
const tombstoneLog = new ChangeLog(base);
tombstoneLog.applyOperation(createProjectOperation({ ...base, operationId: 'bookmark-add', targetEntityId: 'hex-entity:e', factKind: 'bookmark', action: 'add', payload: true }));
assert.equal(tombstoneLog.applyOperation(remove).status, 'applied');
const resurrect = createProjectOperation({ ...base, operationId: 'bookmark-old-replay', targetEntityId: 'hex-entity:e', factKind: 'bookmark', action: 'add', payload: true });
assert.equal(tombstoneLog.applyOperation(resurrect).status, 'unresolved');
assert.equal(tombstoneLog.snapshot().facts['hex-entity:e\u0000bookmark'], undefined);

const checkpoint = createCheckpoint(log);
const restored = restoreCheckpoint(checkpoint, { ...base, operations: [nameA, nameB] });
assert.equal(restored.digest(), log.digest());
const withComment = new ChangeLog(base);
withComment.applyBatch([nameA, nameB, comment]);
const restoredWithComment = restoreCheckpoint(checkpoint, { ...base, operations: [nameA, nameB, comment] });
assert.equal(restoredWithComment.digest(), withComment.digest());
const replay = replayOperations({ ...base, operations: mergeOperations([nameA], [nameB, comment]) });
assert.equal(replay.status, 'applied');
assert.equal(replay.state.conflicts.length, 1);
console.log('[phase12] deterministic ChangeLog replay/conflict tests passed');
