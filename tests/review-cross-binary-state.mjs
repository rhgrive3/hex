import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ProductWorkspace, sameProjectIdentity } from '../js/workspace.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';
import { createHexProject, serializeHexProject } from '../js/project/index.js';

class Storage {
  constructor(){ this.m=new Map(); }
  getItem(k){ return this.m.get(k)||null; }
  setItem(k,v){ this.m.set(k,String(v)); }
}
class Notes {
  constructor(){ this.id='notes';this.names=new Map();this.comments=new Map();this.types=new Map();this.vars=new Map();this.structs=[];this.lastSaveError=null; }
  nameEntries(){ return [...this.names].map(([k,name])=>({addr:BigInt(k),name})); }
  save(){ return true; }
}
class Patches {
  constructor(){this.x=[];}
  clear(){this.x=[];}
  list(){return this.x.slice();}
  add(offset,before,after,meta={}){this.x.push({offset:BigInt(offset),before,after,...meta});}
}

const region={id:'text',name:'__text',section:'__text',exec:true,vmAddr:0x1000n,size:0x1000n,fileOffset:0n};
function makeInfo(name,uuid){return {name,size:4096,format:'macho',slices:[{offset:0n,size:4096n,info:{uuid,architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]}]};}
function makeApp(){
  const values={fileInfo:makeInfo('same.bin','A'),file:{name:'same.bin',size:4096},sliceIndex:0,architecture:'arm64',currentAddress:0x1000n,canDisassemble:false};
  const store={values,get(k){return this.values[k];}};
  const backend={gen:1,contentHash:'hash-a',async ensureContentHash(){return this.contentHash;}};
  return {
    store,backend,prefs:{lang:'ja',explain:true,textSize:'m'},notes:new Notes(),patches:new Patches(),
    navigation:{entries:[],index:-1,limit:40,snapshot(){return {};},onChange(){}},
    symbols:{gen:1,funcs:BigUint64Array.from([0x1000n]),functionStartsComplete:true,nameAt:()=>null,rename(){},functionAt(){return null;}},
    viewer:{setSymbols(){}},codeRegion:()=>region,ensureRecognition:async()=>null,
  };
}
function oneFunction(name,address=0x1000n){
  const functions=[{address,name,size:4,strings:[],calls:[],imports:[],semantic:{writes:[],thresholds:[]},fieldAccessShape:[]}];
  functions.complete=true;functions.total=1;functions.scanned=1;functions.truncationReason=null;
  return functions;
}

// Binding a new binary/slice must never inherit the previous in-memory project,
// diff baseline, or diff result merely because there is no saved project yet.
{
  const app=makeApp();
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  const first=await workspace.bind();
  assert.equal(first.binary.hash,'hash-a');
  workspace.baseline={hash:'old-baseline'};
  workspace.diffState={provenance:{currentHash:'hash-a'}};

  app.backend.contentHash='hash-b';
  app.store.values.fileInfo=makeInfo('same.bin','B');
  app.store.values.file={name:'same.bin',size:4096};
  const second=await workspace.bind();
  assert.notEqual(second,first);
  assert.equal(second.binary.hash,'hash-b');
  assert.equal(second.binary.metadata.uuid,'B');
  assert.equal(workspace.baseline,null);
  assert.equal(workspace.diffState,null);

  // A slice identity change is also a hard analysis boundary even when the
  // underlying content hash is the same.
  workspace.baseline={hash:'slice-baseline'};
  workspace.diffState={provenance:{currentHash:'hash-b'}};
  app.store.values.fileInfo={...makeInfo('same.bin','B'),slices:[
    {offset:0n,size:2048n,info:{uuid:'B0',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]},
    {offset:2048n,size:2048n,info:{uuid:'B1',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]},
  ]};
  app.store.values.sliceIndex=1;
  const third=await workspace.bind();
  assert.equal(third.binary.metadata.sliceIndex,1);
  assert.equal(third.binary.metadata.uuid,'B1');
  assert.equal(workspace.baseline,null);
  assert.equal(workspace.diffState,null);
}

// An async diff that started for A must not repopulate diffState after B binds.
{
  const app=makeApp();
  let releaseRecognition;
  app.ensureRecognition=()=>new Promise((resolve)=>{releaseRecognition=resolve;});
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const before=oneFunction('old');
  workspace.baseline={hash:'baseline-a',architecture:'arm64',info:{name:'baseline'},functions:before};
  const pending=workspace.diff({matchBudget:{maxCandidateEvaluations:10,maxEdges:10,maxComponentNodes:10,maxComponentEdges:10}});
  await Promise.resolve();

  app.backend.contentHash='hash-b';
  app.store.values.fileInfo=makeInfo('same.bin','B');
  await workspace.bind();
  releaseRecognition();
  let stale=null;
  try{await pending;}catch(error){stale=error;}
  assert.equal(stale?.code,'HEX_WORKSPACE_STALE');
  assert.equal(workspace.diffState,null,'stale diff must not restore old state');
}

// Replacing only the comparison baseline is also a transaction boundary. A
// diff started against baseline A must never publish as the result for B.
{
  const app=makeApp();
  let releaseRecognition;
  app.ensureRecognition=()=>new Promise((resolve)=>{releaseRecognition=resolve;});
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const baselineA={hash:'baseline-a',architecture:'arm64',info:{name:'baseline-a'},functions:oneFunction('old-a')};
  const baselineB={hash:'baseline-b',architecture:'arm64',info:{name:'baseline-b'},functions:oneFunction('old-b',0x1100n)};
  workspace.baseline=baselineA;
  const pending=workspace.diff({matchBudget:{maxCandidateEvaluations:10,maxEdges:10,maxComponentNodes:10,maxComponentEdges:10}});
  await Promise.resolve();

  workspace.baseline=baselineB;
  workspace.diffState=null;
  workspace.busy=null;
  releaseRecognition();
  let stale=null;
  try{await pending;}catch(error){stale=error;}
  assert.equal(stale?.code,'HEX_WORKSPACE_STALE');
  assert.equal(workspace.baseline,baselineB);
  assert.equal(workspace.diffState,null,'old baseline diff must not publish after replacement');
}

// A project whose hash matches but whose slice identity is missing must not be
// accepted into a concrete active slice. Missing metadata is not proof of a match.
{
  const app=makeApp();
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const match=sameProjectIdentity({binary:{hash:'hash-a',metadata:{}}},workspace.identity);
  assert.equal(match.ok,false);
  assert.equal(match.reason,'slice-identity-incomplete');
  assert.equal(match.field,'sliceIndex');
}

// Project parsing is asynchronous for Blob inputs. If the active file changes
// while text() is pending, the old project's notes must never land in the new
// file's NoteStore before workspace.bind() catches up.
{
  const app=makeApp();
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const text=serializeHexProject(createHexProject({binary:workspace.identity,userNames:[{address:0x1000n,value:'from-a'}]}));
  let releaseImport;
  const input=new Blob([text]);
  // importHexProject reads bytes, not Blob.text(): the default text decode is
  // non-fatal and would silently repair a corrupted project (#1388). The race
  // this test pins is unchanged -- only the method it suspends.
  Object.defineProperty(input,'arrayBuffer',{value:()=>new Promise((resolve)=>{releaseImport=()=>resolve(new TextEncoder().encode(text).buffer);})});
  const pending=workspace.importProject(input);
  await Promise.resolve();
  assert.equal(typeof releaseImport,'function');

  const notesB=new Notes();
  app.backend.gen++;
  app.backend.contentHash=null;
  app.store.values.fileInfo=makeInfo('same.bin','B');
  app.store.values.file={name:'same.bin',size:4096};
  app.notes=notesB;
  releaseImport();

  let stale=null;
  try{await pending;}catch(error){stale=error;}
  assert.equal(stale?.code,'HEX_WORKSPACE_STALE');
  assert.equal(notesB.names.size,0,'stale project import must not mutate the new file notes');
}

// Starting an import after a same-file slice switch but before workspace.bind()
// must not trust the old slice identity merely because the content hash matches.
{
  const app=makeApp();
  const info=makeInfo('same.bin','A');
  info.slices=[
    {offset:0n,size:2048n,info:{uuid:'A0',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]},
    {offset:2048n,size:2048n,info:{uuid:'A1',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]},
  ];
  app.store.values.fileInfo=info;
  app.store.values.sliceIndex=0;
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const text=serializeHexProject(createHexProject({binary:workspace.identity,userNames:[{address:0x1000n,value:'slice-a'}]}));

  const notesB=new Notes();
  app.backend.gen++;
  app.store.values.sliceIndex=1;
  app.notes=notesB;
  let rejected=null;
  try{await workspace.importProject(text);}catch(error){rejected=error;}
  assert.equal(rejected?.code,'HEX_PROJECT_BINARY_MISMATCH');
  assert.equal(rejected?.detail?.field,'sliceIndex');
  assert.equal(notesB.names.size,0,'old-slice project must not mutate the new slice notes');
  assert.equal(workspace.identity?.metadata?.sliceIndex,1,'import preflight must rebind to the live slice');
}

// The app must invalidate the bound workspace immediately when a new file or
// slice becomes active; waiting for async note attachment leaves a stale window.
{
  const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
  const openStart=source.indexOf('  async openFile(');
  const openEpochAt=source.indexOf('const openEpoch=this.backend.gen;',openStart);
  const openInvalidateAt=source.indexOf('this.workspace?.invalidate();',openEpochAt);
  const openClearAt=source.indexOf('this.activeProject=null;',openInvalidateAt);
  const openStoreAt=source.indexOf('this.store.set({file,fileInfo:info,selectedRow:-1});',openClearAt);
  assert.ok(openStart>=0 && openEpochAt>openStart && openInvalidateAt>openEpochAt && openClearAt>openInvalidateAt && openStoreAt>openClearAt);

  const sliceStart=source.indexOf('  async selectSlice(');
  const sliceAutosaveAt=source.indexOf('this.workspace?.autosave();',sliceStart);
  const sliceInvalidateAt=source.indexOf('this.workspace?.invalidate();',sliceAutosaveAt);
  const sliceClearAt=source.indexOf('this.activeProject=null;',sliceInvalidateAt);
  const sliceAbortAt=source.indexOf('this.noteAttachController?.abort();',sliceClearAt);
  const sliceEpochAt=source.indexOf('this.backend.advanceEpoch();',sliceAbortAt);
  assert.ok(sliceStart>=0 && sliceAutosaveAt>sliceStart && sliceInvalidateAt>sliceAutosaveAt && sliceClearAt>sliceInvalidateAt && sliceAbortAt>sliceClearAt && sliceEpochAt>sliceAbortAt);
}

// The real UI adapter must expose the live Backend/ProductWorkspace content hash
// as the strong identity used by TurnSnapshot/ObservationStore, not filename:slice.
{
  const app=makeApp();
  app.backend.contentHash='content-a';
  app.workspace={identity:{hash:'content-a'},project:{binary:{hash:'content-a'}}};
  const engine=createAiEngine(app,{loadCore:async()=>null});
  assert.equal(engine.localContext.binaryId,'same.bin:0');
  assert.equal(engine.localContext.binaryFingerprint.hash,'content-a');
  assert.equal(engine.localContext.binaryHash,'content-a');
  assert.equal(engine.localContext.binaryIdentity.id,'content:content-a:0');
  assert.equal(engine.localContext.binaryIdentity.confidence,'strong');

  // During a new file open Backend clears contentHash. The old workspace hash
  // must not masquerade as the new file's identity in that transition window.
  app.backend.contentHash=null;
  app.workspace.identity.hash='content-b';
  app.workspace.project.binary.hash='content-b';
  assert.equal(engine.localContext.binaryHash,null);
  assert.equal(engine.localContext.binaryIdentity,null);

  // Once the new content hash is established, same filename/slice but different
  // bytes must receive a distinct strong identity.
  app.backend.contentHash='content-b';
  assert.equal(engine.localContext.binaryId,'same.bin:0');
  assert.equal(engine.localContext.binaryHash,'content-b');
  assert.equal(engine.localContext.binaryIdentity.id,'content:content-b:0');
}

console.log('cross-binary workspace/AI identity regressions: PASS');