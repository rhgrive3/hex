import assert from 'node:assert/strict';
import { ScopeController } from '../js/ai/control/scope.js';
import { createTurnSnapshot } from '../js/ai/control/snapshot.js';
import { assertLiveBindingsUnchanged, memoryAnchor, sessionMatchesSnapshot } from '../js/ai/control/runtime-support.js';
import { selectToolWindow } from '../js/ai/control/tool-window.js';

const snapshot = {
  binaryId: 'content:hash-a:0',
  binaryIdentity: { id: 'content:hash-a:0', kind: 'content-derived', hash: 'hash-a', legacyId: 'app:0', confidence: 'strong', state: 'ready' },
  legacyBinaryId: 'app:0',
  projectIdentity: 'project-a',
  runtimeSessionIdentity: 'runtime-a',
  runtimeSessionState: 'bound',
  currentFunction: { address: '0x1000', range: { start: '0x1000', end: '0x1100' } },
  selection: null,
};

// Control-layer address extraction must cover camelCase tool contracts, not
// depend on ToolRegistry's separate address validation as a backstop.
const functionScope = new ScopeController(snapshot, 'function');
assert.equal(functionScope.scopeAllowsTool('function', 'lookup_signature', { functionAddress: '0x1010' }), true);
assert.equal(functionScope.scopeAllowsTool('function', 'lookup_signature', { functionAddress: '0x2000' }), false);
assert.throws(() => functionScope.assertToolCall('lookup_signature', { targetAddress: '0x2000' }), /scope/i);
assert.equal(functionScope.scopeContainsAddress('function', '0x10ff'), true, 'last byte before exclusive function end stays in scope');
assert.equal(functionScope.scopeContainsAddress('function', '0x1100'), false, 'exclusive function end must not admit the next function start');

// ProgramIndex may use executable-region end as a display/analysis fallback
// when the exact function end is unknown. TurnSnapshot must prefer the exact
// SymbolIndex boundary source so function scope does not inherit that widening.
const unknownEndSnapshot = createTurnSnapshot({
  currentAddress: 0x2000n,
  binaryFingerprint: { hash: 'range-test' },
  symbols: { functionAt: () => ({ start: 0x2000n, end: null }) },
  program: { functionRange: () => ({ start: 0x2000n, end: 0x9000n }) },
}, { scope: 'function' });
assert.equal(unknownEndSnapshot.currentFunction.range.start, '0x2000');
assert.equal(unknownEndSnapshot.currentFunction.range.end, null, 'unknown exact end must not become executable-region end');
const unknownEndScope = new ScopeController(unknownEndSnapshot, 'function');
assert.equal(unknownEndScope.scopeContainsAddress('function', '0x2000'), true);
assert.equal(unknownEndScope.scopeContainsAddress('function', '0x2004'), false, 'unknown function end fails closed instead of widening to the region');

// Bound project/runtime identities are part of the investigation boundary.
// Closing or replacing either during a turn must fail closed.
const liveSame = {
  binaryIdentity: snapshot.binaryIdentity,
  projectId: 'project-a',
  runtimeSessionId: 'runtime-a',
  runtimeSessionKnown: true,
};
assert.doesNotThrow(() => assertLiveBindingsUnchanged(liveSame, snapshot));
assert.throws(() => assertLiveBindingsUnchanged({ ...liveSame, projectId: null }, snapshot), /project changed/i);
assert.throws(() => assertLiveBindingsUnchanged({ ...liveSame, runtimeSessionId: null }, snapshot), /runtime session changed/i);
assert.throws(() => assertLiveBindingsUnchanged({ ...liveSame, runtimeSessionId: 'runtime-b' }, snapshot), /runtime session changed/i);

// A runtime session may be created lazily by this turn if the start snapshot
// had never observed one. The observed ID is then promoted into the memory
// anchor so the next turn can enforce it.
const runtimeUnknown = { ...snapshot, runtimeSessionIdentity: null, runtimeSessionState: 'unknown' };
assert.doesNotThrow(() => assertLiveBindingsUnchanged({ ...liveSame, runtimeSessionId: 'runtime-new' }, runtimeUnknown));
const promotedAnchor = memoryAnchor(runtimeUnknown, 'runtime', { ...liveSame, runtimeSessionId: 'runtime-new' });
assert.equal(promotedAnchor.runtimeSessionState, 'bound');
assert.equal(promotedAnchor.runtimeSessionId, 'runtime-new');
const promotedSession = { binaryId: snapshot.binaryId, binaryIdentity: snapshot.binaryIdentity, projectId: 'project-a', investigationMemory: { anchor: promotedAnchor } };
assert.equal(sessionMatchesSnapshot(promotedSession, { ...snapshot, runtimeSessionIdentity: 'runtime-new', runtimeSessionState: 'bound' }), true);
assert.equal(sessionMatchesSnapshot(promotedSession, { ...snapshot, runtimeSessionIdentity: 'runtime-other', runtimeSessionState: 'bound' }), false);

const persistedSession = {
  binaryId: snapshot.binaryId,
  binaryIdentity: snapshot.binaryIdentity,
  projectId: 'project-a',
  investigationMemory: { anchor: { runtimeSessionId: 'runtime-a', runtimeSessionState: 'bound' } },
};
assert.equal(sessionMatchesSnapshot(persistedSession, snapshot), true);
assert.equal(sessionMatchesSnapshot(persistedSession, { ...snapshot, projectIdentity: null }), false);
assert.equal(sessionMatchesSnapshot(persistedSession, { ...snapshot, runtimeSessionIdentity: null, runtimeSessionState: 'unknown' }), false);

// Some historical persistence shapes contain binaryIdentity but no binaryId.
// A strong identity must still bind the session rather than being treated as
// an unbound wildcard.
const otherIdentity = { ...snapshot.binaryIdentity, id: 'content:hash-b:0', hash: 'hash-b' };
assert.equal(sessionMatchesSnapshot({ ...persistedSession, binaryId: null }, snapshot), true);
assert.equal(sessionMatchesSnapshot({ ...persistedSession, binaryId: null, binaryIdentity: otherIdentity }, snapshot), false);

// Future ToolRegistry additions stay reachable without teaching the control
// plane their names. Scope filtering happens before the rotating novel slots.
const baseTools = ['get_current_function','get_selection_context','get_semantic_facts','trace_value','get_cfg','get_callers','get_callees']
  .map((name) => ({ name, description: name, inputSchema: { type: 'object' }, scopeSupport: ['function'], cost: 'cheap' }));
const novelTools = ['future_probe_a','future_probe_b','future_probe_c']
  .map((name) => ({ name, description: name, inputSchema: { type: 'object' }, scopeSupport: ['function'], cost: 'cheap' }));
const growingRegistry = {
  definitionsForModel({ scope } = {}) {
    return [...baseTools, ...novelTools].filter((tool) => scope === 'auto' || tool.scopeSupport.includes(scope));
  },
};
const firstWindow = selectToolWindow(growingRegistry, { effectiveScope: 'function', intent: 'explain-current-function', maxTools: 8, observations: [] });
assert.ok(firstWindow.tools.some((tool) => tool.name === 'future_probe_a'));
assert.ok(firstWindow.tools.some((tool) => tool.name === 'future_probe_b'));
const rotatedWindow = selectToolWindow(growingRegistry, { effectiveScope: 'function', intent: 'explain-current-function', maxTools: 8, observations: [{ tool: 'get_current_function' }, { tool: 'get_cfg' }] });
assert.ok(rotatedWindow.tools.some((tool) => tool.name === 'future_probe_c'), 'new scope-valid tools rotate into the bounded model window');
assert.ok(rotatedWindow.tools.length <= 8);

console.log('ai-scope-hardening: PASS');
