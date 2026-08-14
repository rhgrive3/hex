import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { symbolicExecute } from '../js/symbolic/executor.js';

const BASE=0x100000000n;
function modelOf(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=addr-BASE;return d>=0n&&d<BigInt(lines.length*4)?Number(d/4n):null};
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress});
}

const model=modelOf(['ldr w8, [x0, #0x20]','str w1, [x0, #0x20]','add w0, w8, #1','ret']);
const ir=irFor(model), ret=ir.instructions.find((i)=>i.op===OP.RET);
assert.equal(ret.args?.length||0,0,'RET remains ABI-unknown');
const path=symbolicExecute(ir,{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
assert.ok(path); assert.match(path.returnText,/field\(/); assert.equal(path.returnInferred,true);

const ambiguous=symbolicExecute(irFor(modelOf(['mov x0, #7','ret'])),{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
assert.ok(ambiguous); assert.equal(ambiguous.returnValue,null); assert.equal(ambiguous.returnText,'?'); assert.equal(ambiguous.returnInferred,false);
console.log('issue-130 symbolic compatibility: ok');
