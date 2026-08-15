import assert from 'node:assert/strict';
import { ProductWorkspace } from '../js/workspace.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';

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
  const backend={contentHash:'hash-a',async ensureContentHash(){return this.contentHash;}};
  return {
    store,backend,prefs:{lang:'ja',explain:true,textSize:'m'},notes:new Notes(),patches:new Patches(),
    navigation:{entries:[],index:-1,limit:40,snapshot(){return {};},onChange(){}},
    symbols:{gen:1,funcs:BigUint64Array.from([0x1000n]),functionStartsComplete:true,nameAt:()=>null,rename(){},functionAt(){return null;}},
    viewer:{setSymbols(){}},codeRegion:()=>region,ensureRecognition:async()=>null,
  };
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

// The real UI adapter must expose ProductWorkspace's content hash as the strong
// identity used by TurnSnapshot/ObservationStore, not filename:slice.
{
  const app=makeApp();
  app.workspace={identity:{hash:'content-a'},project:{binary:{hash:'content-a'}}};
  const engine=createAiEngine(app,{loadCore:async()=>null});
  assert.equal(engine.localContext.binaryId,'same.bin:0');
  assert.equal(engine.localContext.binaryFingerprint.hash,'content-a');
  assert.equal(engine.localContext.binaryHash,'content-a');
  assert.equal(engine.localContext.binaryIdentity.id,'content:content-a:0');
  assert.equal(engine.localContext.binaryIdentity.confidence,'strong');

  // Same visible filename/slice, different bytes: identity must change.
  app.workspace.identity.hash='content-b';
  app.workspace.project.binary.hash='content-b';
  assert.equal(engine.localContext.binaryId,'same.bin:0');
  assert.equal(engine.localContext.binaryHash,'content-b');
  assert.equal(engine.localContext.binaryIdentity.id,'content:content-b:0');
}

console.log('cross-binary workspace/AI identity regressions: PASS');
