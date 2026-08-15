import assert from 'node:assert/strict';

const workers=[];
class ControlledWorker {
  constructor(url){
    this.url=String(url);this.sent=[];this.onmessage=null;this.onerror=null;this.terminated=false;workers.push(this);
  }
  postMessage(message){this.sent.push(message);}
  terminate(){this.terminated=true;}
  reply(request,result,{ok=true,error=null}={}){
    this.onmessage?.({data:ok?{t:'ok',id:request.id,epoch:request.epoch,result}:{t:'err',id:request.id,epoch:request.epoch,error:error||'failed'}});
  }
}
globalThis.Worker=ControlledWorker;

const { Backend }=await import('../js/backend.js');
const backend=new Backend();
const legacy=workers.find((w)=>/worker\.js/.test(w.url)&&!/platform/.test(w.url));
const platform=workers.find((w)=>/platform\/worker\.js/.test(w.url));
assert.ok(legacy&&platform,'backend must create legacy and platform workers');
const tick=()=>new Promise((resolve)=>setTimeout(resolve,0));
const find=(worker,predicate)=>worker.sent.find((m)=>predicate(m));

const fileA={name:'A.bin',size:4096};
const fileB={name:'B.bin',size:4096};

// Attach the rejection observer immediately: the whole point of the regression
// is that A becomes stale before B finishes, and Node treats a temporarily
// unobserved rejection as fatal.
let staleA=null;
const openA=backend.open(fileA);
const openAObserved=openA.catch((error)=>{staleA=error;return null;});
await tick();
const detectA=find(platform,(m)=>m.t==='detect'&&m.file===fileA);
assert.equal(detectA.epoch,1);
platform.reply(detectA,{formatId:'macho'});
await tick();
const legacyOpenA=find(legacy,(m)=>m.t==='open'&&m.file===fileA);
assert.equal(legacyOpenA.epoch,1);

// B begins while A is still waiting. This moves the global transport epoch to 2.
// The old implementation then let A resume and dispatch its *next* request using
// epoch 2, effectively borrowing B's validity and potentially committing A last.
const openB=backend.open(fileB);
await tick();
const detectB=find(platform,(m)=>m.t==='detect'&&m.file===fileB);
assert.equal(detectB.epoch,2);
platform.reply(detectB,{formatId:'pe'});
await tick();
const platformOpenB=find(platform,(m)=>m.t==='open'&&m.file===fileB);
assert.equal(platformOpenB.epoch,2);

legacy.reply(legacyOpenA,{format:'Mach-O 64-bit',slices:[],raw:{id:'raw'}});
await openAObserved;
assert.equal(staleA?.stale,true,'superseded open must reject as stale');
assert.equal(platform.sent.some((m)=>m.t==='open'&&m.file===fileA),false,'stale A must not dispatch another open under B epoch');

platform.reply(platformOpenB,{formatId:'pe',capability:{architecture:'x86_64'},slices:[],raw:{id:'raw'}});
const resultB=await openB;
assert.equal(resultB.formatId,'pe');
assert.equal(backend.file,fileB,'latest open must own committed backend state');
assert.equal(backend.formatId,'pe');

console.log('backend concurrent-open epoch regression: PASS');
