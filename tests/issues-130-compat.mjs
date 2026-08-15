import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates } from '../js/dataflow.js';
import { irFor, OP } from '../js/ir.js';

const BASE=0x100000000n;
function build(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i)*4n,mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)};});
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress:(a)=>Number((a-BASE)/4n),symbolFor:()=>null});
}

const model=build(['mov x19, x0','ldr x8, [x19, #0x10]','str x0, [x19, #0x10]','ldr x0, [x19, #0x10]','ret']);
const ret=irFor(model).instructions.find((i)=>i.op===OP.RET);
assert.ok(ret);
assert.equal(ret.args?.length || 0,0,'#130 regression: untyped RET must not claim x0');
const updates=findValueUpdates(model).filter((u)=>u.location?.disp===0x10n);
const read=updates.find((u)=>u.kind==='read');
assert.ok(read,'terminal self-field load should remain a getter-shaped read');
assert.equal(read.ir?.returnCandidate,true);
assert.ok(updates.some((u)=>u.kind==='write'||u.kind==='move'));

// A non-field x0 definition must not become a synthetic getter/read fact.
const voidLike=build(['mov x0, #7','ret']);
assert.equal(findValueUpdates(voidLike).some((u)=>u.kind==='read'),false);
console.log('issue-130 compatibility regression: ok');
