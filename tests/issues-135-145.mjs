import assert from 'node:assert/strict';
import { analyzeGraph } from '../js/controlflow.js';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, MK } from '../js/ir.js';
import { decompileSemantic, renderBranchCondition } from '../js/decompiler/semantic.js';
import { recoverFunctionPrototype } from '../js/decompiler/types/prototype.js';

// #135/#136: deep graph must not recurse, and dominators are lazy views rather than materialized Sets.
{
  const n = 12000;
  const succ = Array.from({length:n}, (_, i) => i + 1 < n ? [i + 1] : []);
  const g = analyzeGraph(succ, 0);
  assert.equal(g.components.length, n);
  assert.equal(g.dominators[n - 1].has(0), true);
  assert.equal(g.dominators[n - 1] instanceof Set, false);
  assert.equal(g.immediateDominators[n - 1], n - 2);
}

function make(lines, base=0x100000000n) {
  const raw = lines.map((text,row) => { const p=text.indexOf(' '); return {row,address:base+BigInt(row*4),mn:p<0?text:text.slice(0,p),ops:p<0?'':text.slice(p+1)}; });
  const rowOfAddress = (addr) => { const d=BigInt(addr)-base; return d>=0n && d<BigInt(raw.length*4) ? Number(d/4n) : null; };
  return { model:buildSemanticModel(raw,{startRow:0,endRow:raw.length-1,rowOfAddress}), rowOfAddress, base };
}

// #137: signed displacement + base register + SSA frame epoch are part of stack identity.
{
  const {model,rowOfAddress}=make(['str x0, [sp, #32]','str x1, [sp, #-32]','ret']);
  const ir=buildIR(model,{rowOfAddress});
  const stack=[...ir.locations.values()].filter((x)=>x.kind===MK.STACK);
  assert.equal(stack.length,2);
  assert.notEqual(stack[0].key,stack[1].key);
  assert.notEqual(ir.stackSlots[0].name,ir.stackSlots[1].name);
  assert.ok(ir.stackSlots.some((s)=>s.name.includes('_p20')));
  assert.ok(ir.stackSlots.some((s)=>s.name.includes('_m20')));
}

// #138: a recognized NZCV condition without its flag producer stays explicit;
// it must never be lowered to an invented high-level comparison such as !=.
{
  const fakeCtx={};
  const inst={op:'cbr',cond:'vs',extra:{kind:'cond'},args:[]};
  const text=renderBranchCondition(inst,fakeCtx);
  assert.match(text,/condition_vs/);
  assert.doesNotMatch(text,/!=/);
}

// #143/#144: both FP register bank and entry-SP stack arguments are represented.
{
  const v0={id:20,uses:[{}]}, x0={id:10,uses:[{}]}, sp={id:30,uses:[]};
  const ir={args:new Map([['x0',x0],['v0',v0],['sp',sp]]),instructions:[{op:'load',loc:{kind:'stack',baseReg:'sp',frameEpoch:30,disp:0n,key:'stack:sp:e30:0'},memUse:{kind:'entry'},dst:{id:40}}]};
  const p=recoverFunctionPrototype(ir,{values:new Map(),ret:{kind:'double',name:'double',bits:64,confidence:0.9}});
  assert.ok(p.argumentBanks.integer.some((a)=>a.reg==='x0'));
  assert.ok(p.argumentBanks.fp.some((a)=>a.reg==='v0'));
  assert.equal(p.argumentBanks.stack[0].stackOffset,0n);
  assert.equal(p.returnLocations[0].reg,'v0');
}

// #145: <=128-bit aggregate return occupies x0/x1 when type evidence proves it.
{
  const p=recoverFunctionPrototype({args:new Map(),instructions:[]},{values:new Map(),ret:{kind:'aggregate',name:'Pair',bits:128,confidence:0.8}});
  assert.deepEqual(p.returnLocations.map((x)=>x.reg),['x0','x1']);
}

console.log('issues-135-145: ok');
