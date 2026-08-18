import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';

function ins(address, length=1) { return { address:BigInt(address), length, rawBytes:new Uint8Array(length), mnemonic:'nop', opStr:'' }; }
function exactDecoder(boundaries) {
  const map = new Map(boundaries.map((x) => [BigInt(x.address).toString(), x]));
  const calls=[];
  const fn=async (address,{length,signal})=>{
    calls.push({address:BigInt(address),length}); if(signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
    const out=[]; let cursor=BigInt(address),end=cursor+BigInt(length);
    while(cursor<end){const x=map.get(cursor.toString());if(!x||cursor+BigInt(x.length)>end)break;out.push(x);cursor+=BigInt(x.length);}
    return {supported:true,instructions:out,bytesRead:length};
  };fn.calls=calls;return fn;
}

test('backward navigation uses known boundary before bounded resynchronization', async()=>{
  const base=0x1000n;
  const entries=[ins(base,2),ins(base+2n,5),ins(base+7n,3),ins(base+10n,1)];
  const decode=exactDecoder(entries);
  const index=new VariableInstructionIndex({disassembleAt:decode,pageBytes:32,maxPrefetchPages:0});
  index.configureRegion({id:'back',vmAddr:base,size:64n});
  await index.ensurePage(base);
  const before=decode.calls.length;
  const previous=await index.previousBoundary(base+7n);
  assert.equal(previous.status,'proven');
  assert.equal(previous.address,base+2n);
  assert.equal(previous.source,'known-page');
  assert.equal(decode.calls.length,before,'known page must not trigger backward scan');
});

test('bounded resynchronization proves only a unique predecessor path', async()=>{
  const base=0x2000n,target=base+10n;
  const entries=[ins(base+2n,3),ins(base+5n,5),ins(target,1)];
  const decode=exactDecoder(entries);
  const index=new VariableInstructionIndex({disassembleAt:decode,pageBytes:32,maxPrefetchPages:0,resyncBytes:32});
  index.configureRegion({id:'resync',vmAddr:base,size:128n});
  const result=await index.previousBoundary(target);
  assert.equal(result.status,'proven');
  assert.equal(result.address,base+5n);
  assert.equal(result.source,'bounded-resync');
  assert.ok(decode.calls.length<=15);
  assert.ok(decode.calls.every((call)=>call.address>=target-15n&&call.address<target));
});

test('ambiguous backward paths are exposed and never guessed as target - 1', async()=>{
  const base=0x3000n,target=base+12n,calls=[];
  const decode=async(address,{length})=>{calls.push({address:BigInt(address),length});const start=BigInt(address),distance=Number(target-start);return{supported:true,instructions:distance>=1&&distance<=15?[ins(start,distance)]:[]};};
  const index=new VariableInstructionIndex({disassembleAt:decode,pageBytes:32,maxPrefetchPages:0,resyncBytes:32});
  index.configureRegion({id:'amb',vmAddr:base,size:128n});
  const result=await index.previousBoundary(target);
  assert.equal(result.status,'ambiguous');
  assert.ok(result.candidates.length>1);
  assert.equal(result.address,target);
  assert.ok(calls.length<=15);
});

test('random distant jumps remain bounded by local work rather than distance', async()=>{
  const base=0x100000000n,size=1n<<40n;
  const targets=[base+0x100n,base+size-0x1000n,base+(size>>1n)];
  const calls=[];
  const decode=async(address,{length})=>{
    calls.push({address:BigInt(address),length});
    if((BigInt(address)&15n)!==0n)return{supported:true,instructions:[]};
    const out=[];let cur=BigInt(address),end=cur+BigInt(length);while(cur<end){const n=Math.min(5,Number(end-cur));if(n<=0)break;out.push(ins(cur,n));cur+=BigInt(n);}return{supported:true,instructions:out};
  };
  const index=new VariableInstructionIndex({disassembleAt:decode,pageBytes:64,maxPrefetchPages:0,resyncBytes:32,maxPages:3,maxInstructions:192});
  index.configureRegion({id:'huge',vmAddr:base,size});
  for(const target of targets) await index.navigate(target,{trusted:true});
  assert.equal(index.metrics().decodeRequestCount,3);
  assert.ok(index.metrics().requestedDecodeBytes<=3*(64+14));
  assert.ok(index.metrics().retainedPages<=3);
  assert.ok(index.metrics().retainedInstructions<=192);
  assert.equal(calls.length,3);
});

test('prefetch is finite and does not recursively walk the region', async()=>{
  const base=0x5000n;
  const entries=Array.from({length:512},(_,i)=>ins(base+BigInt(i),1));
  const decode=exactDecoder(entries);
  const index=new VariableInstructionIndex({disassembleAt:decode,pageBytes:32,maxPrefetchPages:1,maxPages:4});
  index.configureRegion({id:'prefetch',vmAddr:base,size:512n});
  const first=await index.ensurePage(base);
  const before=decode.calls.length;
  const pages=await index.prefetchForward(first);
  assert.equal(pages.length,1);
  assert.equal(decode.calls.length-before,1);
  assert.equal(index.metrics().retainedPages,2);
});
