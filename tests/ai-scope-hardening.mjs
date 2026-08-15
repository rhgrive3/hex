import assert from 'node:assert/strict';
import { ScopeController } from '../js/ai/control/scope.js';
import { assertLiveBindingsUnchanged, sessionMatchesSnapshot } from '../js/ai/control/runtime-support.js';

const snapshot = {
  binaryId: 'content:hash-a:0',
  binaryIdentity: { id: 'content:hash-a:0', kind: 'content-derived', hash: 'hash-a', legacyId: 'app:0', confidence: 'strong', state: 'ready' },
  legacyBinaryId: 'app:0',
  projectIdentity: 'project-a',
  runtimeSessionIdentity: 'runtime-a',
  currentFunction: { address: '0x1000', range: { start: '0x1000', end: '0x10ff' } },
  selection: null,
};

// Control-layer address extraction must cover camelCase tool contracts, not
// depend on ToolRegistry's separate address validation as a backstop.
const functionScope = new ScopeController(snapshot, 'function');
assert.equal(functionScope.scopeAllowsTool('function', 'lookup_signature', { functionAddress: '0x1010' }), true);
assert.equal(functionScope.scopeAllowsTool('function', 'lookup_signature', { functionAddress: '0x2000' }), false);
assert.throws(() => functionScope.assertToolCall('lookup_signature', { targetAddress: '0x2000' }), /scope/i);

// Bound project/runtime identities are part of the investigation boundary.
// Closing or replacing either during a turn must fail closed.
const liveSame = {
  binaryIdentity: snapshot.binaryIdentity,
  projectId: 'project-a',
  runtimeSessionId: 'runtime-a',
};
assert.doesNotThrow(() => assertLiveBindingsUnchanged(liveSame, snapshot));
assert.throws(() => assertLiveBindingsUnchanged({ ...liveSame, projectId: null }, snapshot), /project changed/i);
assert.throws(() => assertLiveBindingsUnchanged({ ...liveSame, runtimeSessionId: null }, snapshot), /runtime session changed/i);
assert.throws(() => assertLiveBindingsUnchanged({ ...liveSame, runtimeSessionId: 'runtime-b' }, snapshot), /runtime session changed/i);

const persistedSession = {
  binaryId: snapshot.binaryId,
  binaryIdentity: snapshot.binaryIdentity,
  projectId: 'project-a',
  investigationMemory: { anchor: { runtimeSessionId: 'runtime-a' } },
};
assert.equal(sessionMatchesSnapshot(persistedSession, snapshot), true);
assert.equal(sessionMatchesSnapshot(persistedSession, { ...snapshot, projectIdentity: null }), false);
assert.equal(sessionMatchesSnapshot(persistedSession, { ...snapshot, runtimeSessionIdentity: null }), false);

// Some historical persistence shapes contain binaryIdentity but no binaryId.
// A strong identity must still bind the session rather than being treated as
// an unbound wildcard.
const otherIdentity = { ...snapshot.binaryIdentity, id: 'content:hash-b:0', hash: 'hash-b' };
assert.equal(sessionMatchesSnapshot({ ...persistedSession, binaryId: null }, snapshot), true);
assert.equal(sessionMatchesSnapshot({ ...persistedSession, binaryId: null, binaryIdentity: otherIdentity }, snapshot), false);

console.log('ai-scope-hardening: PASS');
