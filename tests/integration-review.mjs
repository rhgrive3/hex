import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { irFor, readModifyWrite, OP, MK } from '../js/ir.js';
import { semanticFacts, FACT } from '../js/semantic.js';
import { createAgentTools } from '../js/agent/tools.js';
import { planAnalysisGoal } from '../js/query/planner.js';
import { compileGoal } from '../js/goalc.js';
import { symbolicExecute, expressionText } from '../js/symbolic/executor.js';
import { findValueUpdates } from '../js/dataflow.js';

let rowSeq = 0;
function I(mn, ops = '', addr = null) {
  const row = rowSeq++;
  return { row, address: addr == null ? 0x100000000n + BigInt(row * 4) : BigInt(addr), mn, ops };
}
function modelOf(instructions, calls = [], edges = [], opts = {}) {
  return buildSemanticModel(instructions, calls, edges, opts);
}
function reset() { rowSeq = 0; }

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name,true]); }
  catch (error) { results.push([name,false,error]); }
}

await test('Semantic IR is the canonical source for concrete RMW facts', () => {
  reset();
  const model = modelOf([
    I('ldr','w8, [x0, #0x20]'),
    I('add','w8, w8, w1'),
    I('str','w8, [x0, #0x20]'),
    I('ret',''),
  ]);
  const ir = irFor(model);
  assert.ok(ir);
  const rmw = readModifyWrite(ir);
  assert.equal(rmw.length,1);
  assert.equal(rmw[0].kind,'add');
  const facts = semanticFacts(ir);
  assert.ok(facts.some((f) => f.kind === FACT.RMW && f.operation === 'add'));
  const updates = findValueUpdates(model);
  assert.ok(updates.some((u) => u.engine === 'ir-ssa'));
});

await test('unknown indexed memory never becomes a concrete field fact', () => {
  reset();
  const model = modelOf([
    I('ldr','w8, [x0, x1, lsl #2]'),
    I('add','w8, w8, #1'),
    I('str','w8, [x0, x1, lsl #2]'),
    I('ret',''),
  ]);
  const ir = irFor(model);
  const stores = ir.instructions.filter((i) => i.op === OP.STORE);
  assert.ok(stores.length);
  assert.equal(stores[0].loc.kind, MK.UNKNOWN);
  const rmw = readModifyWrite(ir);
  assert.equal(rmw.length,1);
  assert.equal(rmw[0].location.kind, MK.UNKNOWN);
  assert.ok(!semanticFacts(ir).some((f) => f.kind === FACT.RMW));
});

await test('deterministic tools use Semantic IR evidence', async () => {
  reset();
  const address = 0x100000100n;
  const model = modelOf([
    I('ldr','w8, [x0, #0x30]',address),
    I('add','w8, w8, #5'),
    I('str','w8, [x0, #0x30]'),
    I('ret',''),
  ]);
  const tools = createAgentTools({ analyze: async () => model, candidateFunctions:[address] }, { maxFunctions:4 });
  const facts = await tools.get_semantic_facts(address);
  assert.equal(facts.engine,'semantic-ir');
  assert.ok(facts.results.some((f) => f.kind === FACT.RMW));
  const verified = await tools.verify_field_update(address,{offset:0x30});
  assert.equal(verified.verified,true);
  assert.ok(verified.evidence.length);
});

await test('planner ranks deterministic semantic evidence and verification', async () => {
  const A = 0x100000100n, B = 0x100000200n;
  const q = compileGoal('Increase coin after battle reward');
  const facts = new Map([
    [A.toString(),[{kind:FACT.READ,evidence:['a']}]],
    [B.toString(),[{kind:FACT.RMW,operation:'add',location:{key:'field:x0:48',disp:48n},evidence:['b']}]],
  ]);
  const plannerTools = {
    search_functions: async () => ({results:[{address:A,name:'coin_view'},{address:B,name:'reward_coin_update'}]}),
    search_strings: async () => ({results:[]}),
    get_callers: async () => ({results:[]}),
    get_callees: async () => ({results:[]}),
    get_xrefs: async () => ({results:[],functions:[]}),
    get_function: async (address) => ({address,name:address===B?'reward_coin_update':'coin_view',found:true,instructions:1,cost:{functions:1,disassembly:1},summary:{calls:[]}}),
    get_semantic_facts: async (address) => ({results:facts.get(address.toString()) || []}),
    verify_field_update: async (address) => ({verified:address===B,evidence:address===B?['verified-b']:[]}),
    find_thresholds: async () => ({results:[]}),
  };
  const planned = await planAnalysisGoal(q,{}, {tools:plannerTools,maxFunctions:8,maxDisassembly:100,timeoutMs:1000});
  assert.equal(planned.best.address,B);
  assert.ok(planned.best.verification.verified);
  assert.ok(planned.evidence.includes('verified-b'));
});

await test('function budget is strict and observable', async () => {
  reset();
  const a = 0x100000100n, b = 0x100000200n;
  const models = new Map([
    [a.toString(),modelOf([I('ret','',a)])],
    [b.toString(),modelOf([I('ret','',b)])],
  ]);
  const tools = createAgentTools({ analyze: async (address) => models.get(address.toString()), candidateFunctions:[a,b] }, {maxFunctions:1});
  await tools.get_function(a);
  await assert.rejects(() => tools.get_function(b), /function-budget/);
});

await test('symbolic executor proves simple branch relations and field updates', () => {
  reset();
  const model = modelOf([
    I('ldr','w8, [x0, #0x20]'),
    I('cmp','w1, #0'),
    I('b.le','#0x100000018'),
    I('add','w8, w8, w1'),
    I('str','w8, [x0, #0x20]'),
    I('ret',''),
    I('sub','w8, w8, #1'),
    I('str','w8, [x0, #0x20]'),
    I('ret',''),
  ],[],[
    {from:2,to:6},{from:2,to:3},{from:5,to:6}
  ]);
  const ir = irFor(model);
  const symbolic = symbolicExecute(ir,{maxPaths:8,maxSteps:200,timeoutMs:1000});
  assert.ok(symbolic.paths.length);
  const text = symbolic.paths.flatMap((p) => p.constraintText || []).join(' ');
  assert.ok(text.includes('arg1') || text.includes('0'));
  const touched = symbolic.paths.flatMap((p) => p.touchedFields || []);
  assert.ok(touched.length);
  assert.ok(touched.some((x) => expressionText(x.value).includes('field')));
});

const failed = results.filter((r) => !r[1]);
console.log(`Integration review results: ${results.length} case(s), ${results.length-failed.length} passed, ${failed.length} failed`);
for (const [name,ok,error] of results) {
  console.log(`${ok?'PASS':'FAIL'} ${name}`);
  if (!ok) console.error(error);
}
if (failed.length) process.exit(1);
