import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evidenceFromExperiment } from '../js/runtime-evidence/index.js';
import { classifyHypothesis, HypothesisVerifier } from '../js/dynamic/experiments.js';
import { runtimeIdentityForApp } from '../js/runtime/app-runtime.js';

const base={experiment:{id:'e',functionAddress:0x1000n,binaryHash:'H'},testCase:{id:'c',input:{}},observation:{},comparison:{status:'supported'}};
assert.equal(evidenceFromExperiment({...base,replayable:false}).reproducibility.replayable,false);
assert.equal(evidenceFromExperiment({...base,replayable:true}).reproducibility.replayable,true);

const supported=[1,2,3].map(()=>({comparison:{status:'supported'}}));
assert.equal(classifyHypothesis(supported,{planned:4,executed:3,complete:false,truncated:true,reasons:['max-cases']}).status,'supported');
assert.equal(classifyHypothesis(supported,{planned:3,executed:3,complete:true,truncated:false,reasons:[]}).status,'confirmed');
const contradicted=[{comparison:{status:'contradicted'}}];
assert.equal(classifyHypothesis(contradicted,{planned:10,executed:1,complete:false,truncated:true,reasons:['stop-on-contradiction']}).status,'contradicted');

const adapter={
  async launch(){},
  async resume(){return {stop:{kind:'return'},memoryAfter:[{offset:0n,value:1n}],memoryDelta:[],returnValue:null};}
};
const exp={id:'v',functionAddress:0x1000n,cases:[0,1,2].map((_,i)=>({id:'c'+i,input:{arguments:[]},initialState:{fields:[],objectBase:0n},watch:[],expected:{returnValue:1n}}))};
adapter.resume=async()=>({stop:{kind:'return'},memoryAfter:[],memoryDelta:[],returnValue:1n});
const verifier=new HypothesisVerifier(adapter);
let out=await verifier.verify(exp,{maxCases:2,stopOnContradiction:false});
assert.equal(out.coverage.complete,false); assert.equal(out.verdict.status,'supported'); assert.equal(out.coverage.executed,2);
out=await verifier.verify(exp,{maxCases:3,stopOnContradiction:false});
assert.equal(out.coverage.complete,true); assert.equal(out.verdict.status,'confirmed');

const app={
  store:{get(k){if(k==='sliceIndex')return 1;if(k==='fileInfo')return {slices:[{}, {info:{uuid:'U',architecture:'arm64'}}]};if(k==='architecture')return 'arm64';return null;}},
  backend:{contentHash:null,async ensureContentHash(){return 'HASH';}}
};
assert.deepEqual(await runtimeIdentityForApp(app),{contentHash:'HASH',sliceIdentity:'slice:1:U:arm64',key:'HASH|slice:1:U:arm64'});

const context=fs.readFileSync('js/ai/ui/hex-context.js','utf8');
assert.doesNotMatch(context,/verified:\s*results\.length\s*>\s*0/);
assert.match(context,/confirmedCompleteReplayable/);
const runtime=fs.readFileSync('js/runtime/index.js','utf8');
assert.match(runtime,/replayable:isReplayable\(session\.adapter,observation/);
assert.match(runtime,/sliceIdentity:this\.options\.sliceIdentity/);
console.log('issues #173 #255 #540 #542 regressions passed');
