import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor } from '../js/ir.js';
import { semanticFacts, FACT } from '../js/semantic.js';
import { symbolicExecute } from '../js/symbolic/executor.js';
import { FunctionSandbox } from '../js/symbolic/function-sandbox.js';
import { runAgent, runDeterministicAgent } from '../js/agent/runtime.js';
import { planAnalysisGoal } from '../js/query/planner.js';
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

// Explicit small/zero budgets remain strict; they are never raised to four.
{
  const model = modelOf(['mov x0, #1', 'ret']);
  const context = { candidateFunctions: [BASE], analyze: async () => model };
  const zero = await planAnalysisGoal('XPが増える場所', context, { maxFunctions: 0, timeoutMs: 1000 });
  assert.equal(zero.stats.analyzedFunctions, 0);
  assert.equal(zero.best, null);

  const disasm = await runDeterministicAgent('XPが増える場所', context, { maxFunctions: 1, maxDisassembly: 1, timeoutMs: 1000 });
  assert.equal(disasm.plan.best, null);
  assert.ok(disasm.missingEvidence.includes('disassembly-budget'));
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

console.log('integration-review: PASS');
