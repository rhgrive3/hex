import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { buildCfg, EDGE } from '../js/cfg.js';

const BASE=0x100000000n;
function make(lines){
  const raw=lines.map((text,row)=>{const p=text.indexOf(' ');return {row,address:BASE+BigInt(row*4),mn:p<0?text:text.slice(0,p),ops:p<0?'':text.slice(p+1)}});
  const rowOfAddress=(a)=>{const d=BigInt(a)-BASE;return d>=0n&&d<BigInt(raw.length*4)?Number(d/4n):null};
  return {model:buildSemanticModel(raw,{startRow:0,endRow:raw.length-1,rowOfAddress}),rowOfAddress};
}

// #130: an untyped RET must not invent x0 as a semantic source.
{
  const {model,rowOfAddress}=make(['ret']);
  const ir=buildIR(model,{rowOfAddress});
  const ret=ir.instructions.find((i)=>i.op===OP.RET);
  assert.equal(ret.args.length,0);
}
// #131: an unknown CALL has no fabricated result; typed evidence may select v0.
{
  const target=BASE+8n;
  const {model,rowOfAddress}=make([`bl #0x${target.toString(16)}`,'ret','ret']);
  let ir=buildIR(model,{rowOfAddress});
  assert.equal(ir.instructions.find((i)=>i.op===OP.CALL).dst,null);
  ir=buildIR(model,{rowOfAddress,callPrototypeFor:()=>({returnType:'double',returnClass:'fp',returnBits:64})});
  assert.equal(ir.instructions.find((i)=>i.op===OP.CALL).dst?.reg,'v0');
}
// #132: conditional branch outside function is TAKEN, while fallthrough remains local.
{
  const raw=[{row:0,address:BASE,mn:'b.eq',ops:'#0x200000000'},{row:1,address:BASE+4n,mn:'ret',ops:''}];
  const model=buildSemanticModel(raw,{startRow:0,endRow:1,rowOfAddress:()=>null});
  const cfg=buildCfg(model,{rowOfAddress:()=>null});
  assert.ok(cfg.nodes[0].succ.some((s)=>s.outside&&s.kind===EDGE.TAKEN));
  assert.ok(cfg.nodes[0].succ.some((s)=>s.kind===EDGE.FALL));
}
// #133: taken successor is thenBlock, fallthrough successor is elseBlock.
{
  const {model,rowOfAddress}=make(['cmp w0, #0',`b.eq #0x${(BASE+16n).toString(16)}`,'mov w1, #1',`b #0x${(BASE+20n).toString(16)}`,'mov w1, #2','ret']);
  const cfg=buildCfg(model,{rowOfAddress});
  const shape=cfg.shapes.find((s)=>s.kind==='if-else');
  assert.ok(shape);
  const branch=cfg.nodes[shape.at];
  assert.equal(shape.thenBlock,branch.succ.find((s)=>s.kind===EDGE.TAKEN).to);
  assert.equal(shape.elseBlock,branch.succ.find((s)=>s.kind===EDGE.FALL).to);
}
console.log('issues-129-134: ok');
