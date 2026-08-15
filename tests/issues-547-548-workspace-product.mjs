import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ProductWorkspace, sameProjectIdentity, snapshotWorkspace, applyWorkspaceProject } from '../js/workspace.js';
import { serializeHexProject, parseHexProject } from '../js/project/index.js';

class Storage { constructor(){this.m=new Map();} getItem(k){return this.m.get(k)||null;} setItem(k,v){this.m.set(k,String(v));} }
class Notes {
  constructor(){this.id='notes';this.names=new Map();this.comments=new Map();this.types=new Map();this.vars=new Map();this.structs=[];this.lastSaveError=null;}
  nameEntries(){return [...this.names].map(([k,name])=>({addr:BigInt(k),name}));}
  save(){return true;}
}
class Patches { constructor(){this.x=[];} clear(){this.x=[];} list(){return this.x.slice();} add(offset,before,after,meta={}){this.x.push({offset:BigInt(offset),before:Uint8Array.from(before),after:Uint8Array.from(after),...meta});} }
const region={id:'text',name:'__text',section:'__text',exec:true,vmAddr:0x1000n,size:0x1000n,fileOffset:0n};
function store(values){return {get:(k)=>values[k]};}
function fakeApp(){
  const values={fileInfo:{name:'A.bin',size:4096,format:'macho',slices:[{offset:0n,size:4096n,info:{uuid:'U',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]}]},file:{name:'A.bin',size:4096},sliceIndex:0,architecture:'arm64',currentAddress:0x1000n};
  const app={
    store:store(values),prefs:{lang:'ja',explain:true,textSize:'m'},notes:new Notes(),patches:new Patches(),
    navigation:{entries:[{key:'text:4096:asm',regionId:'text',addr:0x1000n,mode:'asm'}],index:0,limit:40,snapshot(){return {current:this.entries[this.index]};},onChange(){}},
    backend:{contentHash:'hash-a',ensureContentHash:async()=> 'hash-a'},
    symbols:{gen:1,funcs:BigUint64Array.from([0x1000n,0x1100n]),functionStartsComplete:true,nameAt:(a)=>a===0x1000n?'foo':'bar',rename(){}},
    viewer:{setSymbols(){}},autoReport:{report:{confirmed:[{id:'finding'}],deep:[{id:'evidence'}]}},lastGoal:{text:'coins'},
    codeRegion:()=>region,ensureRecognition:async()=>null,
  };
  return app;
}

const app=fakeApp();app.notes.names.set('4096','renamed');app.notes.comments.set('4096','comment');app.notes.types.set('4096:x0','int');app.notes.structs=[{name:'S'}];app.patches.add(12n,[1,2],[3,4],{addr:0x1000n,label:'p'});
const identity={hash:'hash-a',metadata:{name:'A.bin',size:4096,format:'macho',sliceIndex:0,sliceOffset:0n,sliceSize:4096n,uuid:'U',architecture:'arm64'}};
const project=snapshotWorkspace(app,identity);const round=parseHexProject(serializeHexProject(project));
assert.equal(round.binary.hash,'hash-a');assert.equal(round.user.names[0].value,'renamed');assert.equal(round.user.patches.length,1);assert.equal(round.findings.confirmed.length,1);assert.equal(round.navigation.history.length,1);
assert.equal(sameProjectIdentity(round,identity).ok,true);
assert.equal(sameProjectIdentity(round,{...identity,hash:'hash-b'}).reason,'binary-hash-mismatch');
assert.equal(sameProjectIdentity(round,{...identity,metadata:{...identity.metadata,sliceIndex:1}}).reason,'slice-identity-mismatch');

const restored=fakeApp();applyWorkspaceProject(restored,round);assert.equal(restored.notes.names.get('4096'),'renamed');assert.equal(restored.notes.comments.get('4096'),'comment');assert.equal(restored.patches.list().length,1);assert.equal(restored.autoReport.restored,true);

const storage=new Storage();const ws=new ProductWorkspace(app,{storage,backendFactory:()=>({})});app.workspace=ws;await ws.bind();assert.equal(ws.identity.hash,'hash-a');assert.equal(ws.autosave(),true);
const appReload=fakeApp();const wsReload=new ProductWorkspace(appReload,{storage,backendFactory:()=>({})});appReload.workspace=wsReload;await wsReload.bind();assert.equal(appReload.notes.names.get('4096'),'renamed','autosave must restore only the same binary/slice');

let mismatch=false;try{await wsReload.importProject(new Blob([serializeHexProject({...round,binary:{...round.binary,hash:'other'}})]));}catch(e){mismatch=e.code==='HEX_PROJECT_BINARY_MISMATCH';}assert.equal(mismatch,true,'portable import must reject another binary');

const baselineBackend={
  async open(){return {name:'old.bin',slices:[{offset:0n,size:4096n,info:{uuid:'OLD',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]}]};},
  async ensureContentHash(){return 'hash-old';},
  async analyze(){return {addrs:BigUint64Array.from([0x1000n,0x1100n]),kinds:Uint8Array.from([0,0]),flags:Uint8Array.from([0,0]),names:['foo','bar'],funcs:BigUint64Array.from([0x1000n,0x1100n]),functionStartsComplete:true,allSeedsExact:true};},
};
const diffApp=fakeApp();const dws=new ProductWorkspace(diffApp,{storage:new Storage(),backendFactory:()=>baselineBackend});diffApp.workspace=dws;await dws.bind();await dws.loadBaseline(new Blob([new Uint8Array(32)]));const diff=await dws.diff({matchBudget:{maxCandidateEvaluations:10000,maxEdges:10000}});assert.equal(diff.provenance.baselineHash,'hash-old');assert.equal(diff.provenance.currentHash,'hash-a');assert.equal(diff.completeness.complete,true);assert.ok(diff.changes.length>=2);

const mismatchBackend={...baselineBackend,async open(){return {name:'x86.bin',slices:[{info:{architecture:'x86_64'},capability:{architecture:'x86_64'},regions:[region]}]};}};
const mismatchWs=new ProductWorkspace(fakeApp(),{storage:new Storage(),backendFactory:()=>mismatchBackend});await mismatchWs.bind();let archMismatch=false;try{await mismatchWs.loadBaseline(new Blob([1]));}catch(e){archMismatch=e.code==='DIFF_ARCH_MISMATCH';}assert.equal(archMismatch,true);

const appSrc=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const uiSrc=fs.readFileSync(new URL('../js/ui/product.js',import.meta.url),'utf8');
const registrySrc=fs.readFileSync(new URL('../js/ui/registry.js',import.meta.url),'utf8');
const aiSrc=fs.readFileSync(new URL('../js/ai/ui/hex-context.js',import.meta.url),'utf8');
assert.match(appSrc,/new ProductWorkspace\(this\)/);assert.match(appSrc,/workspace\?\.autosave\(\)/);assert.match(appSrc,/exportProjectFile/);assert.match(appSrc,/loadDiffBaseline/);
assert.match(registrySrc,/id: 'diff', pattern: '\/diff'/);assert.match(uiSrc,/function renderDiff/);assert.match(uiSrc,/プロジェクトを書き出す/);assert.match(uiSrc,/importProjectFromProduct/);
assert.match(aiSrc,/getBinaryDiff/);assert.match(aiSrc,/app\.workspace\?\.project/);
console.log('issues #547/#548 workspace product regressions: PASS');
