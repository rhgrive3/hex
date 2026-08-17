import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex, VARIABLE_MAX_DECODE_REQUEST_BYTES, VARIABLE_CACHE_PAGES, VARIABLE_RETAINED_INSTRUCTION_LIMIT } from '../../../js/viewer/variable-instruction-index.js';

const TIB=1n<<40n;
const BASE=0x1000000000n;
function oneByte(address){return{address:BigInt(address),length:1,rawBytes:Uint8Array.of(0x90),mnemonic:'nop',opStr:''};}

test('1 TiB logical region opens without decoding and one distant window reads a tiny bounded fraction', async()=>{
  const requests=[];
  const decode=async(address,{length})=>{requests.push({address:BigInt(address),length});const out=[];for(let i=0;i<length;i++)out.push(oneByte(BigInt(address)+BigInt(i)));return{supported:true,instructions:out,bytesRead:length};};
  const index=new VariableInstructionIndex({disassembleAt:decode,maxPrefetchPages:0});
  index.configureRegion({id:'1tib',vmAddr:BASE,size:TIB});
  assert.equal(index.metrics().decodeRequestCount,0,'region open must not enumerate instructions for totalRows');
  assert.equal(index.metrics().retainedInstructions,0);
  const target=BASE+TIB-0x10000n;
  await index.navigate(target,{trusted:true});
  const m=index.metrics();
  assert.equal(m.decodeRequestCount,1);
  assert.ok(m.requestedDecodeBytes<=VARIABLE_MAX_DECODE_REQUEST_BYTES);
  assert.ok(requests[0].length<=VARIABLE_MAX_DECODE_REQUEST_BYTES);
  assert.ok(m.retainedPages<=VARIABLE_CACHE_PAGES);
  assert.ok(m.retainedInstructions<=VARIABLE_RETAINED_INSTRUCTION_LIMIT);
  assert.ok(BigInt(m.requestedDecodeBytes)*1_000_000n<TIB,'requested bytes must be negligible relative to 1 TiB');
  console.log(JSON.stringify({logicalSourceBytes:TIB.toString(),requestedBytes:m.requestedDecodeBytes,decodeRequests:m.decodeRequestCount,decodedInstructions:m.decodedInstructionCount,retainedPages:m.retainedPages,retainedInstructions:m.retainedInstructions}));
});

test('region-end clamp never requests bytes from adjacent region',async()=>{
  const calls=[];
  const decode=async(address,{length})=>{calls.push({address:BigInt(address),length});const out=[];for(let i=0;i<length;i++)out.push(oneByte(BigInt(address)+BigInt(i)));return{supported:true,instructions:out,bytesRead:length};};
  const index=new VariableInstructionIndex({disassembleAt:decode,maxPrefetchPages:0});
  index.configureRegion({id:'tail',vmAddr:BASE,size:4096n});
  await index.ensurePage(BASE+4086n);
  assert.equal(calls[0].length,10);
  assert.equal(calls[0].address+BigInt(calls[0].length),BASE+4096n);
});
