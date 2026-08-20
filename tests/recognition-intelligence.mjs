import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FUNCTION_FINGERPRINT_VERSION, fingerprintFunction, compareFingerprints, normalizeInstruction } from '../js/fingerprint/index.js';
import { FunctionMatchIndex, matchFunctions, matchFunctionsFast, recognitionMetrics, calibrationReport } from '../js/recognition/matcher.js';
import { classifyFunction, discoverSubsystems, applicationCodeScore, rankApplicationFunctions, clusterFunctions, classificationMetrics } from '../js/recognition/classifier.js';
import { recognizeLibraries, createKnowledgePack, importKnowledgePack } from '../js/signature/index.js';
import { KnowledgeDB } from '../js/knowledge/index.js';
import { diffFunctions } from '../js/diff/index.js';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

const cfg = { blocks:2, edges:1, exits:1, loops:0, calls:1 };
const base = { address:0x1000n, architecture:'arm64', bytes:Uint8Array.from([1,2,3,4,5,6,7,8]), instructions:['stp x29, x30, [sp,#-0x20]!', 'add x3, x1, x2', 'str x3, [x0,#0x20]', 'ret'], cfg, strings:['coins'], imports:['memcpy'], calls:['helper'], constants:[100], semantic:{reads:['field:0x20'],writes:['field:0x20'],rmw:['field:0x20'],operations:['add'],returnOrigin:'void'} };

// exact / moved
let a=fingerprintFunction(base), b=fingerprintFunction({...base,address:0x9000n});
assert.equal(compareFingerprints(a,b).identity,'exact');
let d=diffFunctions([base],[{...base,address:0x9000n}]);
assert.equal(d.matches[0].changeType,'moved');
assert.equal(matchFunctionsFast([base],[{...base,address:0x9010n}]).matches[0].identity,'exact');

// relocation normalization and missing/empty safety
const relocation=[{offset:0,width:8}];
const relocA=fingerprintFunction({...base,bytes:Uint8Array.from([1,2,3,4,5,6,7,8]),relocationOffsets:relocation,instructions:[]});
const relocB=fingerprintFunction({...base,bytes:Uint8Array.from([9,9,9,9,9,9,9,9]),relocationOffsets:relocation,instructions:[]});
assert.equal(relocA.normalizedBytesHash,relocB.normalizedBytesHash);
assert.equal(compareFingerprints(relocA,relocB).identity,'normalized-identical');
const emptyA=fingerprintFunction({address:1n,bytes:new Uint8Array(0)}), emptyB=fingerprintFunction({address:2n,bytes:new Uint8Array(0)});
assert.equal(emptyA.normalizedBytesHash,null);
assert.equal(compareFingerprints(emptyA,emptyB).identity,'unrelated');
assert.equal(compareFingerprints(emptyA,emptyB).reasons.includes('strings'),false);

// register allocation changes survive normalized operands
const regA=fingerprintFunction({...base,bytes:Uint8Array.from([1,2,3,4]),instructions:['add x3, x1, x2','str x3, [x0,#0x20]']});
const regB=fingerprintFunction({...base,bytes:Uint8Array.from([9,8,7,6]),instructions:['add x11, x8, x9','str x11, [x4,#0x20]']});
assert.equal(regA.normalizedOperandsHash,regB.normalizedOperandsHash);
assert.equal(normalizeInstruction('str x3, [x0, #0x20]').operands.includes('#32'), true, 'field offsets must remain semantic constants');
assert.equal(normalizeInstruction('adrp x8, #0x100120000').operands.includes('@address'), true, 'relocatable addresses normalize');
const aliasSame=fingerprintFunction({...base,bytes:null,semantic:{},cfg:{},strings:[],imports:[],calls:[],constants:[],instructions:['add x3,x1,x1','ret']});
const aliasDifferent=fingerprintFunction({...base,bytes:null,semantic:{},cfg:{},strings:[],imports:[],calls:[],constants:[],instructions:['add x3,x1,x2','ret']});
assert.notEqual(aliasSame.normalizedOperandsHash,aliasDifferent.normalizedOperandsHash,'register normalization preserves same-vs-different aliases');
const spoofA=fingerprintFunction({address:30n,size:4,byteHash:'same-precomputed-hash'}), spoofB=fingerprintFunction({address:31n,size:8,byteHash:'same-precomputed-hash'});
assert.notEqual(compareFingerprints(spoofA,spoofB).identity,'exact','equal precomputed hash with different size is not exact identity');
assert.ok(compareFingerprints(regA,regB).confidence>=0.78);
const stackA=fingerprintFunction({...base,bytes:null,instructions:['sub sp, sp, #0x40','ldr x8, [sp,#0x20]','add x1,x2,x3']});
const stackB=fingerprintFunction({...base,bytes:null,address:77n,instructions:['sub sp, sp, #0x80','ldr x9, [sp,#0x60]','add x4,x5,x6']});
assert.equal(stackA.normalizedOperandsHash,stackB.normalizedOperandsHash,'stack layout and register allocation normalize');
const schedA=fingerprintFunction({...base,bytes:null,instructions:['add x1,x2,x3','eor x4,x5,x6','ret']});
const schedB=fingerprintFunction({...base,bytes:null,address:78n,instructions:['eor x9,x10,x11','add x7,x8,x12','ret']});
assert.equal(schedA.instructionBagHash,schedB.instructionBagHash,'instruction scheduling keeps bag identity');
assert.equal(schedA.normalizedOperandBagHash,schedB.normalizedOperandBagHash,'scheduling-tolerant operand bag preserves local register roles');

// compiler noise/scheduling: semantic fingerprint can carry identity across minor optimization.
const optA=fingerprintFunction({...base,bytes:Uint8Array.from([1,2,3,4]),instructions:['add x3, x1, x2','str x3, [x0,#0x20]']});
const optB=fingerprintFunction({...base,address:0x2000n,bytes:Uint8Array.from([4,3,2,1]),instructions:['paciasp','add x9, x7, x8','nop','str x9, [x2,#0x20]','autiasp']});
assert.equal(compareFingerprints(optA,optB).identity,'semantic-equivalent');

// semantic modification is not semantic-equivalent and diff calls out clamp.
const clamped={...base,address:0x3000n,bytes:Uint8Array.from([1,2,3,4,9,9,9,9]),constants:[100,999999],semantic:{...base.semantic,thresholds:[999999],operations:['add','min','clamp']}};
const semCmp=compareFingerprints(fingerprintFunction(base),fingerprintFunction(clamped));
assert.notEqual(semCmp.identity,'semantic-equivalent');
d=diffFunctions([base],[clamped],{threshold:0.45});
assert.equal(d.matches.length,1);
assert.ok(d.matches[0].semanticChange.tags.includes('clamp-introduced'));

// Common prefixes and one correlated signal family are insufficient identity evidence.
const longA=Uint8Array.from({length:1024},(_,i)=>i<300?0x55:(i*13)&255);
const longB=Uint8Array.from({length:1024},(_,i)=>i<300?0x55:(i*29+7)&255);
const longCmp=compareFingerprints(fingerprintFunction({address:40n,architecture:'arm64',bytes:longA}),fingerprintFunction({address:41n,architecture:'arm64',bytes:longB}));
assert.ok(longCmp.confidence<0.55,'stratified sampling prevents common-prefix false matches');
const instructionOnlyA={address:42n,architecture:'arm64',size:16,instructions:['mov x8,x9','add x8,x8,#1','ret']};
const instructionOnlyB={address:43n,architecture:'arm64',size:16,instructions:['mov x20,x21','add x20,x20,#1','ret']};
assert.equal(matchFunctions([instructionOnlyA],[instructionOnlyB]).matches.length,0,'correlated instruction evidence alone is not identity');
const staleFast={schema:'hex.function-fingerprint-fast',version:2,address:44n,architecture:'arm64',size:16,instructionSequenceHash:'legacy'};
assert.equal(new FunctionMatchIndex([staleFast]).items[0].version,FUNCTION_FINGERPRINT_VERSION,'stale fast fingerprints are upgraded before indexing');

// unrelated collision resistance: same size/empty metadata alone cannot match.
const unrelated1=fingerprintFunction({address:10n,architecture:'arm64',size:64,bytes:Uint8Array.from({length:64},(_,i)=>i),cfg:{blocks:4,edges:3,exits:1}});
const unrelated2=fingerprintFunction({address:11n,architecture:'arm64',size:64,bytes:Uint8Array.from({length:64},(_,i)=>(i*71+13)&255),cfg:{blocks:4,edges:3,exits:1}});
assert.ok(compareFingerprints(unrelated1,unrelated2).confidence<0.55);
assert.equal(matchFunctions([unrelated1],[unrelated2]).matches.length,0);

// ambiguous near tie retained.
const ambBefore={...base,address:100n,bytes:null,instructions:['add x3,x1,x2','ret'],semantic:{reads:['a'],writes:['b'],operations:['add']}};
const ambAfter1={...ambBefore,address:201n}; const ambAfter2={...ambBefore,address:202n};
const amb=matchFunctions([ambBefore],[ambAfter1,ambAfter2]);
assert.equal(amb.matches[0].ambiguous,true);
assert.equal(amb.matches[0].candidates.length>=1,true);

// call graph neighborhood is supplemental, never sole evidence.
const beforeN=[{...base,address:1n,callers:[],callees:['2']},{...base,address:2n,name:'child',bytes:null,instructions:['sub x1,x1,#1','ret'],semantic:{reads:['x'],writes:['x'],operations:['sub']},callers:['1'],callees:[]}];
const afterN=[{...base,address:11n,callers:[],callees:['22']},{...beforeN[1],address:22n,callers:['11']}];
const neigh=matchFunctions(beforeN,afterN);
assert.equal(neigh.matches.length,2);
assert.ok(neigh.matches.some((x)=>x.reasons.includes('call-neighborhood')) || neigh.matches.every((x)=>x.confidence>=0.9));

// ObjC / Swift fingerprints.
const objcA=fingerprintFunction({...base,bytes:null,objcClass:'PlayerData',objcSelector:'addCoins:',objcSelectors:['addCoins:','save'],objcIvars:['_coins']});
const objcB=fingerprintFunction({...base,bytes:null,address:4n,objcClass:'PlayerData',objcSelector:'addCoins:',objcSelectors:['addCoins:','save'],objcIvars:['_coins']});
assert.ok(compareFingerprints(objcA,objcB).reasons.includes('objc-profile'));
const swiftA=fingerprintFunction({...base,bytes:null,swiftTypeDescriptor:'Game.PlayerData',swiftMetadata:['Game.PlayerData'],swiftConformances:['Codable']});
const swiftB=fingerprintFunction({...base,bytes:null,address:5n,swiftTypeDescriptor:'Game.PlayerData',swiftMetadata:['Game.PlayerData'],swiftConformances:['Codable']});
assert.ok(compareFingerprints(swiftA,swiftB).reasons.includes('swift-profile'));

// vendor/library recognition requires evidence and never asserts confirmation.
const libs=recognizeLibraries({libraries:['/Frameworks/UnityFramework.framework/UnityFramework'],symbols:['il2cpp_codegen_register','il2cpp_object_new']});
assert.ok(libs.some((x)=>x.name==='Unity'));
assert.ok(libs.some((x)=>x.name==='IL2CPP'));
const unityOnly=recognizeLibraries({libraries:['/Frameworks/UnityFramework.framework/UnityFramework'],symbols:[]}); assert.equal(unityOnly.some((x)=>x.name==='IL2CPP'),false,'UnityFramework alone must not prove IL2CPP');
assert.ok(libs.every((x)=>x.confirmed===false));

// application ranking + subsystem candidates.
const appFn={...base,bytes:null,objcClass:'PlayerData',strings:['reward','coins'],semantic:{writes:['coins'],thresholds:[999999],operations:['add','clamp']}};
assert.equal(classifyFunction(appFn,{notKnownVendor:true,calledFromApplication:true}).classification,'APPLICATION');
assert.ok(applicationCodeScore(appFn,{notKnownVendor:true,calledFromApplication:true})>0.6);
assert.ok(discoverSubsystems(appFn).some((x)=>x.subsystem==='economy/reward'));
assert.equal(classifyFunction(base,{owningLibrary:'/usr/lib/libSystem.B.dylib'}).classification,'SYSTEM');
const cAppRuntimeCalls={address:55n,architecture:'arm64',imports:['malloc','free'],instructions:['bl malloc','bl free','ret']};
assert.notEqual(classifyFunction(cAppRuntimeCalls,{libraries:['Foundation.framework','/usr/lib/libSystem.B.dylib']}).classification,'RUNTIME','linked frameworks plus malloc/free do not imply runtime ownership');
const fallbackVendor=recognizeLibraries({strings:['AppLovin internal marker only']}).find((x)=>x.name==='AppLovin MAX');
if (fallbackVendor) assert.ok(fallbackVendor.confidence<0.8,'one vendor string cannot reach suppression confidence');
const ranked=rankApplicationFunctions([base,appFn],(_fn,index)=>index?{notKnownVendor:true,calledFromApplication:true}:{}); assert.equal(ranked[0].classification.classification,'APPLICATION');
const clusters=clusterFunctions([appFn,{...appFn,address:0x3333n,strings:['reward','coins','wallet']}]); assert.ok(clusters.some((x)=>x.subsystem==='economy/reward'));
const suppression=classificationMetrics([{classification:'APPLICATION'},{classification:'SDK'},{classification:'RUNTIME'},{classification:'LIBRARY'}]); assert.equal(suppression.librarySuppressionRate,0.75);

// knowledge reidentification, propagation, and negative knowledge.
const defaultDb=new KnowledgeDB({indexedDB:null,memory:new Map(),negativeMemory:new Map()});
const defaultRecord=await defaultDb.remember({fingerprint:base,name:'heuristic-name'});
assert.equal(defaultRecord.confirmation,'weak-inferred'); assert.equal(defaultRecord.confidence,0.5);
const explicitConfirmed=await defaultDb.remember({fingerprint:{...base,address:0x1111n},name:'confirmed-name',confirmation:'user-confirmed'});
assert.equal(explicitConfirmed.confidence,1); assert.equal(explicitConfirmed.confirmation,'user-confirmed');
await defaultDb.reject({sourceBinaryHash:'v2',candidateName:'address-scoped',address:0x1234n});
assert.equal(await defaultDb.isRejected({sourceBinaryHash:'v2',candidateName:'address-scoped',address:0x1234n}),true);
assert.equal(await defaultDb.isRejected({sourceBinaryHash:'v2',candidateName:'address-scoped',address:0x5678n}),false,'address-only rejection is not global negative knowledge');

const db=new KnowledgeDB({indexedDB:null,memory:new Map(),negativeMemory:new Map()});
await db.remember({fingerprint:base,name:'PlayerData::addCoins',roles:['economy writer'],types:['void(int)'],semanticLabels:['adds currency'],sourceBinaryHash:'v1',versions:['1.0'],confidence:0.99,confirmation:'user-confirmed',evidence:[{kind:'manual-confirmation'}]});
let reid=await db.reidentify({...base,address:0x8800n});
assert.equal(reid.matched,true); assert.equal(reid.knowledge.names[0],'PlayerData::addCoins');
const propagated=await db.propagate({...base,address:0x9900n});
assert.equal(propagated.propagated,true); assert.ok(propagated.candidate.roles.includes('economy writer'));
const queried=await db.query('addCoins',[{...base,address:0x9900n},{...unrelated1,address:0x9910n}]); assert.equal(queried[0].function.address,0x9900n); assert.ok(queried[0].reasons.includes('prior-knowledge'));
const page=await db.page({limit:1}); assert.equal(page.records.length,1);
await db.reject({candidateName:'PlayerData::addCoins',fingerprint:{...base,address:0x7777n},reason:'manual rejection'});
reid=await db.reidentify({...base,address:0x7777n});
assert.equal(reid.matched,false);

// packs: provenance/license retained; stale/future schema fails closed without throwing.
const pack=createKnowledgePack({architecture:'arm64',library:'TestLib',provenance:{source:'unit-test'},license:'MIT',signatures:[{name:'foo'}]});
assert.equal(importKnowledgePack(JSON.stringify(pack)).ok,true);
assert.equal(pack.signatures[0].architecture,'arm64'); assert.equal(pack.signatures[0].license,'MIT'); assert.equal(pack.signatures[0].library,'TestLib');
const legacyFp=fingerprintFunction({address:6n,size:8,byteHash:'legacy-exact',normalizedByteHash:'legacy-normalized',irHash:'legacy-ir',byteSample:[1,2,3]});
assert.equal(legacyFp.normalizedBytesHash,'legacy-normalized'); assert.equal(legacyFp.semanticHash,'legacy-ir');
assert.equal(importKnowledgePack({...pack,version:999}).ok,false);
assert.equal(importKnowledgePack('{broken').ok,false);

// plugin provider failures are isolated.
const plugins=new PlatformPluginRegistry();
plugins.registerKnowledgeProvider('test.knowledge',{lookup:async()=>['ok']});
plugins.registerSignatureProvider('test.signature',{signatures:async()=>{throw new Error('boom')}});
plugins.registerRecognitionProvider('test.recognition',{recognize:async()=>({ok:true})});
let providers=await plugins.runProviders('signatureProvider','signatures',{binary:{hash:'abc'}});
assert.equal(providers[0].isolated,true);
providers=await plugins.runProviders('recognitionProvider','recognize',{binary:{hash:'abc'}});
assert.equal(providers[0].ok,true);

// Synthetic ground-truth versions and metrics.
const corpus=[]; const corpusAfter=[]; const expected=[];
for(let i=0;i<200;i++){
  const f={address:BigInt(0x10000+i*0x20),architecture:'arm64',bytes:Uint8Array.from([i&255,(i>>8)&255,1,2,3,4,5,6]),instructions:[`add x${i%20}, x1, x2`,`str x${i%20}, [x0,#${(i%8)*8}]`],cfg:{blocks:2+(i%3),edges:1+(i%3),exits:1},strings:[`app.key.${i}`],semantic:{reads:[`f${i%8}`],writes:[`f${i%8}`],operations:['add'],thresholds:[i]}};
  corpus.push(f); const g={...f,address:BigInt(0x90000+i*0x30),bytes:Uint8Array.from([i&255,(i>>8)&255,1,2,3,4,5,6])}; corpusAfter.push(g); expected.push([String(f.address),String(g.address)]);
}
corpusAfter.push({address:999999n,architecture:'arm64',bytes:Uint8Array.from([250,249,248,247,246,245,244,243]),instructions:['eor x1,x2,x3','ret'],strings:['unrelated']});
const corpusMatch=matchFunctions(corpus,corpusAfter,{maxCandidates:64});
const metrics=recognitionMetrics(expected,corpusMatch);
assert.ok(metrics.precision>=0.99); assert.ok(metrics.recall>=0.99); assert.equal(metrics.falseMatchRate,0);
const calibration=calibrationReport(expected,corpusMatch); assert.equal(calibration.calibrated,false); assert.equal(calibration.scoreKind,'similarity-confidence-v1');

// 100k scale: indexed candidate generation, no O(N^2) pair scan.
const scale=[];
for(let i=0;i<100000;i++) scale.push(fingerprintFunction({address:BigInt(i*16),architecture:'arm64',size:32+(i%32),instructions:[`add x${i%16}, x1, x2`,`str x${i%16}, [x0,#${(i%16)*8}]`],strings:[`sig.${i}`],semantic:{reads:[`r${i%64}`],writes:[`w${i%64}`],operations:['add'],thresholds:[i]}}));
const t0=performance.now(); const scaleIndex=new FunctionMatchIndex(scale, { matchBudget: { maxWallMs: 60_000 } }); const buildMs=performance.now()-t0;
const probe=scale[54321]; const cands=scaleIndex.candidates(probe,{maxCandidates:128});
assert.ok(cands.length>0 && cands.length<=128); assert.ok(cands.includes(54321));
console.log(JSON.stringify({precision:metrics.precision,recall:metrics.recall,falseMatchRate:metrics.falseMatchRate,ambiguousRate:metrics.ambiguousRate,scaleFunctions:scale.length,indexBuckets:scaleIndex.buckets.size,indexBuildMs:Number(buildMs.toFixed(1)),probeCandidates:cands.length}));
console.log('recognition-intelligence: PASS');