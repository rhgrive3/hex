import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { summarizeFunction } from '../js/interproc.js';

const BASE=0x100000000n;
function modelOf(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=addr-BASE;return d>=0n&&d<BigInt(lines.length*4)?Number(d/4n):null};
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress});
}

const arithmetic=modelOf(['add x0, x0, #5','ret']);
assert.equal(irFor(arithmetic).instructions.find((i)=>i.op===OP.RET).args?.length||0,0,'IR RET stays ABI-unknown');
const wrapper=summarizeFunction(arithmetic,{returnEvidence:{trusted:true,source:'prototype-fixture'}});
assert.equal(wrapper.classification.simpleArithmeticWrapper,true);
assert.equal(wrapper.returns[0].kind,'argument-arithmetic');
assert.equal(wrapper.returns[0].inferred,true);
assert.equal(wrapper.returns[0].trusted,true);

const getter=summarizeFunction(modelOf(['ldr x0, [x0, #0x20]','ret']),{returnEvidence:{trusted:true,source:'prototype-fixture'}});
assert.equal(getter.classification.getter,true);
assert.equal(getter.returns[0].kind,'field');
assert.equal(getter.returns[0].trusted,true);

// x0 surviving from function entry is not enough to invent a return value.
const setter=summarizeFunction(modelOf(['str x2, [x0, #0x20]','ret']));
assert.equal(setter.classification.setter,true);
assert.equal(setter.returns[0].kind,'void');
assert.equal(setter.returns[0].inferred,undefined);

console.log('issue-130 interproc compatibility: ok');
