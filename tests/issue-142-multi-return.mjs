import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';

const BASE = 0x100000000n;
const KEY = 'stack:sp:e0:-16:s4';

function stackLoad(row = null, address = null) {
  return expr.load({ kind:'stack', key:KEY }, 32, { row, address });
}
function retNode(text, expression, ret, source = true) {
  return {
    kind:'stmt', indent:0, text,
    semantic:{ op:'return', expression },
    source:source ? { rows:[ret.row], addresses:[ret.address], ir:[ret.id] } : { rows:[], addresses:[], ir:[] },
  };
}
function linearResult(values, { ambiguous=false, order=null } = {}) {
  const instructions = [];
  const blocks = [];
  const ast = [];
  const semanticValues = [];
  const rets = [];
  for (let i = 0; i < values.length; i++) {
    const value = { id:100 + i };
    const store = { id:10 + i * 2, op:'store', block:i, row:i * 2, address:BASE + BigInt(i * 8), loc:{ key:KEY, kind:'stack' }, args:[{ value }] };
    const ret = { id:11 + i * 2, op:'ret', block:i, row:i * 2 + 1, address:BASE + BigInt(i * 8 + 4), args:[] };
    instructions.push(store, ret);
    blocks.push({ index:i, startRow:store.row, endRow:ret.row, pred:[], succ:[], insts:[store, ret] });
    semanticValues.push({ valueId:value.id, expression:expr.constant(BigInt(values[i]), 32, true) });
    ast.push(retNode(`return local_${i};`, stackLoad(ret.row, ret.address), ret, !ambiguous));
    rets.push(ret);
  }
  const body = order ? order.map((i) => ast[i]) : ast;
  return {
    semantic:true,
    ir:{ instructions, blocks, idom:blocks.map(() => -1) },
    semanticAst:{ values:semanticValues, conditions:[], outputs:[{ name:'return', expression:stackLoad(rets.at(-1)?.row, rets.at(-1)?.address) }] },
    cAst:{ body }, rewriteProof:[], metrics:{ rewrittenExpressions:0 },
  };
}

// Multiple physical RETs must recover independently, never from the final RET globally.
{
  const result = linearResult([11, 22]);
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  assert.match(result.cAst.body[0].text, /return 11;/);
  assert.match(result.cAst.body[1].text, /return 22;/);
  assert.notEqual(result.cAst.body[0].text, result.cAst.body[1].text);
  assert.equal(result.metrics.rewrittenExpressions, 2);
}

// An early non-stack error return must not be overwritten by a later stack recovery.
{
  const result = linearResult([11, 22]);
  const firstRet = result.ir.instructions.find((x) => x.op === 'ret' && x.block === 0);
  result.cAst.body[0] = retNode('return -1;', expr.constant(-1n, 32, true), firstRet, true);
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  assert.equal(result.cAst.body[0].text, 'return -1;');
  assert.match(result.cAst.body[1].text, /return 22;/);
}

// Multiple early returns stay path-local; only the stack-backed site is rewritten.
{
  const result = linearResult([11, 22, 33]);
  const returns = result.ir.instructions.filter((x) => x.op === 'ret');
  result.cAst.body[0] = retNode('return -1;', expr.constant(-1n, 32, true), returns[0], true);
  result.cAst.body[1] = retNode('return 0;', expr.constant(0n, 32, true), returns[1], true);
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  assert.equal(result.cAst.body[0].text, 'return -1;');
  assert.equal(result.cAst.body[1].text, 'return 0;');
  assert.match(result.cAst.body[2].text, /return 33;/);
}

// With multiple RETs, missing source provenance is ambiguous and must fail closed.
{
  const result = linearResult([11, 22], { ambiguous:true });
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  assert.deepEqual(result.cAst.body.map((x) => x.text), ['return local_0;', 'return local_1;']);
  assert.equal(result.metrics.rewrittenExpressions, 0);
}

// A single AST return + single physical RET retains the old safe fallback.
{
  const result = linearResult([11], { ambiguous:true });
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  assert.match(result.cAst.body[0].text, /return 11;/);
}

// Return mapping is source-based, not dependent on cAst array order.
{
  const result = linearResult([11, 22], { order:[1, 0] });
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  const byRow = new Map(result.cAst.body.map((node) => [node.source.rows[0], node.text]));
  assert.match(byRow.get(1), /return 11;/);
  assert.match(byRow.get(3), /return 22;/);
}

// Shared epilogue: one physical RET may reconstruct a precise CFG/Memory-SSA join.
{
  const v1={id:201}, v2={id:202};
  const cbr={id:1,op:'cbr',block:0,row:0,address:BASE,args:[],extra:{target:BASE+4n}};
  const s1={id:2,op:'store',block:1,row:1,address:BASE+4n,loc:{key:KEY,kind:'stack'},args:[{value:v1}]};
  const s2={id:3,op:'store',block:2,row:2,address:BASE+8n,loc:{key:KEY,kind:'stack'},args:[{value:v2}]};
  const ret={id:4,op:'ret',block:3,row:3,address:BASE+12n,args:[]};
  const condition=expr.compare('eq',expr.variable('flag',32,false),expr.constant(0n,32,false),false);
  const result={
    semantic:true,
    ir:{
      instructions:[cbr,s1,s2,ret],
      blocks:[
        {index:0,startRow:0,endRow:0,pred:[],succ:[1,2],insts:[cbr]},
        {index:1,startRow:1,endRow:1,pred:[0],succ:[3],insts:[s1]},
        {index:2,startRow:2,endRow:2,pred:[0],succ:[3],insts:[s2]},
        {index:3,startRow:3,endRow:3,pred:[1,2],succ:[],insts:[ret]},
      ],
      idom:[-1,0,0,0],
    },
    semanticAst:{
      values:[{valueId:201,expression:expr.constant(11n,32,true)},{valueId:202,expression:expr.constant(22n,32,true)}],
      conditions:[{ir:1,expression:condition}],
      outputs:[{name:'return',expression:stackLoad(ret.row,ret.address)}],
    },
    cAst:{body:[retNode('return local_join;',stackLoad(ret.row,ret.address),ret,true)]},
    rewriteProof:[], metrics:{rewrittenExpressions:0},
  };
  const rowOfAddress=(addr)=>Number((BigInt(addr)-BASE)/4n);
  recoverExactStackPhiExpressions(result,{decompilerTimeBudgetMs:50,rowOfAddress});
  assert.match(result.cAst.body[0].text,/\?/);
  assert.match(result.cAst.body[0].text,/11/);
  assert.match(result.cAst.body[0].text,/22/);
}

console.log('issue #142 multi-return stack-phi recovery: PASS');
