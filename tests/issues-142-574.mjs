import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor } from '../js/ir.js';

function stackLoad(key, row = null, address = null) {
  return expr.load({ kind:'stack', key }, 32, { row, address });
}

function multiReturnFixture({ ambiguous = false, single = false } = {}) {
  const key='stack:sp:e0:-16:s4';
  const base=0x100000000n;
  const v1={id:1}, v2={id:2};
  const store1={id:1,op:'store',block:0,row:0,address:base,loc:{key,kind:'stack'},args:[{value:v1}]};
  const ret1={id:2,op:'ret',block:0,row:1,address:base+4n,args:[]};
  const store2={id:3,op:'store',block:1,row:2,address:base+8n,loc:{key,kind:'stack'},args:[{value:v2}]};
  const ret2={id:4,op:'ret',block:1,row:3,address:base+12n,args:[]};
  const instructions=single?[store1,ret1]:[store1,ret1,store2,ret2];
  const blocks=single?[{index:0,pred:[],succ:[],insts:[store1,ret1]}]:[
    {index:0,pred:[],succ:[],insts:[store1,ret1]},
    {index:1,pred:[],succ:[],insts:[store2,ret2]},
  ];
  const load1=stackLoad(key,1,base+4n), load2=stackLoad(key,3,base+12n);
  const n1={kind:'stmt',indent:0,text:'return local_a;',semantic:{op:'return',expression:load1},source:ambiguous?{rows:[],addresses:[],ir:[]}:{rows:[1],addresses:[base+4n],ir:[2]}};
  const body=[n1];
  if(!single) body.push({kind:'stmt',indent:0,text:'return local_b;',semantic:{op:'return',expression:load2},source:ambiguous?{rows:[],addresses:[],ir:[]}:{rows:[3],addresses:[base+12n],ir:[4]}});
  return {
    semantic:true,
    ir:{instructions,blocks},
    semanticAst:{values:[{valueId:1,expression:expr.constant(11n,32,true)},{valueId:2,expression:expr.constant(22n,32,true)}],conditions:[],outputs:[{name:'return',expression:load1}]},
    cAst:{body}, rewriteProof:[], metrics:{},
  };
}

{
  const r=multiReturnFixture(); recoverExactStackPhiExpressions(r,{decompilerTimeBudgetMs:50});
  assert.match(r.cAst.body[0].text,/return 11;/); assert.match(r.cAst.body[1].text,/return 22;/); assert.notEqual(r.cAst.body[0].text,r.cAst.body[1].text);
}
{
  const r=multiReturnFixture({ambiguous:true}); recoverExactStackPhiExpressions(r,{decompilerTimeBudgetMs:50});
  assert.equal(r.cAst.body[0].text,'return local_a;'); assert.equal(r.cAst.body[1].text,'return local_b;');
}
{
  const r=multiReturnFixture({ambiguous:true,single:true}); recoverExactStackPhiExpressions(r,{decompilerTimeBudgetMs:50}); assert.match(r.cAst.body[0].text,/return 11;/);
}

const BASE=0x100000000n;
function modelOf(lines) {
  const rows=lines.map((line,i)=>{const s=line.trim(),p=s.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?s:s.slice(0,p),ops:p<0?'':s.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=BigInt(addr)-BASE;return d<0n||d>=BigInt(lines.length*4)?null:Number(d/4n)};
  return {model:buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress}),rowOfAddress};
}
function build(lines){const {model,rowOfAddress}=modelOf(lines);return irFor(model,{rowOfAddress,cacheRevision:'issue-574'});}
function atRow(ir,row,op){return (ir.instructions||[]).find((x)=>x.row===row&&x.op===op);}

{
  const ir=build(['mov x20, x19','str w8, [x20, #0x20]','ldr w9, [x19, #0x20]','ret']);
  const st=atRow(ir,1,'store'), ld=atRow(ir,2,'load'); assert.ok(st&&ld); assert.equal(st.loc.key,ld.loc.key); assert.equal(ld.reachingStore,st);
}
{
  const ir=build(['add x20, x19, #0','str w8, [x20, #0x20]','ldr w9, [x19, #0x20]','ret']);
  const st=atRow(ir,1,'store'), ld=atRow(ir,2,'load'); assert.ok(st&&ld); assert.equal(st.loc.key,ld.loc.key); assert.equal(ld.reachingStore,st);
}
{
  const ir=build(['str w8, [x19, #0x20]','str w9, [x20, #0x20]','ldr w10, [x19, #0x20]','ret']);
  const first=atRow(ir,0,'store'), second=atRow(ir,1,'store'), ld=atRow(ir,2,'load');
  assert.ok(first&&second&&ld); assert.notEqual(first.loc.key,second.loc.key); assert.notEqual(ld.reachingStore,first,'potentially aliasing store must clobber stale reaching store'); assert.equal(ld.memUse?.kind,'clobber');
}
{
  const t=(row)=>'0x'+(BASE+BigInt(row*4)).toString(16);
  const ir=build([`cbz w0, ${t(4)}`,'mov x21, x19',`b ${t(5)}`,'nop','mov x21, x19','str w8, [x21, #0x20]','ldr w9, [x19, #0x20]','ret']);
  const st=atRow(ir,5,'store'), ld=atRow(ir,6,'load');
  const shape=(ir.instructions||[]).map((x)=>({row:x.row,op:x.op,sub:x.sub,block:x.block,loc:x.loc?.key,dst:x.dst?.reg,args:(x.args||[]).map((a)=>a?.value?.reg||a?.value?.id||a?.reg||a?.value||null)}));
  assert.ok(st&&ld,JSON.stringify(shape)); assert.equal(st.loc.key,ld.loc.key); assert.equal(ld.reachingStore,st);
}

console.log('issues #142/#574 regressions passed');
