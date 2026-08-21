import assert from 'node:assert/strict';

const workers=[];
let added=0,removed=0;
class FakeWorker{
  constructor(){this.sent=[];this.terminated=false;this.onmessage=null;this.onerror=null;this.onmessageerror=null;this.throwNext=null;workers.push(this);}
  postMessage(m){if(this.throwNext){const error=this.throwNext;this.throwNext=null;throw error;}this.sent.push(m);}
  terminate(){this.terminated=true;}
}
globalThis.Worker=FakeWorker;
globalThis.document={hidden:false,addEventListener(){added++;},removeEventListener(){removed++;}};
const { Backend }=await import('../js/backend.js');

// Every worker RPC exit path must settle its local promise. A timeout/cancel or
// worker transport failure must never leave an entry orphaned in Backend.pending.
// Local settlement is authoritative even when the best-effort worker cancel message is lost.
{
  const b=new Backend();
  const pending=b._callTo('legacy','probe',{});
  assert.equal(b.pending.size,1);
  assert.equal(pending.cancel(),true);
  await assert.rejects(pending,(error)=>error?.name==='AbortError' && error?.code==='ABORT_ERR');
  assert.equal(b.pending.size,0,'cancel must remove and reject the pending RPC locally');
  assert.ok(b.legacyWorker.sent.some((m)=>m.t==='cancel' && m.requestId===pending.requestId),'cancel must still notify the worker best-effort');

  const a=b._callTo('legacy','probe',{});
  const c=b._callTo('legacy','probe',{});
  const other=b._callTo('platform','probe',{});
  b.legacyWorker.onerror({message:'legacy crashed'});
  await assert.rejects(a,(error)=>error?.code==='WORKER_FAILED');
  await assert.rejects(c,(error)=>error?.code==='WORKER_FAILED');
  assert.equal(b.pending.size,1,'worker failure must reject only requests owned by that worker');
  other.cancel();
  await assert.rejects(other,(error)=>error?.name==='AbortError');

  const decodeFailure=b._callTo('platform','probe',{});
  b.platformWorker.onmessageerror({message:'message decode failed'});
  await assert.rejects(decodeFailure,(error)=>error?.code==='WORKER_FAILED');
  assert.equal(b.pending.size,0,'messageerror must not orphan transport requests');

  b.legacyWorker.throwNext=new Error('post failed');
  const postFailure=b._callTo('legacy','probe',{});
  await assert.rejects(postFailure,/post failed/);
  assert.equal(b.pending.size,0,'synchronous postMessage failure must remove pending state');

  const chunk=b.fetchChunk('text',0,true);
  assert.equal(typeof chunk.cancel,'function','fetchChunk mapping must preserve cancellation');
  chunk.cancel();
  await assert.rejects(chunk,(error)=>error?.name==='AbortError');
  assert.equal(b.pending.size,0);

  const access=b.fieldAccessMany('text',[{offset:0x20n,size:4}]);
  assert.equal(typeof access.cancel,'function','fieldAccessMany mapping must preserve cancellation');
  access.cancel();
  await assert.rejects(access,(error)=>error?.name==='AbortError');
  assert.equal(b.pending.size,0);

  const disasm=b._disassembleBytes(new Uint8Array([0,0,0,0]),0x1000n,'arm64');
  const disasmWorker=b._disasmWorker;
  assert.ok(disasmWorker);
  disasmWorker.onerror({message:'decoder crashed'});
  await assert.rejects(disasm,(error)=>error?.code==='WORKER_FAILED');
  assert.equal(b._disasmPending.size,0,'disassembly worker failure must reject every local decode request');
  assert.equal(b._disasmWorker,null,'failed disassembly worker must be released');
  b.dispose();
}

{
  const b=new Backend();
  assert.equal(added,2);
  const pending=b._callTo('legacy','probe',{});
  const architectureProbe=b.probeArchitectures();
  assert.ok(workers.includes(b.legacyWorker) && workers.includes(b.platformWorker));
  b.dispose();
  const probeResult=await architectureProbe;
  assert.equal(probeResult.ok,false);
  let error=null;try{await pending;}catch(e){error=e;}
  assert.equal(error?.code,'BACKEND_DISPOSED');
  assert.equal(b.legacyWorker.terminated,true);
  assert.equal(b.platformWorker.terminated,true);
  assert.equal(removed,2);
  b.dispose();
  assert.equal(removed,2,'dispose must be idempotent');
  let after=null;try{await b.probe();}catch(e){after=e;}
  assert.equal(after?.code,'BACKEND_DISPOSED');
  const workersBefore=workers.length;
  const disposedProbe=await b.probeArchitectures();
  assert.equal(disposedProbe.ok,false);
  assert.equal(workers.length,workersBefore,'disposed backend must not spawn probe workers');
  const messagesBefore=[b.legacyWorker,b.platformWorker].reduce((sum,w)=>sum+w.sent.length,0);
  await assert.rejects(()=>b.open({name:'disposed.bin',size:1}), (error)=>error?.code==='BACKEND_DISPOSED');
  const messagesAfter=[b.legacyWorker,b.platformWorker].reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfter,messagesBefore,'disposed backend open must not post to terminated workers');
  const epochAfterDispose=b.gen;
  assert.equal(b.advanceEpoch(),epochAfterDispose,'disposed backend epoch advance must be a no-op');
  const messagesAfterEpoch=[b.legacyWorker,b.platformWorker].reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfterEpoch,messagesAfter,'disposed backend epoch advance must not post to terminated workers');
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
