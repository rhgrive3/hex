import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RuntimeAnalysisPlatform } from '../js/runtime/index.js';
import { traceToSemanticFacts } from '../js/runtime-evidence/index.js';
import { functionPaths } from '../js/query/causal.js';
import { forwardSlice } from '../js/slice.js';
import { OP } from '../js/ir.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';

// #433: cross-binary replay must fail closed unless resolver explicitly accepts a strong identity.
const platform = Object.create(RuntimeAnalysisPlatform.prototype);
platform.options = {};
platform.currentSession = () => ({ binaryHash:'target' });
platform.runExperiment = async (experiment) => ({ status:'ran', experiment });
const recording = { binaryHash:'source', experiment:{ id:'e', functionAddress:0x1000n, cases:[] } };
let r = await platform.replayExperiment(recording,{ resolveFunction:async()=>0x2000n });
assert.equal(r.status,'unsupported'); assert.equal(r.reason,'function-re-resolution-ambiguous');
r = await platform.replayExperiment(recording,{ resolveFunction:async()=>({address:0x2000n,accepted:true,confidence:0.7,ambiguityMargin:0.4}) });
assert.equal(r.status,'unsupported');
r = await platform.replayExperiment(recording,{ resolveFunction:async()=>({address:0x2000n,accepted:true,confidence:0.95,ambiguityMargin:0.02}) });
assert.equal(r.status,'unsupported');
r = await platform.replayExperiment(recording,{ resolveFunction:async()=>({address:0x2000n,accepted:true,confidence:0.95,ambiguityMargin:0.3}) });
assert.equal(r.status,'ran'); assert.equal(r.experiment.functionAddress,0x2000n);

// #434: fact limits/source truncation are observable; no silent completeness claim.
let facts = traceToSemanticFacts({events:[{type:'call',target:1n},{type:'return',value:2n}]},{limit:1});
assert.equal(facts.length,1); assert.equal(facts.truncated,true); assert.equal(facts.complete,false); assert.equal(facts.reason,'fact-limit'); assert.equal(facts.processedEvents,1); assert.equal(facts.totalEvents,2);
facts = traceToSemanticFacts({events:[{type:'call',target:1n}],truncated:true,reason:'adapter-limit'});
assert.equal(facts.complete,false); assert.equal(facts.reason,'adapter-limit'); assert.equal(facts[0].traceComplete,false);

// #435: bounded call paths expose truncation reasons while preserving Array compatibility.
const graph = new Map([[1,[{addr:2},{addr:3}]],[2,[{addr:4}]],[3,[{addr:4}]]]);
let paths = functionPaths({functionRange:()=>({end:9}),calleesOf:(a)=>graph.get(a)||[]},1,4,{maxDepth:2,maxVisited:20});
assert.equal(Array.isArray(paths),true); assert.equal(paths.truncated,true); assert.ok(paths.reasons.includes('depth-cap'));
const longGraph = new Map(); for (let i=1;i<=20;i++) longGraph.set(i,[{addr:i+1}]);
paths = functionPaths({functionRange:()=>({end:99}),calleesOf:(a)=>longGraph.get(a)||[]},1,99,{maxDepth:12,maxVisited:16});
assert.equal(paths.truncated,true); assert.ok(paths.reasons.includes('visited-cap') || paths.reasons.includes('depth-cap'));

// #436: a store flows to a load whose Memory-SSA use is a nested/merged phi containing that store.
const seedValue = {id:1,uses:[]};
const store = {id:10,op:OP.STORE,loc:{key:'field:x0:32'},args:[{value:seedValue}],row:1,block:0};
const storeNode = {kind:'store',inst:store};
const phi1 = {kind:'phi',incoming:[{node:storeNode},{node:{kind:'store',inst:{id:99}}}]};
const phi2 = {kind:'phi',incoming:[{node:phi1}]};
const loaded = {id:2,uses:[]};
const load = {id:11,op:OP.LOAD,loc:{key:'field:x0:32'},memUse:phi2,reachingStore:null,dst:loaded,args:[],row:2,block:1};
seedValue.uses=[store];
let sliced=forwardSlice({instructions:[store,load]},seedValue);
assert.ok(sliced.instructions.includes(load));

// #441: protocol declarations remain candidates but can never resolve without an IMP.
let index=buildObjcRuntimeIndex({protocols:[{name:'P',methods:[{selector:'go'}]}],classes:[{name:'C',protocols:['P'],methods:[]}]});
let dispatch=resolveObjcDispatch(index,{receiverType:'C',selector:'go'});
assert.equal(dispatch.resolved,null); assert.equal(dispatch.candidates.length,1); assert.equal(dispatch.candidates[0].source,'protocol');
index=buildObjcRuntimeIndex({protocols:[{name:'P',methods:[{selector:'go'}]}],classes:[{name:'C',protocols:['P'],methods:[{selector:'go',addr:0x1234n}]}]});
dispatch=resolveObjcDispatch(index,{receiverType:'C',selector:'go'});
assert.equal(dispatch.resolved?.imp,0x1234n);

// Structural guards for #437-#440: these are internal helpers, so assert the safety conditions remain in source.
const interproc=fs.readFileSync('js/interproc.js','utf8');
assert.match(interproc,/const trustedReturn = oneReturn && oneReturn\.inferred !== true/);
assert.match(interproc,/BigInt\.asUintN\(bits, raw\)/);
assert.match(interproc,/returnEvidence:/);
const dataflow=fs.readFileSync('js/dataflow-semantic.js','utf8');
assert.match(dataflow,/sameComputationPath/); assert.match(dataflow,/paths\.every\(\(p\) => sameComputationPath/);
const verify=fs.readFileSync('js/verify.js','utf8');
assert.match(verify,/\^\(\?:x2\|w2\)\$/); assert.doesNotMatch(verify,/\[2-7\]/);

console.log('issues #433-#441 runtime/dataflow regressions passed');
