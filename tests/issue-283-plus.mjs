import assert from 'node:assert/strict';
import { fitCalibration } from '../js/calib.js';
import { matchFormulas, findAccumulators, findSink } from '../js/comprehend.js';
import { rankCandidates } from '../js/rank.js';
import { GOALS } from '../js/goals.js';

let passed=0;
async function test(name,fn){try{await fn();passed++;console.log('ok',name);}catch(e){console.error('not ok',name);throw e;}}

await test('calibration curve is monotone after PAV',()=>{
  const rows=[];
  for(let i=0;i<60;i++){
    const score=(i%6+0.5)/6;
    // Deliberately anti-correlated outcomes to force raw reliability bins to decrease.
    const verified=(i%6)<3 ? 1 : 0;
    rows.push({score,verified});
  }
  const curve=fitCalibration(rows,6);
  assert.ok(curve && curve.length>=3);
  for(let i=1;i<curve.length;i++) assert.ok(curve[i].observed+1e-12>=curve[i-1].observed);
});

await test('formula verification requires matching operator as well as constant',()=>{
  const result={k:'reg',reg:'result'};
  const add={k:'bin',op:'add',a:result,b:{k:'const',value:100n}};
  const wrong=matchFormulas([{row:1,address:0x1000n,expr:add}],[{row:0,text:'damage ×100'}],null);
  assert.equal(wrong,null);
  const mul={k:'bin',op:'mul',a:result,b:{k:'const',value:100n}};
  const right=matchFormulas([{row:1,address:0x1000n,expr:mul}],[{row:0,text:'damage ×100'}],null);
  assert.ok(right && right.matched>=1);
});

await test('accumulator chain cannot join mutually unreachable blocks',()=>{
  const a0={k:'reg',reg:'x19',version:0}, a1={k:'bin',op:'add',a:a0,b:{k:'const',value:10n}};
  const b0={k:'reg',reg:'x19',version:2}, b1={k:'bin',op:'add',a:b0,b:{k:'const',value:20n}};
  const defs=new Map([[1,{x19:a1}],[3,{x19:b1}]]);
  const vg={defs,at:(row,reg)=>row===1?a0:row===3?b0:null};
  const model={instructions:[{row:1,address:0x1004n},{row:3,address:0x100cn}],basicBlocks:[{rows:[1],successors:[]},{rows:[3],successors:[]}]};
  const runs=findAccumulators(model,vg);
  assert.equal(runs.length,2);
  assert.ok(runs.every((r)=>r.steps.length===1));
});

await test('sink in unreachable sibling block is ignored',()=>{
  const result={k:'reg',reg:'x19',version:1};
  const acc={steps:[{row:1,address:0x1004n,after:result,expr:result}]};
  const vg={at:()=>result,defs:new Map()};
  const model={instructions:[
    {row:1,address:0x1004n,mnemonic:'add'},
    {row:3,address:0x100cn,mnemonic:'str',memory:{kind:'store',stack:false},reads:['x19']},
  ],calls:[],basicBlocks:[{rows:[1],successors:[]},{rows:[3],successors:[]}]};
  assert.equal(findSink(model,vg,acc),null);
});

await test('rank expands every matched string and reports capped xref source',()=>{
  const strings=Array.from({length:450},(_,i)=>({addr:BigInt(0x2000+i*8),text:'hp value '+i,region:'r'}));
  let calls=0;
  const program={refsCapped:true,callCount:0,refCount:1,functionsReferencing:()=>{calls++;return[];},callersOf:()=>[],statsOf:()=>({total:1}),callCountOf:()=>0,functionRange:()=>null};
  const symbols={symbolCount:0,functionCount:0,addrs:new BigUint64Array(),names:[],nameAt:()=>null,isFunctionStart:()=>false};
  const out=rankCandidates({goal:GOALS.find((g)=>g.id==='hp'),strings,program,symbols,region:{vmAddr:0x1000n,size:0x1000n}});
  assert.equal(calls,out.matchedStrings.length);
  assert.equal(out.stringEvidenceComplete,false);
  assert.ok(calls>300);
});

console.log(`issue-283-plus: ${passed} tests passed`);
