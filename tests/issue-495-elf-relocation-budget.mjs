import assert from 'node:assert/strict';
import { collectAndroidPackedRelocations, collectRelrRelocations } from '../js/binary/elf-extended.js';
import { createRelocationBudget } from '../js/binary/relocation-budget.js';

const DT_RELRSZ=35n, DT_RELR=36n, DT_RELRENT=37n;
const DT_ANDROID_REL=0x6000000fn, DT_ANDROID_RELSZ=0x60000010n;

function image() {
  return {
    metadata: {}, warnings: [],
    addressToOffset() { return 0n; },
  };
}

function wordReader(words) {
  const bytes=new Uint8Array(words.length*8), view=new DataView(bytes.buffer);
  words.forEach((v,i)=>view.setBigUint64(i*8,BigInt(v),true));
  let reads=0;
  return {
    bytes, length:bytes.length,
    get reads(){return reads;},
    u64(off){reads++;return view.getBigUint64(off,true);},
    u32(off){reads++;return view.getUint32(off,true);},
    u8(off){reads++;return view.getUint8(off);},
  };
}

function byteReader(values, length=values.length) {
  const bytes=Uint8Array.from(values), view=new DataView(bytes.buffer);
  let reads=0;
  return {
    bytes, length,
    get reads(){return reads;},
    u8(off){reads++;return view.getUint8(off);},
    u32(off){reads++;return view.getUint32(off,true);},
    u64(off){reads++;return view.getBigUint64(off,true);},
  };
}

function relrTags(size) {
  return new Map([[DT_RELR,[0x1000n]],[DT_RELRSZ,[BigInt(size)]],[DT_RELRENT,[8n]]]);
}

// Small normal table stays exact.
{
  const r=wordReader([0x1000n,3n]);
  const img=image();
  const out=collectRelrRelocations(r,relrTags(r.length),img,64,{limits:{maxOutput:32,maxInputBytes:1024,maxOperations:1024,maxWallMs:10000}});
  assert.deepEqual(out.map(x=>x.address),[0x1000n,0x1008n]);
  assert.equal(img.metadata.programDynamicPartial,undefined);
}

// Bitmap expansion is capped by output count, not merely encoded entry count.
{
  const r=wordReader([0x1000n,0xffffffffffffffffn,0xffffffffffffffffn]);
  const img=image();
  const out=collectRelrRelocations(r,relrTags(r.length),img,64,{limits:{maxOutput:64,maxInputBytes:1024,maxOperations:10000,maxWallMs:10000}});
  assert.equal(out.length,64);
  assert.equal(img.metadata.programDynamicPartial,true);
  assert.match(img.metadata.programDynamicDiagnostics.join('\n'),/expanded relocations exceed 64/);
}

// Input-byte budget rejects a large declared table before any table read.
{
  const r=byteReader(new Uint8Array(8),4096);
  const img=image();
  const out=collectRelrRelocations(r,relrTags(4096),img,64,{limits:{maxOutput:64,maxInputBytes:32,maxOperations:100,maxWallMs:10000}});
  assert.equal(out.length,0);
  assert.equal(r.reads,0);
  assert.match(img.metadata.programDynamicDiagnostics.join('\n'),/input bytes exceed 32/);
}

// Work budget bounds bitmap scanning even when output bits are sparse.
{
  const r=wordReader([0x1000n,1n]);
  const img=image();
  const out=collectRelrRelocations(r,relrTags(r.length),img,64,{limits:{maxOutput:64,maxInputBytes:1024,maxOperations:2,maxWallMs:10000}});
  assert.equal(out.length,1);
  assert.match(img.metadata.programDynamicDiagnostics.join('\n'),/decode work exceeds 2 operations/);
}

// Wall-clock guard is independently enforced; fake clock makes this deterministic.
{
  let now=0;
  const r=wordReader([0x1000n]);
  const img=image();
  const out=collectRelrRelocations(r,relrTags(r.length),img,64,{limits:{maxOutput:64,maxInputBytes:1024,maxOperations:100,maxWallMs:5,now:()=>{const v=now;now+=10;return v;}}});
  assert.equal(out.length,0);
  assert.equal(r.reads,0);
  assert.match(img.metadata.programDynamicDiagnostics.join('\n'),/decode time exceeds 5 ms/);
}

// APS2 packed relocations use the same output budget primitive.
{
  // APS2, relocationCount=10, initialOffset=0, one grouped block of 10,
  // flags=GROUPED_BY_INFO|GROUPED_BY_OFFSET_DELTA, delta=8, info=0.
  const raw=[0x41,0x50,0x53,0x32,10,0,10,3,8,0];
  const r=byteReader(raw), img=image();
  const tags=new Map([[DT_ANDROID_REL,[0x2000n]],[DT_ANDROID_RELSZ,[BigInt(raw.length)]]]);
  const out=collectAndroidPackedRelocations(r,tags,img,64,{limits:{maxOutput:4,maxInputBytes:1024,maxOperations:100,maxWallMs:10000}});
  assert.equal(out.length,4);
  assert.match(img.metadata.programDynamicDiagnostics.join('\n'),/expanded relocations exceed 4/);
}

// A shared budget caps the combined output across different encoded table types.
{
  const img=image();
  const out=[];
  const budget=createRelocationBudget({
    limits:{maxOutput:3,maxInputBytes:1024,maxOperations:1000,maxWallMs:10000},
    onLimit(message){
      img.metadata.programDynamicPartial=true;
      (img.metadata.programDynamicDiagnostics ||= []).push(message);
    },
  });
  const relr=wordReader([0x1000n,3n]);
  collectRelrRelocations(relr,relrTags(relr.length),img,64,{budget,out});
  const raw=[0x41,0x50,0x53,0x32,4,0,4,3,8,0];
  const android=byteReader(raw);
  collectAndroidPackedRelocations(android,new Map([[DT_ANDROID_REL,[0x2000n]],[DT_ANDROID_RELSZ,[BigInt(raw.length)]]]),img,64,{budget,out});
  assert.equal(out.length,3);
  assert.equal(budget.stopped,true);
}

console.log('issue #495 ELF relocation budget: PASS');
