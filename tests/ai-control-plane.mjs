import assert from 'node:assert/strict';
import { createTurnSnapshot, createSnapshotContext, resolveBinaryIdentity } from '../js/ai/control/snapshot.js';
import { ScopeController } from '../js/ai/control/scope.js';
import { sessionMatchesSnapshot, assertLiveBindingsUnchanged } from '../js/ai/control/runtime-support.js';
import { routeIntent, shouldRunPlanner } from '../js/ai/routing/intent.js';
import { selectToolWindow } from '../js/ai/control/tool-window.js';
import { assertWireBudget, measureWirePayload } from '../js/ai/budget/wire.js';
import { ContextBroker } from '../js/ai/context/broker.js';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';

// A: current UI navigation after turn start cannot move the turn anchor.
let current = 0x1000n;
const local = {
  binaryFingerprint: { algorithm: 'fnv1a64', hash: 'abc123' }, sliceIndex: 0,
  get currentAddress() { return current; },
  activeFunction: { address: 0x1000n, start: 0x1000n, end: 0x10ffn, name: 'A' },
  selection: { start: 0x1008n, end: 0x100cn, instructions: [{ address: 0x1008n, mnemonic: 'mov', operands: 'x8, x0' }] },
};
const snap = createTurnSnapshot(local, { scope: 'auto' });
const scope = new ScopeController(snap, 'auto');
const frozenLocal = createSnapshotContext(local, snap, scope);
current = 0x2000n;
assert.equal(frozenLocal.currentAddress, 0x1000n);
assert.equal(snap.currentFunction.address, '0x1000');
assert.equal(Object.isFrozen(snap), true);

// B: content identity prevents same-name/old-session collisions across binaries.
assert.notEqual(
  resolveBinaryIdentity({ binaryFingerprint: { hash: 'A' }, binaryId: 'same.ipa:0' }).id,
  resolveBinaryIdentity({ binaryFingerprint: { hash: 'B' }, binaryId: 'same.ipa:0' }).id,
);
assert.equal(snap.binaryIdentity.kind, 'content-derived');
const identityA = resolveBinaryIdentity({ binaryFingerprint: { hash: 'A' }, binaryId: 'same.ipa:0' });
const identityB = resolveBinaryIdentity({ binaryFingerprint: { hash: 'B' }, binaryId: 'same.ipa:0' });
const snapshotA = { binaryId: identityA.id, binaryIdentity: identityA, legacyBinaryId: identityA.legacyId, projectIdentity: null };
const snapshotB = { binaryId: identityB.id, binaryIdentity: identityB, legacyBinaryId: identityB.legacyId, projectIdentity: null };
assert.equal(sessionMatchesSnapshot({ binaryId: identityA.id, binaryIdentity: identityA }, snapshotB), false, 'same legacy name must not equate different strong content identities');
assert.equal(sessionMatchesSnapshot({ binaryId: 'same.ipa:0' }, snapshotB), true, 'legacy-only sessions remain upgrade-compatible');
assert.throws(() => assertLiveBindingsUnchanged({ binaryIdentity: identityB }, snapshotA), /binary changed/i, 'mid-turn same-name binary replacement must fail closed');

// B2: UI bridge rebinds a stale session once, but never bypasses a live scope/binding failure via local fallback.
const bridgeCalls = [];
let bridgeTurn = 0;
const bridgeApp = { store: { get() { return null; } } };
const bridge = createAiEngine(bridgeApp, {
  loadCore: async () => ({
    async turn(input) {
      bridgeCalls.push(input.sessionId ?? null);
      bridgeTurn++;
      if (bridgeTurn === 1) return { sessionId: 'old-session', answer: 'first' };
      if (bridgeTurn === 2) {
        const error = new Error('The requested AI session belongs to a different binary or project.');
        error.type = 'scope_violation';
        throw error;
      }
      if (bridgeTurn === 3) return { sessionId: 'new-session', answer: 'second' };
      const error = new Error('The binary changed while this AI turn was running; refusing to mix workbench states.');
      error.type = 'scope_violation';
      throw error;
    },
  }),
});
const bridgeInput = { question: 'explain', mode: 'chat', style: 'analyst', scope: 'auto', context: {}, onActivity() {} };
await bridge.run(bridgeInput);
await bridge.run(bridgeInput);
assert.deepEqual(bridgeCalls.slice(0, 3), [null, 'old-session', null], 'stale session is retried exactly once as a new session');
await assert.rejects(() => bridge.run(bridgeInput), /binary changed/i, 'safety-boundary failures must not fall through to live local analysis');

// C/D: address-level explicit scope enforcement.
const fnSnap = { ...snap, selection: null };
const fnScope = new ScopeController(fnSnap, 'function');
assert.equal(fnScope.scopeContainsAddress('function', 0x1010n), true);
assert.equal(fnScope.scopeContainsAddress('function', 0x2000n), false);
assert.throws(() => fnScope.assertToolCall('get_function', { address: '0x2000' }), /scope/i);
const selScope = new ScopeController(snap, 'selection');
assert.equal(selScope.scopeAllowsTool('selection', 'get_current_function', {}), false);
assert.throws(() => selScope.assertToolCall('get_semantic_facts', { functionAddress: '0x1000' }), /scope/i);

// E/F: auto starts narrow and expands deterministically only for broad intent.
const auto = new ScopeController(snap, 'auto');
assert.equal(auto.effectiveScope, 'selection');
auto.ensureForIntent('explain-selection');
assert.equal(auto.effectiveScope, 'selection');
auto.ensureForIntent('find-behaviour');
assert.equal(auto.effectiveScope, 'binary');
assert.equal(auto.expansions.length, 1);

// G/H: phase-specific windows stay small but discovery can reach deep tools.
const names = ['search_functions','search_strings','lookup_known_function','lookup_signature','get_function','get_current_function','get_selection_context','get_semantic_facts','trace_value','get_cfg','get_callers','get_callees','get_related_functions','verify_field_update','get_runtime_observations','verify_runtime_hypothesis'];
const registry = { definitionsForModel: ({ scope } = {}) => names.filter((name) => !(scope === 'selection' && ['get_current_function','get_semantic_facts','get_cfg','trace_value'].includes(name))).map((name) => ({ name, inputSchema: { type: 'object' } })) };
const currentWindow = selectToolWindow(registry, { effectiveScope: 'function', intent: 'explain-current-function', maxTools: 8 });
assert.equal(currentWindow.phase, 'current');
assert.ok(currentWindow.tools.length <= 8);
assert.ok(currentWindow.tools.some((tool) => tool.name === 'get_current_function'));
const autoEscape = selectToolWindow(registry, { requestedScope: 'auto', effectiveScope: 'function', intent: 'unknown', maxTools: 9 });
assert.ok(autoEscape.tools.some((tool) => tool.name === 'search_functions'), 'Auto has a bounded escape hatch that can trigger controlled expansion');
const selectionWindow = selectToolWindow(registry, { requestedScope: 'auto', effectiveScope: 'selection', intent: 'explain-selection', maxTools: 9 });
assert.ok(selectionWindow.tools.some((tool) => tool.name === 'search_functions'));
assert.equal(selectionWindow.tools.some((tool) => tool.name === 'get_current_function'), false, 'Auto escape must not leak unrelated full-function tools into selection scope');
const discovery = selectToolWindow(registry, { effectiveScope: 'binary', intent: 'find-function', maxTools: 9 });
assert.equal(discovery.phase, 'discovery');
assert.ok(discovery.tools.some((tool) => tool.name === 'search_functions'));
assert.ok(discovery.tools.some((tool) => tool.name === 'get_function'), 'search result can be followed by a function read');
const verification = selectToolWindow(registry, { effectiveScope: 'binary', intent: 'find-function', observations: [{ tool: 'search_functions' }, { tool: 'get_function' }], hypotheses: [{ missingEvidence: ['verify'] }], maxTools: 8 });
assert.equal(verification.phase, 'verification');
assert.ok(verification.tools.some((tool) => tool.name === 'verify_field_update'));
const continuity = selectToolWindow(registry, { effectiveScope: 'binary', intent: 'unknown', observations: [{ tool: 'search_functions' }, { tool: 'search_functions' }], maxTools: 8 });
assert.equal(continuity.phase, 'verification');
assert.ok(continuity.tools.some((tool) => tool.name === 'search_functions'), 'phase transition retains the previous scope-valid tool so loop detection stays deterministic');

// I/J: cheap routing controls planner invocation.
assert.equal(routeIntent('この関数のx8は何？', fnSnap), 'trace-value');
assert.equal(shouldRunPlanner({ mode: 'agent', goal: 'この関数のx8は何？' }, fnSnap, 'trace-value'), false);
assert.equal(shouldRunPlanner({ mode: 'agent', goal: 'XPを増やしている場所を探して' }, fnSnap, 'find-behaviour'), true);

// K: provider runtime can carry transcript exactly once (top-level messages).
const sessionLike = { messages: [{ role: 'user', content: 'one' }], investigationMemory: { goal: 'one', anchor: null, confirmedFacts: [], activeHypotheses: [], rejectedHypotheses: [], unresolvedQuestions: [], userConstraints: [], importantPriorActions: [] } };
const broker = new ContextBroker(frozenLocal);
const built = broker.buildModelContext({ request: { mode: 'agent', style: 'analyst', scope: 'function' }, session: sessionLike, snapshot: fnSnap, effectiveScope: 'function', includeHistory: false });
assert.equal('recentMessages' in built.context, false);
assert.equal('goal' in built.context.request, false);

// L: structured investigation state survives session updates and identity upgrades stay coherent.
const sessions = new InvestigationSessionStore();
const created = await sessions.create({ binaryId: 'content:A', goal: 'trace XP' });
await sessions.updateMemory(created.id, { confirmedFacts: [{ id: 'e1', summary: 'write' }], unresolvedQuestions: ['caller?'] });
const persisted = await sessions.get(created.id);
assert.equal(persisted.investigationMemory.confirmedFacts[0].id, 'e1');
assert.deepEqual(persisted.investigationMemory.unresolvedQuestions, ['caller?']);
const legacySession = await sessions.create({ binaryId: 'same.ipa:0', goal: 'legacy' });
await sessions.update(legacySession.id, { binaryIdentity: identityB });
const upgraded = await sessions.get(legacySession.id);
assert.equal(upgraded.binaryId, identityB.id, 'strong identity upgrade must synchronize binaryId');
assert.equal(sessionMatchesSnapshot(upgraded, snapshotB), true, 'upgraded session must remain usable on the next turn');

// M/N: budget is computed on full wire payload and rejects before transport.
const usage = measureWirePayload({ messages: [{ role: 'user', content: 'hello' }], context: { current: { address: '0x1000' } }, tools: [{ name: 'get_function', inputSchema: { type: 'object' } }] });
assert.ok(usage.wireBytes > usage.semanticContextBytes);
assert.ok(usage.wireBytes > usage.historyBytes);
assert.ok(usage.toolSchemaBytes > 0);
assert.throws(() => assertWireBudget({ messages: [{ role: 'user', content: 'x'.repeat(50000) }], context: {}, tools: [] }, { contextTokens: 100000, maxOutputTokens: 1, maxRequestBytes: 16384 }), /payload/i);

console.log('ai-control-plane: PASS');
