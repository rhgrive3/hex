import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP, rangeOnBranch } from '../js/ir.js';
import { semanticFacts, FACT } from '../js/semantic.js';
import { symbolicExecute } from '../js/symbolic/executor.js';
import { FunctionSandbox } from '../js/symbolic/function-sandbox.js';
import { runAgent, runDeterministicAgent } from '../js/agent/runtime.js';
import { createAgentTools } from '../js/agent/tools.js';
import { planAnalysisGoal } from '../js/query/planner.js';
import { functionPaths } from '../js/query/causal.js';
import { summarizeFunction } from '../js/interproc.js';
import { inferSemanticTypes } from '../js/decompiler/type-recovery.js';
import { createHexProject, parseHexProject, serializeHexProject } from '../js/project/index.js';
import { CachedByteSource } from '../js/bytesource/cached.js';

const BASE = 0x100000000n;
function modelOf(lines, base = BASE) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: base + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - base;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

// CBZ/CBNZ compare with zero even when the tested SSA value is constant.
{
  const ir = irFor(modelOf(['mov w8, #5', 'cbz w8, #0x10000000c', 'ret', 'ret']));
  const facts = semanticFacts(ir);
  const threshold = facts.find((f) => f.kind === FACT.THRESHOLD);
  const zero = facts.find((f) => f.kind === FACT.ZERO_NULL);
  assert.equal(threshold?.threshold, 0n);
  assert.equal(zero?.threshold, 0n);
}

// Equality/zero tests do not imply signed or unsigned ordering semantics.
{
  const ir = irFor(modelOf(['cmp x0, #0', 'b.eq #0x10000000c', 'ret', 'ret']));
  const branch = ir.instructions.find((i) => i.op === OP.CBR);
  assert.equal(rangeOnBranch(ir, branch, true)?.signedness, 'unknown');
}

// A symbolic LOAD observes memory at the LOAD, not after a later STORE.
{
  const ir = irFor(modelOf([
    'ldr w8, [x0, #0x20]',
    'str w1, [x0, #0x20]',
    'add w0, w8, #1',
    'ret',
  ]));
  const result = symbolicExecute(ir, { timeoutMs: 1000, symbolicArgs: { 1: 'replacement' } });
  const complete = result.paths.find((p) => p.status === 'complete');
  assert.ok(complete, 'symbolic path should complete');
  assert.match(complete.returnText, /field\(/);
  assert.doesNotMatch(complete.returnText, /replacement/);
}

// Sandbox fixture writes are baseline state, not function effects.
{
  const code = new Map([[BASE.toString(), { mn: 'ret', ops: '' }]]);
  const sandbox = new FunctionSandbox({ fetch: async (addr) => code.get(addr.toString()) || null });
  await sandbox.setup(BASE, {
    objectMemory: [{ offset: 0x20, size: 4, value: 7 }],
    watch: [{ name: 'counter', offset: 0x20, size: 4 }],
  });
  const result = await sandbox.run({ maxSteps: 4 });
  assert.deepEqual(result.touchedFields, []);
  assert.deepEqual(result.modifiedObjectRanges, []);
}

// Model output cannot replace a deterministic, evidence-backed conclusion.
{
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const context = { candidateFunctions: [BASE], analyze: async () => model };
  const llm = {
    async next() {
      return { answer: { conclusion: { address: 0xDEADBEEFn, name: 'invented' }, reasons: ['model-only'], confidence: 1 } };
    },
  };
  const result = await runAgent({ goal: 'XPが増える場所', context, llm, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2000 });
  assert.equal(result.conclusion?.address, BASE);
  assert.equal(result.modelAnswer?.conclusion?.address, 0xDEADBEEFn);
  assert.ok(result.reasons.some((r) => r.kind === 'deterministic-verification'));
}

// Explicit small/zero budgets remain strict; runtime never raises them.
{
  const model = modelOf(['mov x0, #1', 'ret']);
  const context = { candidateFunctions: [BASE], analyze: async () => model };
  const zero = await planAnalysisGoal('XPが増える場所', context, { maxFunctions: 0, timeoutMs: 1000 });
  assert.equal(zero.stats.analyzedFunctions, 0);
  assert.equal(zero.best, null);

  const disasm = await runDeterministicAgent('XPが増える場所', context, { maxFunctions: 1, maxDisassembly: 1, timeoutMs: 1000 });
  assert.equal(disasm.plan.best, null);
  assert.ok(disasm.missingEvidence.includes('disassembly-budget'));

  let modelCalled = false;
  const agent = await runAgent({
    goal: 'XPが増える場所', context,
    llm: { async next() { modelCalled = true; return { answer: { conclusion: { address: BASE }, confidence: 1 } }; } },
    maxToolCalls: 0, maxFunctions: 0, maxDisassembly: 0, timeoutMs: 1000,
  });
  assert.equal(modelCalled, false);
  assert.equal(agent.conclusion, null);
  assert.equal(agent.stats.toolCalls, 0);
  assert.equal(agent.stats.disassembly, 0);
}

// Internal multi-function tools share the same global function-analysis budget.
{
  const A = BASE + 0x300n, B = BASE + 0x400n;
  const analyzed = [];
  const tools = createAgentTools({
    analyze: async (address) => { analyzed.push(address); return modelOf(['mov x0, #1', 'ret'], address); },
  }, { maxFunctions: 1 });
  const first = await tools.find_constant(1, { functions: [A] });
  assert.equal(first.scopedFunctions, 1);
  await assert.rejects(() => tools.find_constant(1, { functions: [B] }), /function-budget/);
  assert.deepEqual(analyzed, [A]);
}

// Verification failure on a high-ranked candidate must not block a later proof.
{
  const A = BASE + 0x100n, B = BASE + 0x200n;
  const semantic = (address) => ({
    kind: FACT.RMW,
    row: 1,
    address,
    location: { key: 'arg:x0@32:4', disp: 0x20n },
    evidence: [{ id: 'ir:' + address.toString(16) }],
  });
  const tools = {
    search_functions: async () => ({ results: [] }),
    search_strings: async () => ({ results: [] }),
    get_xrefs: async () => ({ functions: [] }),
    get_callers: async () => ({ results: [] }),
    get_callees: async () => ({ results: [] }),
    get_function: async (address) => ({ address, name: null, summary: null, instructions: 1 }),
    get_semantic_facts: async (address) => ({ results: [semantic(address)] }),
    verify_field_update: async (address) => ({ verified: address === B, evidence: address === B ? ['verified:B'] : [] }),
    find_thresholds: async () => ({ results: [] }),
  };
  const plan = await planAnalysisGoal('XPが増える場所', { candidateFunctions: [A, B] }, { tools, maxFunctions: 2, maxDisassembly: 10, timeoutMs: 1000 });
  assert.equal(plan.best?.address, B);
  assert.equal(plan.best?.verification?.verified, true);
}

// Signedness is recovered from IR flags def-use, not raw row adjacency.
{
  const model = modelOf([
    'cmp x0, #5',
    'mov x1, x1',
    'mov x2, x2',
    'b.lt #0x100000014',
    'ret',
    'ret',
  ]);
  const ir = irFor(model);
  const recovered = inferSemanticTypes(ir, model);
  const arg0 = recovered.args.find((a) => a.index === 0);
  assert.ok(arg0, 'x0 argument should be recovered');
  assert.equal(arg0.semanticType?.signed, true);
}

// A conditional one-call function is not a trivial forwarding wrapper.
{
  const summary = summarizeFunction(modelOf([
    'cmp x0, #0',
    'b.eq #0x10000000c',
    'mov x1, #1',
    'bl #0x100000100',
    'ret',
  ]));
  assert.equal(summary?.calls.length, 1);
  assert.equal(summary?.classification.forwarding, false);
}

// Distinct call paths that merge and split again must remain distinct.
{
  const A = BASE + 0x500n, B = BASE + 0x510n, C = BASE + 0x520n, D = BASE + 0x530n, E = BASE + 0x540n;
  const edges = new Map([
    [A, [B, C]], [B, [D]], [C, [D]], [D, [E]], [E, []],
  ].map(([k, v]) => [k.toString(), v]));
  const program = {
    functionRange: () => ({ end: BASE + 0x1000n }),
    calleesOf: (address) => (edges.get(address.toString()) || []).map((addr) => ({ addr })),
  };
  const paths = functionPaths(program, A, E, { maxDepth: 5, maxPaths: 4, maxVisited: 100 });
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map((p) => p.map(String)), [
    [A, B, D, E].map(String),
    [A, C, D, E].map(String),
  ]);
}

// Project persistence must round-trip signed offsets/constants.
{
  const project = createHexProject({ comments: [{ addr: BASE, stackOffset: -0x20n }] });
  const parsed = parseHexProject(serializeHexProject(project));
  assert.equal(parsed.user.comments[0].stackOffset, -0x20n);
}

// clear() is a hard cache-lifecycle boundary even when an older read finishes later.
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const source = {
    size: 4n,
    maxReadLength: 4,
    async read() { return gate; },
  };
  const cached = new CachedByteSource(source, { pageSize: 4, maxCachedBytes: 4 });
  const pending = cached.read(0n, 4);
  await Promise.resolve();
  cached.clear();
  release(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(Array.from(await pending), [1, 2, 3, 4]);
  assert.equal(cached.memoryStats().bytesCached, 0);
  assert.equal(cached.memoryStats().chunksCached, 0);
}

// Neutral disassembly is invalidated when the file/slice epoch changes.
{
  const previousWorker = globalThis.Worker;
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.terminated = false; this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const { Backend, StaleRequestError } = await import('../js/backend.js');
    const backend = new Backend();
    const pending = backend._disassembleBytes(new Uint8Array([0, 0, 0, 0]), BASE, 'arm64', backend.gen);
    backend.advanceEpoch();
    await assert.rejects(pending, (error) => error instanceof StaleRequestError || error?.stale === true);
    assert.equal(backend._disasmPending.size, 0);
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
}

console.log('integration-review: PASS');
