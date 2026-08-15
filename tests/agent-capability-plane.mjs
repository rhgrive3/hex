import assert from 'node:assert/strict';
import { createCapabilityCatalog, HEX_CAPABILITIES } from '../js/ai/capabilities/catalog.js';
import { assertCapabilityParity, auditCapabilityParity } from '../js/ai/capabilities/parity.js';
import { createCapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { ProposalStore } from '../js/ai/proposals.js';
import { createProposalExecutor } from '../js/ai/interaction/proposal-executor.js';
import { PatchSet } from '../js/patch.js';
import { AgentJobManager } from '../js/ai/jobs/index.js';

assert.equal(assertCapabilityParity(HEX_CAPABILITIES).ok, true);
assert.equal(auditCapabilityParity([{ id: 'set-type', category: 'annotation', agentExposed: false, humanOnlyReason: 'not implemented' }]).ok, false);
assert.equal(auditCapabilityParity([{ id: 'set-type', category: 'analysis', agentExposed: true }]).ok, false);

const app = fakeApp();
const catalog = createCapabilityCatalog();
const executor = createCapabilityExecutor({ catalog, app, binaryId: 'bin-A' });
const authorization = { kind: 'proposal', token: '0123456789abcdef' };

await executor.execute('annotation.rename', { address: '4096', value: 'renamed' }, { authorization });
assert.equal(app.notes.nameOf(4096n), 'renamed'); assert.equal(app.symbols.nameAt(4096n), 'renamed');
await executor.execute('annotation.comment', { address: '4096', value: 'comment' }, { authorization });
assert.equal(app.notes.comment(4096n), 'comment');
await executor.execute('annotation.set-type', { address: '4096', key: 'return', value: 'int' }, { authorization });
assert.equal(app.notes.typeOf(4096n, 'return'), 'int');
await executor.execute('annotation.struct-field', { struct: 'Header', offset: 8, field: 'flags', type: 'uint32_t' }, { authorization });
assert.equal(app.notes.structs[0].fields[0].name, 'flags');
await assert.rejects(executor.execute('annotation.rename', { address: '4096', value: 'no-approval' }), (error) => error.type === 'approval_required');

const preview = await executor.execute('patch.preview', { address: '4096', before: [1, 2, 3, 4], after: [4, 3, 2, 1] });
assert.equal(preview.fileOffset, 0n);
const patch = await executor.execute('patch.create', { address: '4096', before: [1, 2, 3, 4], after: [4, 3, 2, 1] }, { authorization });
assert.deepEqual(patch.after, [4, 3, 2, 1]);
const output = await executor.execute('patch.apply', { file: app.file }, { authorization });
assert.deepEqual([...new Uint8Array(await output.output.arrayBuffer())], [4, 3, 2, 1, 5, 6, 7, 8]);
await executor.execute('patch.revert', { fileOffset: '0' }, { authorization }); assert.equal(app.patches.size, 0);
await assert.rejects(executor.execute('patch.create', { address: '4096', before: [9, 2, 3, 4], after: [4, 3, 2, 1] }, { authorization }), /stale/);

const evidenceStore = { has: (id) => id === 'e1' };
const proposals = new ProposalStore({ evidenceStore });
const proposalExecutor = createProposalExecutor({ store: proposals, capabilityExecutor: executor, app });
const rename = proposals.create({ kind: 'rename', target: { address: '4096' }, before: 'renamed', after: 'approved_name', evidenceIds: ['e1'] });
await proposalExecutor.approveAndApply(rename.id); assert.equal(app.notes.nameOf(4096n), 'approved_name');
const stale = proposals.create({ kind: 'comment', target: { address: '4096' }, before: 'comment', after: 'new comment', evidenceIds: ['e1'] });
app.notes.setComment(4096n, 'changed elsewhere');
await assert.rejects(proposalExecutor.approveAndApply(stale.id), /changed after it was created/);
assert.equal(app.notes.comment(4096n), 'changed elsewhere');

let activeBinary = 'bin-A';
const boundStore = new ProposalStore({ evidenceStore, binding: () => ({ binaryId: activeBinary }) });
const boundProposal = boundStore.create({ kind: 'comment', target: { address: '4096' }, before: 'changed elsewhere', after: 'wrong binary', evidenceIds: ['e1'] });
const boundExecutor = createProposalExecutor({ store: boundStore, capabilityExecutor: executor, app });
activeBinary = 'bin-B';
await assert.rejects(boundExecutor.approveAndApply(boundProposal.id), (error) => error.type === 'scope_violation');

const runtimeCalls = [];
let runtimeBytes = new Uint8Array([3, 3, 3, 3]);
const adapter = {
  connected: true, capabilities: { resume: true, readMemory: true },
  resume: async () => runtimeCalls.push('resume'), pause: async () => runtimeCalls.push('pause'),
  stepInto: async () => runtimeCalls.push('in'), stepOver: async () => runtimeCalls.push('over'), stepOut: async () => runtimeCalls.push('out'),
  readRegisters: async () => ({ pc: '0x1000' }), readMemory: async (_address, size) => runtimeBytes.slice(0, size),
  writeMemory: async (_address, bytes) => { runtimeBytes = Uint8Array.from(bytes); return { written: bytes.length }; },
};
const runtimePlatform = { currentSession: (required = true) => ({ id: 'runtime-A', binaryHash: 'bin-A', backend: 'fake', adapter }), sessions: { close: async () => true }, runExperiment: async () => ({ evidence: [] }) };
const runtimeExecutor = createCapabilityExecutor({ catalog, runtimePlatform, binaryId: 'bin-A' });
await assert.rejects(runtimeExecutor.execute('runtime.continue', { runtimeSessionId: 'runtime-B', binaryId: 'bin-A' }, { authorization }), (error) => error.type === 'scope_violation');
await runtimeExecutor.execute('runtime.continue', { runtimeSessionId: 'runtime-A', binaryId: 'bin-A' }, { authorization });
assert.deepEqual(runtimeCalls, ['resume']);
const memory = await runtimeExecutor.execute('runtime.memory-read', { runtimeSessionId: 'runtime-A', binaryId: 'bin-A', address: '4096', size: 4 });
assert.deepEqual(memory.bytes, [3, 3, 3, 3]);
await runtimeExecutor.execute('runtime.memory-write', { runtimeSessionId: 'runtime-A', binaryId: 'bin-A', address: '4096', expectedBefore: [3, 3, 3, 3], bytes: [4, 4, 4, 4] }, { authorization });
assert.deepEqual([...runtimeBytes], [4, 4, 4, 4]);
await assert.rejects(runtimeExecutor.execute('runtime.memory-write', { runtimeSessionId: 'runtime-A', binaryId: 'bin-A', address: '4096', expectedBefore: [3, 3, 3, 3], bytes: [5, 5, 5, 5] }, { authorization }), /stale/);

const knownTools = new Set(HEX_CAPABILITIES.filter((item) => item.agentTool).map((item) => item.agentTool));
const available = catalog.agent({ toolRegistry: { has: (name) => knownTools.has(name) } });
assert.ok(available.some((item) => item.id === 'analysis.backward-slice'));

let slice = 0;
const persistenceValues = new Map();
const jobs = new AgentJobManager({
  runtime: { turn: async () => (++slice === 1
    ? { sessionId: 'ai-A', scope: { effective: 'binary' }, evidence: [{ id: 'ev1', detailRef: 'detail:1' }], hypotheses: [{ id: 'h1' }], activity: [{ type: 'tool-start', tool: 'search_functions' }], followups: ['inspect candidate'], usage: { modelCalls: 2, toolCalls: 1, elapsedMs: 10, contextBytes: 100 }, limits: { exhausted: true, reason: 'tool-call-budget' }, answer: 'checkpoint' }
    : { sessionId: 'ai-A', scope: { effective: 'binary' }, evidence: [{ id: 'ev2' }], hypotheses: [], activity: [], followups: [], usage: { modelCalls: 1, toolCalls: 0, elapsedMs: 5, contextBytes: 50 }, limits: { exhausted: false }, answer: 'done' }) },
  persistence: { save: async (job) => persistenceValues.set(job.id, job), load: async (id) => persistenceValues.get(id) }, maxSlices: 3,
});
const job = await jobs.create({ goal: 'Find the check', scope: 'binary', conversationId: 'chat-A' });
const checkpoint = await jobs.runSlice(job.id); assert.equal(checkpoint.status, 'checkpointed'); assert.equal(checkpoint.sessionId, 'ai-A'); assert.deepEqual(checkpoint.evidenceIds, ['ev1']); assert.deepEqual(checkpoint.continuationRefs, ['detail:1']);
const completed = await jobs.resume(job.id); assert.equal(completed.status, 'complete'); assert.deepEqual(completed.evidenceIds, ['ev1', 'ev2']); assert.equal(completed.budgetUsage.slices, 2);

console.log('agent-capability-plane: ok');

function fakeApp() {
  const names = new Map(), comments = new Map(), types = new Map(), symbols = new Map();
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  return {
    file: new Blob([bytes]), patches: new PatchSet(),
    backend: { readAt: async (address, length) => ({ found: true, bytes: bytes.slice(Number(BigInt(address) - 4096n), Number(BigInt(address) - 4096n) + length) }) },
    store: { get: (key) => key === 'regions' ? [{ vmAddr: 4096n, fileOffset: 0n, size: 8n, exec: true }] : key === 'fileInfo' ? { size: 8 } : null },
    notes: {
      structs: [], dirty: false, save: () => true,
      setName: (address, value) => names.set(String(address), value), nameOf: (address) => names.get(String(address)) || null,
      setComment: (address, value) => comments.set(String(address), value), comment: (address) => comments.get(String(address)) || null,
      setType: (address, key, value) => { types.set(`${address}:${key}`, value); return true; }, typeOf: (address, key) => types.get(`${address}:${key}`) || null,
    },
    symbols: { rename: (address, value) => symbols.set(String(address), value), nameAt: (address) => symbols.get(String(address)) || null },
    viewer: { setSymbols() {} }, updateChrome() {}, workspace: { autosave: () => true },
  };
}
