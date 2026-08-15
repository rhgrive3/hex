import { buildSemanticModel } from '../js/blocks.js';
import {
  irFor, readModifyWrite, OP, mustAlias, pointerProvenance,
  rangeOnBranch,
} from '../js/ir.js';
import { findValueUpdates, dataflowEngine } from '../js/dataflow.js';
import { semanticFacts, FACT } from '../js/semantic.js';
import { summarizeFunction } from '../js/interproc.js';
import { symbolicExecute } from '../js/symbolic/executor.js';
import { FunctionSandbox } from '../js/symbolic/function-sandbox.js';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { groupOf, GROUP } from '../js/evidence.js';
import { runDeterministicAgent } from '../js/agent/runtime.js';

let passed = 0;
const failures = [];
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': got ' + String(a) + ', want ' + String(b)); }

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}
function phis(ir) { return (ir.blocks || []).flatMap((b) => b.phis || []); }

const pending = [];
function asyncTest(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => {
    passed++; process.stdout.write('  ok  ' + name + '\n');
  }).catch((err) => {
    failures.push({ name, err }); process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n');
  }));
}

asyncTest('alias through MOV is must-alias and RMW', () => {
  const model = modelOf([
    'mov x20, x19',
    'ldr w8, [x20, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  const load = ir.instructions.find((i) => i.op === OP.LOAD);
  const store = ir.instructions.find((i) => i.op === OP.STORE);
  ok(mustAlias(load.loc, store.loc), 'MOV provenance must prove the same object');
  ok(readModifyWrite(ir).some((r) => r.store === store), 'RMW survives alias copy');
  eq(dataflowEngine(model), 'semantic-ir');
});

asyncTest('pointer + constant offset is canonicalized conservatively', () => {
  const model = modelOf([
    'mov x20, x19',
    'add x21, x20, #0x20',
    'ldr w8, [x21, #0]',
    'add w8, w8, #2',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  const pointerAdd = ir.instructions.find((i) => i.op === OP.BIN && i.sub === 'add' && i.dst && i.dst.reg === 'x21');
  ok(pointerAdd && pointerAdd.dst, 'pointer add is represented in SSA');
  const p = pointerProvenance(pointerAdd.dst);
  eq(p.offset, 0x20n, 'constant offset is retained on the pointer SSA value');
  ok(readModifyWrite(ir).length === 1, 'effective addresses are must-alias after address canonicalization');
});

asyncTest('unknown indexed store clobbers proof and blocks false-positive RMW', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'str w2, [x19, x3, lsl #2]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  eq(readModifyWrite(ir).length, 0, 'unknown may-alias store is a barrier');
  ok(!findValueUpdates(model).some((u) => u.kind === 'read-modify-write'), 'facade does not reintroduce the legacy false positive');
});

asyncTest('branch merge creates PHI used by semantic update', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'cmp w0, #0',
    'b.eq #0x100000014',
    'add w8, w8, #1',
    'b #0x100000018',
    'add w8, w8, #2',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  ok(phis(ir).some((p) => p.dst && p.dst.reg === 'x8'), 'x8 PHI exists');
  ok(readModifyWrite(ir).some((r) => r.store.row === 6), 'Memory/value path crosses the PHI');
});

asyncTest('loop-carried value receives PHI without unbounded analysis', () => {
  const model = modelOf([
    'mov w8, #0',
    'add w8, w8, #1',
    'cmp w8, w0',
    'b.lo #0x100000004',
    'mov x0, x8',
    'ret',
  ]);
  const ir = irFor(model);
  ok((ir.blocks || []).some((b) => b.isLoopHeader), 'loop header recognized');
  ok(phis(ir).some((p) => p.dst && p.dst.reg === 'x8'), 'loop PHI exists');
});

asyncTest('clamp is emitted as a first-class Semantic Fact', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, w21',
    'cmp w8, w22',
    'csel w8, w22, w8, gt',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const facts = semanticFacts(irFor(model));
  ok(facts.some((f) => f.kind === FACT.RMW), 'RMW fact');
  ok(facts.some((f) => f.kind === FACT.CLAMP), 'clamp fact');
});

asyncTest('unsigned and signed branch thresholds expose edge ranges', () => {
  const u = irFor(modelOf(['cmp w8, #100', 'b.hi #0x10000000c', 'ret', 'ret']));
  const ub = u.instructions.find((i) => i.op === OP.CBR);
  const uf = rangeOnBranch(u, ub, false);
  ok(uf && uf.range, 'unsigned fallthrough range');
  eq(uf.range.min, 0n);
  eq(uf.range.max, 100n);
  eq(uf.signedness, 'unsigned');

  const s = irFor(modelOf(['cmp w8, #0', 'b.lt #0x10000000c', 'ret', 'ret']));
  const sb = s.instructions.find((i) => i.op === OP.CBR);
  const st = rangeOnBranch(s, sb, true);
  ok(st && st.range, 'signed taken range');
  eq(st.range.max, -1n);
  eq(st.signedness, 'signed');
});

asyncTest('field arithmetic feeding another field emits write and transfer facts', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #5',
    'str w8, [x19, #0x30]',
    'ret',
  ]);
  const facts = semanticFacts(irFor(model));
  const write = facts.find((f) => f.kind === FACT.WRITE && f.location && f.location.disp === 0x30n);
  const transfer = facts.find((f) => f.kind === FACT.TRANSFER && f.sink && f.sink.disp === 0x30n);
  ok(write, 'destination write is a semantic fact');
  ok(write.value && write.value.origin && write.value.origin.kind === 'computed', 'written value preserves computed origin');
  ok(transfer && transfer.source && transfer.source.location && transfer.source.location.disp === 0x20n,
    'source field dependency is retained through arithmetic');
});

asyncTest('function summaries classify wrapper getter and setter', () => {
  const wrapper = summarizeFunction(modelOf(['add x0, x0, #5', 'ret']), { returnEvidence: true });
  ok(wrapper.classification.simpleArithmeticWrapper, 'simple add wrapper');
  eq(wrapper.returns[0].kind, 'argument-arithmetic');

  const getter = summarizeFunction(modelOf(['ldr x0, [x0, #0x20]', 'ret']), { returnEvidence: true });
  ok(getter.classification.getter, 'getter');
  const setter = summarizeFunction(modelOf(['str x2, [x0, #0x20]', 'ret']));
  ok(setter.classification.setter, 'setter');
});

asyncTest('symbolic executor emits explicit path constraints', () => {
  const ir = irFor(modelOf([
    'cmp x0, #0',
    'b.le #0x100000010',
    'mov x0, #1',
    'ret',
    'mov x0, #0',
    'ret',
  ]));
  const result = symbolicExecute(ir, { timeoutMs: 1000 });
  ok(result.paths.length >= 2, 'both bounded paths explored');
  const constraints = result.paths.flatMap((p) => p.constraintText || []);
  ok(constraints.some((x) => x.includes('arg0') && x.includes('<=')), 'taken condition is explicit: ' + constraints.join(', '));
  ok(constraints.some((x) => x.includes('arg0') && x.includes('>')), 'fallthrough condition is explicit: ' + constraints.join(', '));
});

asyncTest('Function Sandbox records before/after memory and touched fields', async () => {
  const code = new Map([
    [BASE.toString(), { mn: 'ldr', ops: 'w8, [x0, #0x20]' }],
    [(BASE + 4n).toString(), { mn: 'add', ops: 'w8, w8, #3' }],
    [(BASE + 8n).toString(), { mn: 'str', ops: 'w8, [x0, #0x20]' }],
    [(BASE + 12n).toString(), { mn: 'ret', ops: '' }],
  ]);
  const sandbox = new FunctionSandbox({ fetch: async (addr) => code.get(addr.toString()) || null });
  await sandbox.setup(BASE, {
    objectMemory: [{ offset: 0x20, size: 4, value: 7 }],
    watch: [{ name: 'counter', offset: 0x20, size: 4 }],
  });
  const result = await sandbox.run({ maxSteps: 16 });
  eq(result.before[0].value, 7n, 'before snapshot');
  eq(result.after[0].value, 10n, 'after snapshot');
  ok(result.touchedFields.some((f) => f.name === 'counter' && f.before === 7n && f.after === 10n), 'field delta captured');
});

asyncTest('Semantic and runtime evidence keep independent origins without duplicate IR inflation', () => {
  const facts = semanticFacts(irFor(modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ])));
  const semantic = semanticEvidenceItems(facts);
  const ids = semantic.map((x) => x.detail && x.detail.evidenceId).filter(Boolean);
  eq(new Set(ids).size, ids.length, 'one evidence item per IR instruction origin');
  ok(semantic.length > 0 && semantic.every((x) => groupOf(x) === GROUP.DATAFLOW), 'IR semantic proofs stay in the dataflow group');

  const runtime = runtimeEvidenceItems({ ok: true, completed: true, touchedFields: [{ address: 0x6000n, before: 1n, after: 2n }] });
  eq(runtime.length, 1, 'one runtime observation');
  eq(groupOf(runtime[0]), GROUP.RUNTIME, 'runtime stays independent from dataflow');
});

asyncTest('deterministic Goal Planner verifies an agent causal path', async () => {
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const context = { candidateFunctions: [BASE], analyze: async () => model };
  const result = await runDeterministicAgent('XPが増える場所', context, { maxFunctions: 8, timeoutMs: 2000 });
  ok(result.conclusion && result.conclusion.address === BASE, 'planner returns scoped function');
  ok(result.evidence.length > 0, 'answer is evidence-backed');
  ok(result.plan.best && result.plan.best.verification && result.plan.best.verification.verified, 'field update verified');
  ok(result.plan.best.verification.causalPaths[0].nodes.length >= 2, 'minimal causal path returned');
});

await Promise.all(pending);
process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);