import assert from 'node:assert/strict';
import { PatchSet } from '../js/patch.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ProposalStore } from '../js/ai/proposals.js';
import { validateSchema } from '../js/ai/validation.js';
import { requestJSON } from '../js/ai/transport.js';
import { ContextBroker } from '../js/ai/context/broker.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';
import { AIRuntime } from '../js/ai/runtime.js';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';
import { demangleCxx } from '../js/rtti.js';
import { demangleSwiftSymbol } from '../js/swift.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok', name); }
  catch (error) { console.error('not ok', name); throw error; }
}

await test('PatchSet rejects same/partial/contained overlaps', () => {
  const p = new PatchSet();
  p.add(10n, [1,2,3,4], [9,9,9,9]);
  assert.throws(() => p.add(10n, [1], [2]), /既にパッチ|重な/);
  assert.throws(() => p.add(12n, [3], [4]), /重な/);
  assert.throws(() => p.add(9n, [0,1,2], [0,1,2]), /重な/);
});

await test('PatchSet verifies variable-length source and applies against original offsets', async () => {
  const p = new PatchSet();
  p.add(1n, [2,3], [9]);
  const result = new Uint8Array(await (await p.apply(new Blob([Uint8Array.from([1,2,3,4])]))).arrayBuffer());
  assert.deepEqual([...result], [1,9,4]);
  await assert.rejects(() => p.apply(new Blob([Uint8Array.from([1,2,8,4])])), /元のバイト/);
  assert.throws(() => new PatchSet().add(1n, [], [9]), /元バイト/);
});

await test('PatchSet streams unchanged ranges instead of materializing the whole input', async () => {
  const source = new Blob([new Uint8Array(2 * 1024 * 1024)]);
  const reads = [];
  const file = {
    size: source.size,
    slice(start, end) {
      const blob = source.slice(start, end);
      const original = blob.arrayBuffer.bind(blob);
      blob.arrayBuffer = async () => { reads.push(blob.size); return original(); };
      return blob;
    },
  };
  const p = new PatchSet();
  p.add(1024n, [0,0,0,0], [1,2,3,4]);
  await p.apply(file);
  assert.deepEqual(reads, [4]);
});

await test('PatchSet address lookup canonicalizes bigint/number/hex string', () => {
  const p = new PatchSet();
  const item = p.add(0n, [1], [2], { addr: '0x1000' });
  assert.equal(p.byAddress(4096n), item);
  assert.equal(p.byAddress(4096), item);
  assert.equal(p.byAddress('0x1000'), item);
});

await test('EvidenceStore keeps verified records immutable on colliding IDs', () => {
  const store = new EvidenceStore();
  const [verified] = store.ingest('verifier', { id: 'row', address: '0x10', verified: true }, { verifier: true });
  assert.equal(verified.status, 'verified');
  const before = structuredClone(verified);
  store.add({ id: verified.id, sourceTool: 'other', kind: 'other', address: '0x20', title: 'changed', sourceData: { changed: true } });
  assert.deepEqual(store.get(verified.id), before);
});

await test('Verifier top-level verdict never bulk-promotes rows', () => {
  const store = new EvidenceStore();
  const rows = store.ingest('verifier', { verified: true, results: [
    { id: 'primary', address: '0x10' }, { id: 'aux', address: '0x20' },
  ] }, { verifier: true });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.status === 'supported'));
  const granular = store.ingest('verifier', { results: [{ id: 'proved', address: '0x30', verified: true }, { id: 'hint', address: '0x40' }] }, { verifier: true });
  assert.equal(granular.find((x) => x.address === '0x30')?.status, 'verified');
  assert.equal(granular.find((x) => x.address === '0x40')?.status, 'supported');
});

await test('Planner only promotes explicitly proven source evidence', () => {
  const store = new EvidenceStore();
  const rows = store.ingestPlan({ best: { address: 0x1000n }, candidates: [{
    address: 0x1000n, name: 'best', score: 1, sources: ['a','b'], evidence: ['a','b'],
    verification: { verified: true, verifiedEvidenceIds: ['a'] },
  }] });
  const bySource = new Map(rows.map((row) => [row.sourceData?.sources?.[0] ?? row.summary, row]));
  assert.equal(rows.filter((x) => x.status === 'verified').length, 1);
  assert.equal(rows.filter((x) => x.status === 'supported').length, 1);
});

await test('Evidence namespaces isolate binary + session', () => {
  const store = new EvidenceStore();
  store.setScope({ binaryId: 'A', sessionId: 's1' });
  store.add({ id: 'same', sourceTool: 'x', kind: 'fact', address: '0x10' });
  assert.ok(store.get('same'));
  store.setScope({ binaryId: 'B', sessionId: 's2' });
  assert.equal(store.get('same'), null);
  assert.equal(store.all().length, 0);
});

await test('Proposal approval is single-flight', async () => {
  const evidence = new EvidenceStore();
  evidence.add({ id: 'e', sourceTool: 'test', kind: 'fact' });
  const store = new ProposalStore({ evidenceStore: evidence });
  const proposal = store.create({ kind: 'rename', evidenceIds: ['e'], before: { name: 'a' }, after: { name: 'b' } });
  const { approvalToken } = store.approve(proposal.id);
  let mutations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = store.apply(proposal.id, { approvalToken, currentState: { name: 'a' }, apply: async () => { mutations++; await gate; } });
  await Promise.resolve();
  await assert.rejects(() => store.apply(proposal.id, { approvalToken, currentState: { name: 'a' }, apply: async () => { mutations++; } }));
  release(); await first;
  assert.equal(mutations, 1);
});

await test('Proposal stale fingerprint sees array fields beyond display truncation', async () => {
  const evidence = new EvidenceStore(); evidence.add({ id: 'e', sourceTool: 'test', kind: 'fact' });
  const store = new ProposalStore({ evidenceStore: evidence });
  const before = { rows: Array.from({ length: 1002 }, (_, i) => i) };
  const proposal = store.create({ kind: 'comment', evidenceIds: ['e'], before, after: { ok: true } });
  const { approvalToken } = store.approve(proposal.id);
  const current = structuredClone(before); current.rows[1001] = -1;
  let called = false;
  await assert.rejects(() => store.apply(proposal.id, { approvalToken, currentState: current, apply: async () => { called = true; } }), /changed/);
  assert.equal(called, false);
});

await test('JSON schema rejects NaN and infinities as numbers', () => {
  const schema = { type: 'number', minimum: 0, maximum: 1 };
  assert.equal(validateSchema(NaN, schema).ok, false);
  assert.equal(validateSchema(Infinity, schema).ok, false);
  assert.equal(validateSchema(-Infinity, schema).ok, false);
  assert.equal(validateSchema(0.5, schema).ok, true);
});

await test('Transport never starts fetch for a pre-aborted signal', async () => {
  const c = new AbortController(); c.abort('cancelled'); let calls = 0;
  await assert.rejects(() => requestJSON('https://invalid', {}, { signal: c.signal, fetchImpl: async () => { calls++; throw new Error('must not run'); } }), /cancelled/i);
  assert.equal(calls, 0);
});

await test('Transport enforces response byte cap before JSON materialization', async () => {
  const huge = JSON.stringify({ value: 'x'.repeat(5000) });
  await assert.rejects(() => requestJSON('https://local', {}, {
    maxResponseBytes: 1024,
    fetchImpl: async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } }),
  }), (error) => error?.type === 'context_too_large');
});

await test('Selection scope exposes only selection plus containing-function identity', () => {
  const broker = new ContextBroker({
    binaryId: 'b', selection: { instructions: [{ address: 0x1000n, mnemonic: 'mov', operands: 'x0, x1' }] },
    currentFunction: { address: 0x1000n, name: 'f', instructions: [{ address: 0x1000n }, { address: 0x1004n }], pseudocode: 'secret outside selection' },
  });
  const current = broker.currentProjection('selection');
  assert.ok(current.selection);
  assert.equal(current.function, undefined);
  assert.equal(current.containingFunction.name, 'f');
  assert.equal(JSON.stringify(current).includes('secret outside selection'), false);
});

await test('Context keeps latest oversized observation and drops older data first', () => {
  const broker = new ContextBroker({}, { maxBytes: 8192, maxObservationBytes: 1024 });
  const { context } = broker.buildModelContext({ request: { goal: 'x', scope: 'function' }, session: { messages: [] }, observations: [
    { tool: 'old', summary: 'old', data: { x: 1 } },
    { tool: 'new', summary: 'new result', data: { blob: 'x'.repeat(10000) } },
  ] });
  assert.equal(context.recentObservations.at(-1)?.tool, 'new');
  assert.equal(context.recentObservations.at(-1)?.truncated, true);
  assert.equal(context.recentObservations.some((x) => x.tool === 'old'), false);
});

await test('Selection scope does not advertise function-wide AI tools', () => {
  const registry = createHexToolRegistry({ selection: { instructions: [] } });
  const names = registry.names({ scope: 'selection' });
  assert.ok(names.includes('get_selection_context'));
  assert.equal(names.includes('get_function'), false);
  assert.equal(names.includes('decompile_function'), false);
  assert.equal(names.includes('get_xrefs'), false);
});

await test('Runtime observations are not verified merely because one exists', async () => {
  const evidence = new EvidenceStore();
  const registry = createHexToolRegistry({ runtime: { currentSession: () => ({ observations: [{ id: 'o1', address: '0x10', status: 'supported' }] }) } }, { evidenceStore: evidence });
  const result = await registry.execute('get_runtime_observations', {}, { scope: 'runtime' });
  assert.ok(result.evidence.length >= 1);
  assert.ok(result.evidence.every((x) => x.status !== 'verified'));
});

await test('Runtime rejects resuming a session under another binary without mutating it', async () => {
  const sessions = new InvestigationSessionStore();
  const s = await sessions.create({ binaryId: 'A', mode: 'chat', style: 'analyst', scope: 'function', goal: 'a' });
  const runtime = new AIRuntime({ planner: false, sessionStore: sessions, context: { binaryId: 'B' } });
  await assert.rejects(() => runtime.turn({ sessionId: s.id, binaryId: 'B', goal: 'b', mode: 'chat', scope: 'function' }), (error) => error?.type === 'scope_violation');
  assert.equal((await sessions.get(s.id)).messages.length, 0);
  assert.equal(runtime.activeControllers.size, 0);
});

await test('Runtime cleans controller/timer path when persistence/finalize tail fails', async () => {
  const base = new InvestigationSessionStore();
  const sessionStore = {
    create: (...args) => base.create(...args), get: (...args) => base.get(...args), appendMessage: (...args) => base.appendMessage(...args),
    async update(id, patch) { if (Object.prototype.hasOwnProperty.call(patch, 'confirmedFindings')) throw new Error('persist-fail'); return base.update(id, patch); },
  };
  const runtime = new AIRuntime({ planner: false, sessionStore, context: { binaryId: 'A' } });
  await assert.rejects(() => runtime.turn({ binaryId: 'A', goal: 'hello', mode: 'chat', scope: 'function' }), /persist-fail/);
  assert.equal(runtime.activeControllers.size, 0);
});

await test('Runtime pre-abort does no work and leaves no controller', async () => {
  const c = new AbortController(); c.abort();
  const runtime = new AIRuntime({ planner: false, context: { binaryId: 'A' } });
  await assert.rejects(() => runtime.turn({ binaryId: 'A', goal: 'hello', mode: 'chat' }, { signal: c.signal }), /cancel/i);
  assert.equal(runtime.activeControllers.size, 0);
});

await test('Itanium invalid substitution fails instead of inventing auto', () => {
  assert.equal(demangleCxx('__Z1fi'), 'f(int)');
  assert.equal(demangleCxx('__Z1fS9_'), null);
});

await test('Swift minimal demangler marks trailing unknown grammar as partial, not exact', () => {
  const parsed = demangleSwiftSymbol('$s4Test3foo?');
  assert.equal(parsed.parsed, false);
  assert.equal(parsed.partial, true);
  assert.equal(parsed.demangled, '$s4Test3foo?');
  assert.equal(parsed.partialDemangled, 'Test.foo');
});

console.log(`issue-191-plus: ${passed} tests passed`);
