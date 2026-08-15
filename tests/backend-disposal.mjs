import assert from 'node:assert/strict';

const workers=[];
let added=0,removed=0;
class FakeWorker{
  constructor(){this.sent=[];this.terminated=false;this.onmessage=null;workers.push(this);}
  postMessage(m){this.sent.push(m);}
  terminate(){this.terminated=true;}
}
globalThis.Worker=FakeWorker;
globalThis.document={hidden:false,addEventListener(){added++;},removeEventListener(){removed++;}};
const { Backend }=await import('../js/backend.js');
{
  const b=new Backend();
  assert.equal(added,1);
  const pending=b._callTo('legacy','probe',{});
  const architectureProbe=b.probeArchitectures();
  assert.equal(workers.length,3);
  b.dispose();
  const probeResult=await architectureProbe;
  assert.equal(probeResult.ok,false);
  assert.equal(workers[2].terminated,true,'active architecture probe must terminate on dispose');
  let error=null;try{await pending;}catch(e){error=e;}
  assert.equal(error?.code,'BACKEND_DISPOSED');
  assert.ok(workers.slice(0,2).every((w)=>w.terminated));
  assert.equal(removed,1);
  b.dispose();
  assert.equal(removed,1,'dispose must be idempotent');
  let after=null;try{await b.probe();}catch(e){after=e;}
  assert.equal(after?.code,'BACKEND_DISPOSED');
  const workersBefore=workers.length;
  const disposedProbe=await b.probeArchitectures();
  assert.equal(disposedProbe.ok,false);
  assert.equal(workers.length,workersBefore,'disposed backend must not spawn probe workers');
  const messagesBefore=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  await assert.rejects(()=>b.open({name:'disposed.bin',size:1}), (error)=>error?.code==='BACKEND_DISPOSED');
  const messagesAfter=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfter,messagesBefore,'disposed backend open must not post to terminated workers');
}

delete globalThis.document;
const { ProductWorkspace }=await import('../js/workspace.js');
const region={id:'text',exec:true,vmAddr:0x1000n,size:0x100n,fileOffset:0n};
const makeBackend=(hash,{fail=false}={})=>({
  disposed:0,
  async open(){return {name:'base',slices:[{info:{architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]}]};},
  async ensureContentHash(){if(fail)throw new Error('hash failed');return hash;},
  async analyze(){return {addrs:new BigUint64Array(0),kinds:new Uint8Array(0),flags:new Uint8Array(0),names:[],funcs:new BigUint64Array([0x1000n]),functionStartsComplete:true};},
  dispose(){this.disposed++;},
});
{
  const made=[];
  const app={store:{get:()=>null},backend:{},symbols:null};
  const ws=new ProductWorkspace(app,{backendFactory:()=>{const b=makeBackend('h'+made.length);made.push(b);return b;},storage:null});
  ws.identity={hash:'current',metadata:{architecture:'arm64'}};
  await ws.loadBaseline({name:'a'});
  assert.equal(made[0].disposed,0);
  await ws.loadBaseline({name:'b'});
  assert.equal(made[0].disposed,1,'replaced owned baseline must be disposed');
  assert.equal(made[1].disposed,0);
  ws.dispose();
  assert.equal(made[1].disposed,1,'workspace dispose must release current owned baseline');
}
{
  const failed=makeBackend('bad',{fail:true});
  const app={store:{get:()=>null},backend:{},symbols:null};
  const ws=new ProductWorkspace(app,{backendFactory:()=>failed,storage:null});
  ws.identity={hash:'current',metadata:{architecture:'arm64'}};
  await assert.rejects(()=>ws.loadBaseline({name:'bad'}),/hash failed/);
  assert.equal(failed.disposed,1,'failed owned baseline must be disposed');
}
{
  const external=makeBackend('external');
  const owned=makeBackend('owned');
  const app={store:{get:()=>null},backend:{},symbols:null};
  const ws=new ProductWorkspace(app,{backendFactory:()=>owned,storage:null});
  ws.identity={hash:'current',metadata:{architecture:'arm64'}};
  await ws.loadBaseline({name:'external'},{backend:external});
  await ws.loadBaseline({name:'owned'});
  assert.equal(external.disposed,0,'borrowed backend must not be disposed by workspace');
  ws.dispose();
  assert.equal(owned.disposed,1);
}
console.log('backend/workspace disposal regressions: PASS');
