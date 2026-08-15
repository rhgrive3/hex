import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchFunctions } from '../js/recognition/matcher.js';
import { diffFunctions } from '../js/diff/index.js';
import { HEX_PROJECT_VERSION, validateHexProject } from '../js/project/index.js';
import { AnalysisCache } from '../js/cache/analysis-cache.js';
import { recognizeLibraries, createKnowledgePack, validateKnowledgePack } from '../js/signature/index.js';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { ArchitectureAdapter, registerArchitectureAdapter, architectureAdapter } from '../js/architecture/index.js';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';
import {
  demangleSwiftSymbol, parseSwiftNominalDescriptor, parseSwiftFieldDescriptor,
  parseSwiftConformanceDescriptor, parseSwiftWitnessTable, buildSwiftRuntimeIndex,
} from '../js/swift.js';
import { demangleCxx } from '../js/rtti.js';
import { parseMetadata, parseMetadataAuto } from '../js/il2cpp.js';
import { matchRoute, ProductRouter } from '../js/ui/router.js';
import { PatchSet } from '../js/patch.js';

const bytes = (...xs) => Uint8Array.from(xs);

// #194: ambiguity is measured from the candidate set before greedy assignment.
{
  const common = { bytes: bytes(1,2,3,4,5,6,7,8), cfg:{blocks:2,edges:1,exits:1}, strings:['same'], imports:['memcpy'] };
  const before = [{...common,address:0x1000n},{...common,address:0x2000n}];
  const after = [{...common,address:0x3000n},{...common,address:0x4000n}];
  const result = matchFunctions(before, after);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches.every((m) => m.ambiguous && m.candidates.length >= 1), true);
}

// #195: similar-but-not-probable matches are explicitly reported as rewritten.
{
  const a = { address:1n, bytes:bytes(1,2,3,4,5,6,7,8), instructions:['mov x0, x1','ret'], strings:['coins'], imports:['memcpy'], calls:['helper'], constants:[7] };
  const b = { ...a, address:2n, bytes:bytes(8,7,6,5,4,3,2,1) };
  const result = diffFunctions([a],[b],{threshold:0.55,allowSimilar:true});
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].changeType, 'rewritten');
  assert.equal(result.matches[0].status, 'rewritten');
}

// #196: validation materializes the canonical schema instead of only checking fallbacks.
{
  const p = { format:'hexproj', version:HEX_PROJECT_VERSION, binary:{embedded:false} };
  const normalized = validateHexProject(p);
  for (const value of [normalized.user.names, normalized.user.comments, normalized.user.types, normalized.user.structs,
    normalized.user.bookmarks, normalized.user.patches, normalized.findings.confirmed, normalized.findings.agentAnswers,
    normalized.findings.evidence, normalized.findings.investigationSessions, normalized.analysis.cacheReferences,
    normalized.navigation.history, normalized.navigation.bookmarks]) assert.deepEqual(value, []);
}

// #197/#198: cache identity includes analyzer/settings and IDB failures fall back to memory.
{
  const a = new AnalysisCache({ memory:new Map(), analyzerVersion:'1', analysisSettings:{mode:'a'} });
  const b = new AnalysisCache({ memory:new Map(), analyzerVersion:'2', analysisSettings:{mode:'a'} });
  assert.notEqual(a.key('hash'), b.key('hash'));
  const failingIDB = { open(){ throw new Error('IDB denied'); } };
  const cache = new AnalysisCache({ indexedDB:failingIDB, analyzerVersion:'1' });
  await cache.put('abc',{analysisSummaries:{ok:true}});
  assert.deepEqual(await cache.get('abc'), {analysisSummaries:{ok:true}});
  assert.equal(cache._idbFailed, true);
}

// #199/#200: global regexes stay deterministic; mappings need a stable identity/name.
{
  const signatures = [{name:'G',classification:'LIBRARY',kind:'library',libraries:[/Foo/g],symbols:[]}];
  assert.equal(recognizeLibraries({libraries:['Foo']},signatures).length,1);
  assert.equal(recognizeLibraries({libraries:['Foo']},signatures).length,1);
  const pack = createKnowledgePack({mappings:[{roles:['gameplay']}]});
  assert.equal(validateKnowledgePack(pack).ok,false);
}

// #201-#203: plugin args are detached/frozen, execution is bounded, binary reads are capability gated.
{
  const registry = new PlatformPluginRegistry({timeoutMs:20});
  const hostArg = {nested:{items:['safe']}};
  registry.registerAnalyzer('issue.args',{analyze:async (_ctx,arg)=>{try{arg.nested.items.push('evil');}catch{} return arg;}});
  const argResult = await registry.invoke('analyzer','issue.args','analyze',{},hostArg);
  assert.equal(argResult.ok,true);
  assert.deepEqual(hostArg,{nested:{items:['safe']}});

  registry.registerAnalyzer('issue.timeout',{analyze:async()=>new Promise(()=>{})});
  const timeout = await registry.invoke('analyzer','issue.timeout','analyze',{});
  assert.equal(timeout.ok,false); assert.equal(timeout.timeout,true);

  registry.registerAnalyzer('issue.read',{analyze:async(ctx)=>Array.from(await ctx.read(0n,4))});
  const read = async()=>bytes(1,2,3,4);
  const denied = await registry.invoke('analyzer','issue.read','analyze',{read});
  assert.equal(denied.ok,false);
  const allowed = await registry.invoke('analyzer','issue.read','analyze',{read,pluginPolicy:{binaryRead:true,maxReadBytes:4,maxTotalReadBytes:4}});
  assert.equal(allowed.ok,true); assert.deepEqual(allowed.value,[1,2,3,4]);
}

// #204-#208: architecture IDs/sizes are canonical and arm64e authenticated control-flow is recognized.
{
  const adapter = registerArchitectureAdapter({id:'Issue204.Mixed',instructionAlignment:4,fixedInstructionSize:4});
  assert.equal(adapter.id,'issue204.mixed');
  assert.equal(architectureAdapter('ISSUE204.MIXED'),adapter);
  assert.throws(()=>new ArchitectureAdapter({id:'bad.nan',instructionAlignment:NaN}),/positive integer/);
  assert.throws(()=>new ArchitectureAdapter({id:'bad.zero',instructionAlignment:0}),/positive integer/);
  const arm = architectureAdapter('arm64');
  assert.equal(arm.controlFlow({mnemonic:'RETAA'}),'return');
  assert.equal(arm.controlFlow({mnemonic:'RETAB'}),'return');
  assert.equal(arm.controlFlow({mnemonic:'BLRAA'}),'call');
  assert.equal(arm.controlFlow({mnemonic:'BLRAB'}),'call');
  assert.equal(arm.controlFlow({mnemonic:'BRAA'}),'branch');
  assert.equal(arm.controlFlow({mnemonic:'BRAB'}),'branch');
}

function put64(dv,at,value){dv.setBigUint64(at,BigInt(value),true);}
function put32(dv,at,value){dv.setUint32(at,Number(value)>>>0,true);}
function putI32(dv,at,value){dv.setInt32(at,Number(value),true);}

// #209-#211: ObjC names are UTF-8/untruncated and tagged pointers use the supplied fixup decoder first.
{
  const mem = new Uint8Array(65536), dv = new DataView(mem.buffer);
  const TAG = 0xf000000000000000n, protocolList=0x100n, protocol=0x200n, nameAt=0x400n;
  put64(dv,Number(protocolList),TAG|protocol);
  put64(dv,Number(protocol)+8,TAG|nameAt);
  const longName='解析'.repeat(100); // 600 UTF-8 bytes, beyond the old fixed 256-byte read.
  const encoded=new TextEncoder().encode(longName+'\0'); mem.set(encoded,Number(nameAt));
  const read=async(addr,len)=>{const a=Number(addr);if(a<0||a>=mem.length)return null;return mem.subarray(a,Math.min(mem.length,a+len));};
  const model=await parseObjcExtendedMetadata(read,{protocolList:{vmAddr:protocolList,size:8n}},{imageBase:0n,resolvePointer:(raw)=>BigInt(raw)&0xffffn});
  assert.equal(model.protocols.length,1); assert.equal(model.protocols[0].name,longName);
}

function memoryReader(mem){return async(addr,len)=>{const a=Number(addr);if(a<0||a>=mem.length)return null;return mem.subarray(a,Math.min(mem.length,a+len));};}

// #212-#218: Swift descriptor sizing, mangling, pointer decoding, UTF-8, budgets and conformance kinds.
{
  const mem=new Uint8Array(2048),dv=new DataView(mem.buffer),addr=0x100,nameAt=0x180;
  put32(dv,addr,17); // struct
  putI32(dv,addr+8,nameAt-(addr+8));
  put32(dv,addr+20,1); put32(dv,addr+24,2);
  mem.set(new TextEncoder().encode('短い構造体\0'),nameAt);
  const read=memoryReader(mem);
  const nominal=await parseSwiftNominalDescriptor(read,BigInt(addr));
  assert.equal(nominal?.kind,'struct'); assert.equal(nominal?.name,'短い構造体');
  assert.equal(demangleSwiftSymbol('$s3Foo3BarKMa').throws,false);

  const witnessAt=0x300; put64(dv,witnessAt,0xf000000000000456n);
  const unresolved=await parseSwiftWitnessTable(read,BigInt(witnessAt),1);
  assert.equal(unresolved[0].target,null); assert.equal(unresolved[0].rawTarget,0xf000000000000456n);
  const resolved=await parseSwiftWitnessTable(read,BigInt(witnessAt),1,4096,{resolvePointer:(raw)=>BigInt(raw)&0xfffn});
  assert.equal(resolved[0].target,0x456n);

  const index=buildSwiftRuntimeIndex({types:[
    {address:1n,name:'Thing',qualifiedName:'A.Thing'},
    {address:2n,name:'Thing',qualifiedName:'B.Thing'},
  ]});
  assert.equal(index.typesByName.has('Thing'),false);
  assert.equal(index.typesByName.get('A.Thing')?.address,1n);
  assert.equal(index.typesByName.get('B.Thing')?.address,2n);

  const invalid=new Uint8Array(1024),idv=new DataView(invalid.buffer),invalidAddr=0x40,invalidName=0x80;
  put32(idv,invalidAddr,17); putI32(idv,invalidAddr+8,invalidName-(invalidAddr+8)); invalid.set([0xc3,0x28,0],invalidName);
  assert.equal(await parseSwiftNominalDescriptor(memoryReader(invalid),BigInt(invalidAddr)),null);

  const fieldsAt=0x500; put32(dv,fieldsAt+8,12); // recordSize occupies u16 @ +10; write explicitly below.
  dv.setUint16(fieldsAt+10,12,true); put32(dv,fieldsAt+12,1);
  put32(dv,fieldsAt+16,0); putI32(dv,fieldsAt+20,0); putI32(dv,fieldsAt+24,0);
  const fields=await parseSwiftFieldDescriptor(read,BigInt(fieldsAt),NaN);
  assert.equal(fields.length,1);

  const confAt=0x600,objcName=0x680;
  putI32(dv,confAt,0x40); putI32(dv,confAt+4,objcName-(confAt+4)); putI32(dv,confAt+8,0x40); put32(dv,confAt+12,2<<3);
  mem.set(new TextEncoder().encode('ObjCClass\0'),objcName);
  const conf=await parseSwiftConformanceDescriptor(read,BigInt(confAt));
  assert.equal(conf.typeReferenceKind,2); assert.equal(conf.typeRef,null); assert.equal(conf.objcClassName,'ObjCClass');
}

// #219/#220: unsupported argument encodings and unterminated nested names never produce partial demangles.
{
  assert.equal(demangleCxx('__ZN3Foo3barEiX'),null);
  assert.equal(demangleCxx('__ZN3Foo3bar'),null);
  assert.equal(demangleCxx('__ZN3Foo3barEi'),'Foo::bar(int)');
}

function metadataFixture({version=24,methodSize=56,owner=0,literalOverflow=false,stringIndexOverflow=false}={}){
  const HEADER=184, stringOff=HEADER, strings=bytes(...new TextEncoder().encode('Type\0Ns\0method\0Assembly-CSharp.dll\0'));
  const typeOff=stringOff+strings.length, typeSize=100, methodOff=typeOff+typeSize, imageOff=methodOff+methodSize;
  const litIndexOff=imageOff+40,litDataOff=litIndexOff+8,total=litDataOff+16;
  const u8=new Uint8Array(total),dv=new DataView(u8.buffer); put32(dv,0,0xFAB11BAF); putI32(dv,4,version);
  const pairs={stringLiteral:[litIndexOff,8],stringLiteralData:[litDataOff,4],string:[stringOff,strings.length],methods:[methodOff,methodSize],typeDefinitions:[typeOff,typeSize],images:[imageOff,40]};
  const order=['stringLiteral','stringLiteralData','string','events','properties','methods','parameterDefaultValues','fieldDefaultValues','fieldAndParameterDefaultValueData','fieldMarshaledSizes','parameters','fields','genericParameters','genericParameterConstraints','genericContainers','nestedTypes','interfaces','vtableMethods','interfaceOffsets','typeDefinitions','images','assemblies'];
  for(let i=0;i<order.length;i++){const [off,size]=pairs[order[i]]||[0,0];putI32(dv,8+i*8,off);putI32(dv,12+i*8,size);}
  u8.set(strings,stringOff);
  putI32(dv,typeOff,stringIndexOverflow?strings.length+2:0); putI32(dv,typeOff+4,5);
  putI32(dv,methodOff,8); putI32(dv,methodOff+4,owner); const tokenAt=version>=27?24:40; if(tokenAt+4<=methodSize)put32(dv,methodOff+tokenAt,0x06000001);
  putI32(dv,imageOff,15); putI32(dv,imageOff+8,0); put32(dv,imageOff+12,1);
  putI32(dv,litIndexOff,literalOverflow?8:4); putI32(dv,litIndexOff+4,0); u8.set(bytes(65,66,67,68),litDataOff);
  return u8;
}

// #221-#230: IL2CPP parsing is bounded by header/table ranges and chooses coherent v24 layouts.
{
  assert.throws(()=>parseMetadata(new Uint8Array(100)),/header|小さすぎ/);
  const oob=metadataFixture(),odv=new DataView(oob.buffer); putI32(odv,8+2*8+4,oob.length); assert.throws(()=>parseMetadata(oob),/outside the file|overlap/);
  const badString=parseMetadata(metadataFixture({stringIndexOverflow:true})); assert.equal(badString.classes.length,0);
  const badOwner=parseMetadata(metadataFixture({owner:999})); assert.equal(badOwner.methods.length,0);
  const v242=parseMetadata(metadataFixture({methodSize:52})); assert.equal(v242.methodSize,52);
  const auto=parseMetadataAuto(metadataFixture({methodSize:52})); assert.equal(auto.methodSize,52);
  const badRecord=metadataFixture(); new DataView(badRecord.buffer).setInt32(8+19*8+4,99,true); assert.throws(()=>parseMetadata(badRecord),/layout|overlap|outside|判定/);
  const badLiteral=parseMetadata(metadataFixture({literalOverflow:true})); assert.equal(badLiteral.literals.length,0);
}

// #231: malformed percent escapes are not allowed to throw out of route matching.
{
  const routes=[{id:'p',pattern:'/p/:id'}];
  assert.equal(matchRoute(routes,'/p/%E0%A4%A'),null);
}

function installBrowser({hash='#/a',state=null,length=1}={}){
  const listeners=new Map(),raf=[];
  let currentHash=hash,currentHref='https://hex.test/'+hash;
  const location={};
  Object.defineProperty(location,'hash',{get:()=>currentHash,set:(value)=>{currentHash=String(value).startsWith('#')?String(value):'#'+value;currentHref='https://hex.test/'+currentHash;}});
  Object.defineProperty(location,'href',{get:()=>currentHref});
  const apply=(url)=>{if(typeof url==='string'){const i=url.indexOf('#');if(i>=0)location.hash=url.slice(i);}};
  const history={state,length,replaceState(next,_title,url){this.state=next;apply(url);},pushState(next,_title,url){this.state=next;this.length++;apply(url);},back(){},forward(){}};
  globalThis.window={location,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}};
  globalThis.history=history;
  globalThis.requestAnimationFrame=(fn)=>{raf.push(fn);return raf.length;};
  return{listeners,raf,history,location};
}

// #232-#238: router has generation/error boundaries, hash navigation, canonical fallback and app-local back state.
{
  const routes=[{id:'a',pattern:'/a'},{id:'b',pattern:'/b'}];
  let restored=0,disposed=0; const errors=[];
  const env=installBrowser({state:{hexUi:true,key:7,depth:0,viewState:{restore:true}},length:99});
  const router=new ProductRouter(routes,{defaultPath:'/a',onError:(e,m)=>errors.push(m.phase),onRoute:(current)=>current.route.id==='a'?{getState:()=>({a:1}),restoreState:()=>{restored++;},dispose:()=>{disposed++;}}:{getState:()=>({b:1})}});
  router.start(); assert.equal(router.canBack(),false); // browser history length is intentionally irrelevant.
  router.navigate('/b'); assert.equal(router.canBack(),true);
  env.raf.splice(0).forEach((fn)=>fn()); assert.equal(restored,0); // stale restore from /a cannot hit disposed view.
  assert.equal(disposed,1);

  env.location.hash='/a'; env.listeners.get('hashchange')?.(); assert.equal(router.current.route.id,'a');
  router.view.getState=()=>{throw new Error('capture');}; router.navigate('/b'); assert.equal(errors.includes('capture'),true);
  router.stop();

  const env2=installBrowser({hash:'#/missing'}); const fallback=new ProductRouter(routes,{defaultPath:'/a',onRoute:()=>null}); fallback.start(); assert.equal(env2.location.hash,'#/a'); fallback.stop();

  const env3=installBrowser({state:{hexUi:true,key:1,depth:0,viewState:{x:1}}}); const restoreErrors=[];
  const restoreRouter=new ProductRouter(routes,{defaultPath:'/a',onError:(_e,m)=>restoreErrors.push(m.phase),onRoute:()=>({restoreState:()=>{throw new Error('restore');}})});
  restoreRouter.start(); env3.raf.splice(0).forEach((fn)=>fn()); assert.equal(restoreErrors.includes('restore'),true); restoreRouter.stop();

  const env4=installBrowser(); let oldDisposed=0;
  const renderRouter=new ProductRouter(routes,{defaultPath:'/a',onError:()=>{},onRoute:(current)=>{if(current.route.id==='b')throw new Error('render');return{dispose:()=>{oldDisposed++;}};}});
  renderRouter.start(); renderRouter.navigate('/b'); assert.equal(oldDisposed,0); assert.equal(renderRouter.current.route.id,'a'); renderRouter.stop();
}

// #239/#240/#242/#243: patch sets reject overlap/length mismatches, validate stale bytes, stream source slices and normalize addresses.
{
  const p=new PatchSet(); p.add(2n,bytes(2,3),bytes(9,9),{addr:0x1000n});
  assert.throws(()=>p.add(3n,bytes(3,4),bytes(8,8)),/overlap/);
  assert.throws(()=>p.add(8n,bytes(1),bytes(1,2)),/same non-zero length/);
  assert.equal(p.byAddress(4096)?.addr,0x1000n);
  class NoWholeReadBlob extends Blob { async arrayBuffer(){throw new Error('whole-file read forbidden');} }
  const source=new NoWholeReadBlob([bytes(0,1,2,3,4,5)]);
  const result=await p.apply(source); assert.deepEqual(Array.from(new Uint8Array(await result.arrayBuffer())),[0,1,9,9,4,5]);
  const stale=new PatchSet(); stale.add(0n,bytes(7),bytes(8)); await assert.rejects(()=>stale.apply(new Blob([bytes(1)])),/元のバイト/);
}

// #244: large real binaries are represented by immutable, hash-pinned metadata and an on-demand fetcher.
{
  const manifest=JSON.parse(fs.readFileSync(new URL('./large-fixtures.json',import.meta.url),'utf8'));
  assert.match(manifest.sourceCommit,/^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(manifest.fixtures).sort(),['TsumTsum','YWP','battlecats']);
  for(const fixture of Object.values(manifest.fixtures)){assert.ok(fixture.size>20_000_000);assert.match(fixture.gitBlobSha1,/^[0-9a-f]{40}$/);}
  assert.equal(fs.existsSync(new URL('../tools/fetch-large-fixtures.mjs',import.meta.url)),true);
}

console.log('issues-194-244: PASS');
