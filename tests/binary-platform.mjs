import assert from 'node:assert/strict';
import { BinaryImage, ByteView, auditBinary, openBinary, openBinarySource } from '../js/binary/index.js';
import { makeElf64Fixture, makePe64Fixture } from './universal-binary.mjs';
import { makeSectionlessElf64Fixture } from './universal-binary-sectionless.mjs';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';

for (const [name, bytes, format] of [['elf', makeElf64Fixture(), 'elf'], ['pe', makePe64Fixture(), 'pe']]) {
  let largest = 0;
  const source = {
    size: BigInt(bytes.length),
    async read(offset, length) {
      largest = Math.max(largest, length);
      const start = Number(offset);
      return bytes.subarray(start, start + length);
    },
  };
  const image = await openBinarySource(source, { ranges: { pageSize: 64, maxCachedBytes: 1024 * 1024 } });
  assert.equal(image.format, format, name);
  assert.equal(image.bytes, null, `${name}: source-backed image must not retain full bytes`);
  assert.equal(auditBinary(image).errors, 0, `${name}: source-backed audit`);
  assert.ok(largest < bytes.length, `${name}: parser requested entire binary in one read`);
}
function setDynamicSize(v, size) { v.setBigUint64(64+56+32,BigInt(size),true); v.setBigUint64(64+56+40,BigInt(size),true); }
function dyn(v,i,tag,val){const p=0x200+i*16;v.setBigInt64(p,BigInt(tag),true);v.setBigUint64(p+8,BigInt(val),true);}
function sleb(value){let v=BigInt(value),out=[];for(;;){let byte=Number(v&0x7fn),sign=byte&0x40;v>>=7n;const done=(v===0n&&!sign)||(v===-1n&&sign);if(!done)byte|=0x80;out.push(byte);if(done)return out;}}

function issue86To97Regressions(){
  const relr=makeSectionlessElf64Fixture(), rv=new DataView(relr.buffer); setDynamicSize(rv,0xd0); dyn(rv,9,35,16); dyn(rv,10,36,0x4003c0); dyn(rv,11,37,8); dyn(rv,12,0,0); rv.setBigUint64(0x3c0,0x400430n,true); rv.setBigUint64(0x3c8,3n,true); const relrImage=openBinary(relr); assert.deepEqual(relrImage.relocations.filter(x=>x.source==='PT_DYNAMIC-RELR').map(x=>x.address),[0x400430n,0x400438n]);

  const aps=makeSectionlessElf64Fixture(), av=new DataView(aps.buffer); setDynamicSize(av,0xc0); const apsBlob=[0x41,0x50,0x53,0x32,...sleb(1),...sleb(0x400400),...sleb(1),...sleb(15),...sleb(0x20),...sleb((1n<<32n)|7n),...sleb(5)]; aps.set(apsBlob,0x3c0); dyn(av,9,0x60000011,0x4003c0); dyn(av,10,0x60000012,apsBlob.length); dyn(av,11,0,0); const apsImage=openBinary(aps); const ar=apsImage.relocations.find(x=>x.source==='PT_DYNAMIC-ANDROID-RELA'); assert.equal(ar?.address,0x400420n); assert.equal(ar?.symbol,'puts'); assert.equal(ar?.addend,5n);

  const ver=makeSectionlessElf64Fixture(), vv=new DataView(ver.buffer); const versionText=new TextEncoder().encode('GLIBC_2.2.5\0'); ver.set(versionText,0x310); dyn(vv,2,10,0x10+versionText.length); setDynamicSize(vv,0xd0); dyn(vv,9,0x6ffffff0,0x4003c0); dyn(vv,10,0x6ffffffe,0x4003d0); dyn(vv,11,0x6fffffff,1); dyn(vv,12,0,0); vv.setUint16(0x3c0,0,true); vv.setUint16(0x3c2,2,true); vv.setUint16(0x3d0,1,true); vv.setUint16(0x3d2,1,true); vv.setUint32(0x3d4,6,true); vv.setUint32(0x3d8,16,true); vv.setUint32(0x3dc,0,true); vv.setUint32(0x3e0,0,true); vv.setUint16(0x3e4,0,true); vv.setUint16(0x3e6,2,true); vv.setUint32(0x3e8,16,true); vv.setUint32(0x3ec,0,true); const verImage=openBinary(ver); const vi=verImage.imports.find(x=>x.name==='puts'); assert.equal(vi?.version,'GLIBC_2.2.5'); assert.equal(vi?.versionLibrary,'libc.so.6');

  const heuristic=makeSectionlessElf64Fixture(), hv=new DataView(heuristic.buffer); setDynamicSize(hv,0xc0); const ds=heuristic.slice(0x300,0x310); heuristic.set(ds,0x370); dyn(hv,1,5,0x400370); dyn(hv,2,10,16); dyn(hv,5,0x6ffffef0,0); dyn(hv,6,0x6ffffef1,0); dyn(hv,7,0x6ffffef2,0); dyn(hv,8,0x6ffffef3,0); const hi=openBinary(heuristic); assert.equal(hi.metadata.programDynamic.symbolCountSource,'layout-heuristic'); assert.equal(hi.metadata.programDynamicPartial,true);

  const gnuBase=makeSectionlessElf64Fixture(), gnu=new Uint8Array(0x3000); gnu.set(gnuBase); const gv=new DataView(gnu.buffer); gv.setBigUint64(64+32,BigInt(gnu.length),true); gv.setBigUint64(64+40,BigInt(gnu.length),true); dyn(gv,5,0x6ffffef5,0x401000); dyn(gv,6,0x6ffffef1,0); dyn(gv,7,0x6ffffef2,0); dyn(gv,8,0x6ffffef3,0); const go=0x1000; gv.setUint32(go,64,true); gv.setUint32(go+4,1,true); gv.setUint32(go+8,1,true); gv.setUint32(go+12,0,true); let buckets=go+24; for(let i=0;i<64;i++)gv.setUint32(buckets+i*4,1,true); let chains=buckets+64*4; for(let i=0;i<100;i++)gv.setUint32(chains+i*4,i===99?1:0,true); const gi=openBinary(gnu); assert.ok(gi.warnings.some(x=>x.includes('GNU hash chain traversal exceeded')));

  const internal=makeElf64Fixture(), iv=new DataView(internal.buffer); internal[0x190+5]=1; const ii=openBinary(internal); assert.equal(ii.exports.some(x=>x.name==='myfunc'),false);

  const uwBytes=new Uint8Array(64), uwv=new DataView(uwBytes.buffer); const uwImage=new BinaryImage(uwBytes,{format:'elf',bits:64}); uwImage.addSection({name:'.text',address:0x1000n,size:0x20n,fileOffset:0n,fileSize:0x20n,perms:{read:true,execute:true}}); uwBytes.set([1,0xff,3,0x43],32); uwv.setUint32(36,1,true); uwv.setUint32(40,4,true); uwv.setUint32(44,0,true); parseEhFrameHeader(new ByteView(uwBytes),{addr:0x2000n,offset:32n,size:16n},uwImage,64); assert.ok(uwImage.warnings.some(x=>x.includes('funcrel requires a function base')));
  const indirectImage=new BinaryImage(uwBytes,{format:'elf',bits:64}); indirectImage.addSection({name:'.text',address:0x1000n,size:0x20n,fileOffset:0n,fileSize:0x20n,perms:{read:true,execute:true}}); uwBytes.set([1,0xff,3,0x83],32); uwv.setUint32(36,1,true); uwv.setUint32(40,0xdead,true); uwv.setUint32(44,0,true); parseEhFrameHeader(new ByteView(uwBytes),{addr:0x2000n,offset:32n,size:16n},indirectImage,64); assert.ok(indirectImage.warnings.some(x=>x.includes('indirect target')));

  const shortPe=makePe64Fixture(), spv=new DataView(shortPe.buffer); spv.setUint16(0x84+16,0x60,true); assert.throws(()=>openBinary(shortPe),/optional header size/);
  const pe=openBinary(makePe64Fixture()); const text=pe.sections.find(s=>s.name==='.text'); assert.equal(text.size,0x100n); assert.equal(text.fileSize,0x100n); assert.equal(pe.addressToOffset(0x140001100n),null); const textSeg=pe.segments.find(s=>s.name==='.text'); assert.equal(textSeg.size,0x100n); assert.equal(textSeg.fileSize,0x100n);
  const noEntry=makePe64Fixture(), nev=new DataView(noEntry.buffer); nev.setUint32(0x84+20+16,0,true); const nei=openBinary(noEntry); assert.equal(nei.entrypoint,null); assert.equal(nei.functions.some(f=>f.source==='entrypoint'),false);
}

async function issue970VirtualReadRegressions() {
  const bytes = new Uint8Array(0x220);
  bytes.set([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44], 0x100);

  for (const format of ['elf', 'macho', 'pe']) {
    const image = new BinaryImage(bytes, { format });
    image.addSegment({ address:0x1000n, size:8n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
    assert.deepEqual([...image.readVirtual(0x1000n, 4)], [0xaa,0xbb,0xcc,0xdd], `${format}: file-backed read`);
    assert.deepEqual([...image.readVirtual(0x1002n, 4)], [0xcc,0xdd,0,0], `${format}: file-backed to zero-fill`);
    assert.deepEqual([...image.readVirtual(0x1004n, 4)], [0,0,0,0], `${format}: zero-fill read`);
  }

  const gap = new BinaryImage(bytes, { format:'elf' });
  gap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
  assert.equal(gap.readVirtual(0x1002n, 4), null, 'virtual gap must fail closed');

  bytes.set([0xee, 0xff], 0x180);
  const adjacent = new BinaryImage(bytes, { format:'elf' });
  adjacent.addSegment({ address:0x1000n, size:2n, fileOffset:0x100n, fileSize:2n, perms:{read:true} });
  adjacent.addSegment({ address:0x1002n, size:2n, fileOffset:0x180n, fileSize:2n, perms:{read:true} });
  assert.deepEqual([...adjacent.readVirtual(0x1001n, 3)], [0xbb,0xee,0xff], 'adjacent mappings must re-resolve file offsets');

  const source = {
    size: BigInt(bytes.length),
    async readExactly(offset, size) {
      const start = Number(offset), length = Number(size);
      return bytes.subarray(start, start + length);
    },
  };
  const streamed = new BinaryImage(null, { format:'elf', source });
  streamed.addSegment({ address:0x1000n, size:8n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
  assert.deepEqual([...await streamed.readVirtualAsync(0x1002n, 4)], [0xcc,0xdd,0,0], 'streamed read must share virtual-span semantics');

  const streamedGap = new BinaryImage(null, { format:'elf', source });
  streamedGap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
  assert.equal(await streamedGap.readVirtualAsync(0x1002n, 4), null, 'streamed virtual gap must fail closed');
}

issue86To97Regressions();
await issue970VirtualReadRegressions();
console.log('binary-platform: PASS');
