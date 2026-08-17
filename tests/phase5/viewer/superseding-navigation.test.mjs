import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';

function page(address, length) {
  const out=[];
  for(let i=0;i<length;i++) out.push({ address:BigInt(address)+BigInt(i), length:1, rawBytes:Uint8Array.of(0x90), mnemonic:'nop', opStr:'' });
  return out;
}

test('superseding navigation cancels obsolete decode and cannot publish its cache page', async () => {
  const base=0x9000n;
  const targetB=base+0x100n;
  let releaseA;
  const gateA=new Promise((resolve)=>{releaseA=resolve;});
  const calls=[];
  const index=new VariableInstructionIndex({
    pageBytes:32,
    maxPrefetchPages:0,
    disassembleAt:async(address,{length,signal})=>{
      const start=BigInt(address);
      calls.push({address:start,length,signal});
      if(start===base) await gateA;
      if(signal?.aborted) throw Object.assign(new Error('aborted'),{name:'AbortError'});
      return {supported:true,instructions:page(start,length),bytesRead:length};
    },
  });
  index.configureRegion({id:'supersede',vmAddr:base,size:0x1000n});

  const pendingA=index.navigate(base,{trusted:true}).catch((error)=>error);
  await Promise.resolve();
  const resultB=await index.navigate(targetB,{trusted:true});
  assert.equal(resultB.status,'decoded');
  assert.equal(resultB.address,targetB);
  assert.ok(index.knownEntry(targetB));

  releaseA();
  const resultA=await pendingA;
  assert.equal(resultA?.name,'AbortError');
  assert.equal(index.knownEntry(base),null,'cancelled stale page A must not publish into retained cache');
  assert.equal(index.metrics().retainedPages,1,'only current page B remains retained');
  assert.equal(index.metrics().cancelledRequests,1);
  assert.equal(index.metrics().staleResultsDiscarded,0,'same-generation supersession is cancelled before stale publication');
  assert.equal(calls.length,2);
  console.log(JSON.stringify({cancelledRequests:index.metrics().cancelledRequests,staleResultsDiscarded:index.metrics().staleResultsDiscarded,retainedPages:index.metrics().retainedPages}));
});
