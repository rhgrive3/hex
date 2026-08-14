import assert from 'node:assert/strict';
import { maximumWeightCandidateMatching, matchFunctions } from '../js/recognition/matcher.js';
import { diffFunctions } from '../js/diff/index.js';
import { createHexProject, validateHexProject } from '../js/project/index.js';
import { AnalysisCache } from '../js/cache/analysis-cache.js';
import { recognizeLibraries, createKnowledgePack, validateKnowledgePack } from '../js/signature/index.js';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { ArchitectureAdapter, registerArchitectureAdapter, architectureAdapter } from '../js/architecture/index.js';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';
import {
  parseSwiftNominalDescriptor, parseSwiftFieldDescriptor, parseSwiftConformanceDescriptor,
  parseSwiftWitnessTable, buildSwiftRuntimeIndex, demangleSwiftSymbol,
} from '../js/swift.js';
import { demangleCxx, demangleCxxDetailed } from '../js/rtti.js';

const optimum = maximumWeightCandidateMatching([
  { i:0, j:0, confidence:0.90 }, { i:0, j:1, confidence:0.80 },
  { i:1, j:0, confidence:0.89 }, { i:1, j:1, confidence:0.10 },
]);
assert.deepEqual(optimum.map((x)=>[x.i,x.j]), [[0,1],[1,0]]);

const twin = (address) => ({ address, bytes:Uint8Array.from([1,2,3,4,5,6,7,8]), cfg:{blocks:1,edges:0,exits:1}, strings:['same'], imports:['memcpy'] });
const ambiguous = matchFunctions([twin(1n), twin(2n)], [twin(101n), twin(102n)], { ambiguityWindow:0.1 });
assert.equal(ambiguous.matches.length, 2);
assert.equal(ambiguous.matches.every((x)=>x.ambiguous && x.candidates.length >= 1), true);

const changed = diffFunctions([
  { address:1n, size:8, bytes:Uint8Array.from([1,1,1,1,1,1,1,1]), strings:['anchor'], cfg:{blocks:1,edges:0,exits:1} },
], [
  { address:2n, size:8, bytes:Uint8Array.from([2,2,2,2,2,2,2,2]), strings:['anchor'], cfg:{blocks:4,edges:4,exits:2} },
], { threshold:0.2, allowSimilar:true });
if (changed.matches[0]?.identity === 'similar') assert.equal(changed.matches[0].status, 'rewritten');

const partialProject = { format:'hexproj', version:1, binary:{ embedded:false } };
const normalized = validateHexProject(partialProject);
assert.deepEqual(normalized.user.names, []);
assert.deepEqual(normalized.findings.evidence, []);
assert.deepEqual(normalized.analysis.cacheReferences, []);
assert.deepEqual(normalized.navigation.history, []);
assert.deepEqual(createHexProject({}).user.patches, []);

const sharedMemory = new Map();
const cacheV1 = new AnalysisCache({ indexedDB:null, memory:sharedMemory, analyzerVersion:'v1', semanticOptions:{ mode:'safe' } });
await cacheV1.put('bin', { functionSeeds:[1] });
assert.deepEqual((await cacheV1.get('bin')).functionSeeds, [1]);
const cacheV2 = new AnalysisCache({ indexedDB:null, memory:sharedMemory, analyzerVersion:'v2', semanticOptions:{ mode:'safe' } });
assert.equal(await cacheV2.get('bin'), null);
const cacheDifferentOptions = new AnalysisCache({ indexedDB:null, memory:sharedMemory, analyzerVersion:'v1', semanticOptions:{ mode:'aggressive' } });
assert.equal(await cacheDifferentOptions.get('bin'), null);

const failedIdb = { open() { throw new Error('blocked'); } };
const degraded = new AnalysisCache({ indexedDB:failedIdb, analyzerVersion:'v1' });
assert.equal(await degraded.get('x'), null);
await degraded.put('x', { imports:['puts'] });
assert.deepEqual((await degraded.get('x')).imports, ['puts']);
assert.match(degraded.storageFailure.message, /blocked/);

const globalSig = [{ name:'GlobalRegex', classification:'LIBRARY', kind:'library', libraries:[], symbols:[/foo/g] }];
assert.equal(recognizeLibraries({ symbols:['foo'] }, globalSig).length, 1);
assert.equal(recognizeLibraries({ symbols:['foo'] }, globalSig).length, 1);
assert.equal(validateKnowledgePack(createKnowledgePack({ mappings:[{ name:'x' }] })).ok, false);
assert.equal(validateKnowledgePack(createKnowledgePack({ mappings:[{ identity:'id', name:' ' }] })).ok, false);

const plugins = new PlatformPluginRegistry();
const hostArg = { nested:{ values:[1] } };
plugins.registerAnalyzer('hardening.arg', { analyze:(_ctx,arg) => { try { arg.nested.values.push(2); } catch {} return arg.nested.values.length; } });
assert.equal((await plugins.invoke('analyzer','hardening.arg','analyze',{},hostArg)).ok, true);
assert.deepEqual(hostArg.nested.values, [1]);
plugins.registerAnalyzer('hardening.timeout', { analyze:() => new Promise(()=>{}) });
const timeout = await plugins.invoke('analyzer','hardening.timeout','analyze',{ pluginTimeoutMs:5 });
assert.equal(timeout.ok, false); assert.equal(timeout.code, 'PLUGIN_TIMEOUT');
plugins.registerAnalyzer('hardening.read-denied', { analyze:(ctx) => typeof ctx.read });
assert.equal((await plugins.invoke('analyzer','hardening.read-denied','analyze',{ read:async()=>new Uint8Array([1]) })).value, 'undefined');
plugins.registerAnalyzer('hardening.read-range', { analyze:async(ctx) => ctx.read(0x2000n, 4) });
const readRange = await plugins.invoke('analyzer','hardening.read-range','analyze',{
  read:async()=>new Uint8Array(4),
  pluginPermissions:{ read:{ allowed:true, ranges:[{start:0x1000n,end:0x1100n}], maxReadBytes:16, maxTotalBytes:32 } },
});
assert.equal(readRange.ok, false); assert.equal(readRange.code, 'PLUGIN_READ_RANGE');

registerArchitectureAdapter({ id:'TEST.Case.Adapter', instructionAlignment:4, fixedInstructionSize:4 });
assert.equal(architectureAdapter('test.case.adapter').id, 'test.case.adapter');
assert.throws(() => new ArchitectureAdapter({ id:'bad.zero', instructionAlignment:0 }), /positive integer/);
assert.throws(() => new ArchitectureAdapter({ id:'bad.nan', instructionAlignment:NaN }), /positive integer/);
const arm64 = architectureAdapter('ARM64');
for (const mnemonic of ['retaa','retab']) assert.equal(arm64.controlFlow({mnemonic}), 'return');
for (const mnemonic of ['blraa','blrab','blraaz','blrabz']) assert.equal(arm64.controlFlow({mnemonic}), 'call');
for (const mnemonic of ['braa','brab','braaz','brabz']) assert.equal(arm64.controlFlow({mnemonic}), 'branch');

const objcMem = new Uint8Array(0x8000); const objcDv = new DataView(objcMem.buffer);
const p64=(a,v)=>objcDv.setBigUint64(a,BigInt(v),true); const p32=(a,v)=>objcDv.setUint32(a,Number(v)>>>0,true);
const putUtf8=(a,s)=>{ const b=new TextEncoder().encode(s); objcMem.set(b,a); objcMem[a+b.length]=0; };
const longSelector='選択'+ 'a'.repeat(700);
p64(0x100,0x1000); p64(0x1008,0); p64(0x1000+8,0x1800); p64(0x1000+16,0); p64(0x1000+24,0x1100); p64(0x1000+32,0); p64(0x1000+40,0); p64(0x1000+48,0); p64(0x1000+56,0);
putUtf8(0x1800,'提供者'); p32(0x1100,24); p32(0x1104,1); p64(0x1108,0x1820); p64(0x1110,0x1c00); p64(0x1118,0); putUtf8(0x1820,longSelector); putUtf8(0x1c00,'v16@0:8');
const objcRead=async(addr,len)=>{ const a=Number(addr); return a>=0&&a<objcMem.length?objcMem.subarray(a,Math.min(objcMem.length,a+len)):null; };
const objcParsed=await parseObjcExtendedMetadata(objcRead,{ protocolList:{vmAddr:0x100n,size:8n} });
assert.equal(objcParsed.protocols[0].name,'提供者'); assert.equal(objcParsed.protocols[0].methods[0].sel,longSelector);
const encoded=0xff00000000001800n; p64(0x1000+8,encoded);
const resolved=await parseObjcExtendedMetadata(objcRead,{ protocolList:{vmAddr:0x100n,size:8n} },{ resolvePointer:async(raw)=>raw===encoded?0x1800n:raw });
assert.equal(resolved.protocols[0].name,'提供者');

const structBytes=new Uint8Array(28); const structDv=new DataView(structBytes.buffer);
structDv.setUint32(0,17,true); structDv.setInt32(8,0x100,true); structDv.setInt32(16,0,true); structDv.setUint32(20,0,true); structDv.setUint32(24,0,true);
const swiftName=new TextEncoder().encode('Tiny\0');
const shortRead=async(addr,len)=>{ const a=Number(addr); if(a===0x1000 && len<=28)return structBytes.subarray(0,len); if(a===0x1108)return swiftName.subarray(0,Math.min(len,swiftName.length)); return null; };
const tiny=await parseSwiftNominalDescriptor(shortRead,0x1000n); assert.equal(tiny?.name,'Tiny');
assert.equal(demangleSwiftSymbol('$s4Game3keyK').throws,false);
assert.equal(demangleSwiftSymbol('$s4Game6loaderyyKF').throws,true);

const swiftMem=new Uint8Array(0x3000); const swiftDv=new DataView(swiftMem.buffer);
const si32=(a,v)=>swiftDv.setInt32(a,Number(v),true); const su32=(a,v)=>swiftDv.setUint32(a,Number(v)>>>0,true); const su64=(a,v)=>swiftDv.setBigUint64(a,BigInt(v),true);
si32(0x1000,0x1200-0x1000); si32(0x1004,0x1100-0x1004); si32(0x1008,0x1300-0x1008); su32(0x100c,1<<3); su64(0x1100,0xff00000000001400n); su64(0x1500,0xff00000000001600n);
const swiftRead=async(addr,len)=>{ const a=Number(addr); return a>=0&&a<swiftMem.length?swiftMem.subarray(a,Math.min(swiftMem.length,a+len)):null; };
swiftRead.resolvePointer=async(raw)=> raw===0xff00000000001400n?0x1400n:raw===0xff00000000001600n?0x1600n:null;
const indirectConf=await parseSwiftConformanceDescriptor(swiftRead,0x1000n); assert.equal(indirectConf.typeReferenceKind,1); assert.equal(indirectConf.typeRef,0x1400n);
const witness=await parseSwiftWitnessTable(swiftRead,0x1500n,1); assert.equal(witness[0].target,0x1600n);

const duplicateIndex=buildSwiftRuntimeIndex({ types:[{name:'State',module:'A',address:1n},{name:'State',module:'B',address:2n}], protocols:[] });
assert.equal(duplicateIndex.typesBySimpleName.get('State').length,2); assert.equal(duplicateIndex.typesByName.has('State'),false);
assert.equal(duplicateIndex.typesByName.get('A.State').address,1n);

const badNameMem=new Uint8Array(0x200); const badDv=new DataView(badNameMem.buffer); badDv.setUint32(0,17,true); badDv.setInt32(8,0x80,true); badNameMem[0x88]=0xc3; badNameMem[0x89]=0x28; badNameMem[0x8a]=0;
const badRead=async(addr,len)=>{const a=Number(addr);return badNameMem.subarray(a,Math.min(badNameMem.length,a+len));};
assert.equal(await parseSwiftNominalDescriptor(badRead,0n),null);
await assert.rejects(() => parseSwiftFieldDescriptor(async()=>null,1n,0), TypeError);
await assert.rejects(() => parseSwiftWitnessTable(async()=>null,1n,NaN), TypeError);

assert.equal(demangleCxx('__Z3fooU3bari'), null);
assert.equal(demangleCxx('__ZN3Foo3barEv'), 'Foo::bar()');
assert.equal(demangleCxx('__ZN3Foo3bar'), null);
const partial=demangleCxxDetailed('__ZN3Foo3bar'); assert.equal(partial.complete,false); assert.ok(partial.error);

console.log('issues-193-220: PASS');
