import assert from 'node:assert/strict';
import { BinaryImage, ByteView, auditBinary, openBinary, openBinarySource } from '../js/binary/index.js';
import { makeElf64Fixture, makePe64Fixture } from './universal-binary.mjs';
import { makeSectionlessElf64Fixture } from './universal-binary-sectionless.mjs';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';
import { parseExceptionFunctions } from '../js/binary/pe-loader.js';

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

  const heuristic=makeSectionlessElf64Fixture(), hv=new DataView(heuristic.buffer); const ds=heuristic.slice(0x300,0x310); heuristic.set(ds,0x370); dyn(hv,1,5,0x400370); dyn(hv,2,10,16); dyn(hv,5,0x6ffffef0,0); dyn(hv,6,0x6ffffef1,0); dyn(hv,7,0x6ffffef2,0); dyn(hv,8,0x6ffffef3,0); const hi=openBinary(heuristic); assert.equal(hi.metadata.programDynamic.symbolCountSource,'layout-heuristic'); assert.equal(hi.metadata.programDynamicPartial,true);

  const gnuBase=makeSectionlessElf64Fixture(), gnu=new Uint8Array(0x3000); gnu.set(gnuBase); const gv=new DataView(gnu.buffer); gv.setBigUint64(64+32,BigInt(gnu.length),true); gv.setBigUint64(64+40,BigInt(gnu.length),true); dyn(gv,5,0x6ffffef5,0x401000); dyn(gv,6,0x6ffffef1,0); dyn(gv,7,0x6ffffef2,0); dyn(gv,8,0x6ffffef3,0); const go=0x1000; gv.setUint32(go,64,true); gv.setUint32(go+4,1,true); gv.setUint32(go+8,1,true); gv.setUint32(go+12,0,true); let buckets=go+24; for(let i=0;i<64;i++)gv.setUint32(buckets+i*4,1,true); let chains=buckets+64*4; for(let i=0;i<100;i++)gv.setUint32(chains+i*4,i===99?1:0,true); const gi=openBinary(gnu); assert.ok(gi.warnings.some(x=>x.includes('GNU hash chain traversal exceeded')));

  const internal=makeElf64Fixture(), iv=new DataView(internal.buffer); internal[0x190+5]=1; const ii=openBinary(internal); assert.equal(ii.exports.some(x=>x.name==='myfunc'),false);

  const uwBytes=new Uint8Array(64), uwv=new DataView(uwBytes.buffer); const uwImage=new BinaryImage(uwBytes,{format:'elf',bits:64}); uwImage.addSection({name:'.text',address:0x1000n,size:0x20n,fileOffset:0n,fileSize:0x20n,perms:{read:true,execute:true}}); uwBytes.set([1,0xff,3,0x43],32); uwv.setUint32(36,1,true); uwv.setUint32(40,4,true); uwv.setUint32(44,0,true); parseEhFrameHeader(new ByteView(uwBytes),{addr:0x2000n,offset:32n,size:16n},uwImage,64); assert.ok(uwImage.warnings.some(x=>x.includes('funcrel requires a function base')));
  const indirectImage=new BinaryImage(uwBytes,{format:'elf',bits:64}); indirectImage.addSection({name:'.text',address:0x1000n,size:0x20n,fileOffset:0n,fileSize:0x20n,perms:{read:true,execute:true}}); uwBytes.set([1,0xff,3,0x83],32); uwv.setUint32(36,1,true); uwv.setUint32(40,0xdead,true); uwv.setUint32(44,0,true); parseEhFrameHeader(new ByteView(uwBytes),{addr:0x2000n,offset:32n,size:16n},indirectImage,64); assert.ok(indirectImage.warnings.some(x=>x.includes('indirect target')));

  const shortPe=makePe64Fixture(), spv=new DataView(shortPe.buffer); spv.setUint16(0x84+16,0x60,true); assert.throws(()=>openBinary(shortPe),/optional header size/);
  const pe=openBinary(makePe64Fixture()); const text=pe.sections.find(s=>s.name==='.text'); assert.equal(text.size,0x100n); assert.equal(text.fileSize,0x100n); assert.equal(pe.addressToOffset(0x140001100n),null); const textSeg=pe.segments.find(s=>s.name==='.text'); assert.equal(textSeg.size,0x100n); assert.equal(textSeg.fileSize,0x100n);
  const noEntry=makePe64Fixture(), nev=new DataView(noEntry.buffer); nev.setUint32(0x84+20+16,0,true); const nei=openBinary(noEntry); assert.equal(nei.entrypoint,null); assert.equal(nei.functions.some(f=>f.source==='entrypoint'),false);
}


function peUnwindFragmentRegressions() {
  const makeImage = () => {
    const bytes = new Uint8Array(0x400), image = new BinaryImage(bytes,{format:'pe',bits:64,imageBase:0x10000000n});
    image.addSection({name:'.text',address:0x10001000n,size:0x4000n,fileOffset:0n,fileSize:0x80n,perms:{read:true,execute:true}});
    image.addSection({name:'.pdata',address:0x10005000n,size:0x100n,fileOffset:0x100n,fileSize:0x100n,perms:{read:true}});
    image.addSection({name:'.xdata',address:0x10006000n,size:0x100n,fileOffset:0x200n,fileSize:0x100n,perms:{read:true}});
    return { bytes, view:new DataView(bytes.buffer), image };
  };
  {
    const {bytes,view,image}=makeImage();
    view.setUint32(0x100,0x1000,true);view.setUint32(0x104,(0x10<<2)|1,true);
    view.setUint32(0x108,0x2000,true);view.setUint32(0x10c,(0x08<<2)|2,true);
    view.setUint32(0x110,0x3000,true);view.setUint32(0x114,(0x08<<2)|3,true);
    parseExceptionFunctions(new ByteView(bytes),{rva:0x5000,size:24},image,0xaa64);
    assert.deepEqual(image.functions.map(f=>f.address),[0x10001000n]);
    assert.equal(image.metadata.exceptionDirectory.fragments.length,1);
    assert.equal(image.metadata.exceptionDirectory.fragments[0].address,0x10002000n);
    assert.ok(image.warnings.some(x=>x.includes('reserved ARM64')));
  }
  {
    const {bytes,view,image}=makeImage();
    view.setUint32(0x100,0x1000,true);view.setUint32(0x104,0x6000,true);
    view.setUint32(0x108,0x2000,true);view.setUint32(0x10c,0x6010,true);
    view.setUint32(0x200,0x10|(1<<21)|(1<<28),true);view.setUint32(0x204,0,true);
    view.setUint32(0x210,0x08|(1<<21)|(1<<22)|(1<<28),true);view.setUint32(0x214,0,true);
    parseExceptionFunctions(new ByteView(bytes),{rva:0x5000,size:16},image,0xaa64);
    assert.deepEqual(image.functions.map(f=>f.address),[0x10001000n]);
    assert.equal(image.functions[0].size,64n);
    assert.equal(image.metadata.exceptionDirectory.fragments[0].address,0x10002000n);
    assert.equal(image.metadata.exceptionDirectory.fragments[0].size,32n);
  }
  {
    const {bytes,view,image}=makeImage();
    view.setUint32(0x100,0x1000,true);view.setUint32(0x104,0x7000,true);
    parseExceptionFunctions(new ByteView(bytes),{rva:0x5000,size:8},image,0xaa64);
    assert.equal(image.functions.length,0);
    assert.equal(image.metadata.peMetadata.complete,false);
  }
  {
    const {bytes,view,image}=makeImage();
    view.setUint32(0x100,0x1000,true);view.setUint32(0x104,0x1080,true);view.setUint32(0x108,0x6000,true);
    view.setUint32(0x10c,0x2000,true);view.setUint32(0x110,0x2040,true);view.setUint32(0x114,0x6010,true);
    bytes[0x200]=1;bytes[0x201]=0;bytes[0x202]=0;bytes[0x203]=0;
    bytes[0x210]=1|(4<<3);bytes[0x211]=0;bytes[0x212]=0;bytes[0x213]=0;
    view.setUint32(0x214,0x1000,true);view.setUint32(0x218,0x1080,true);view.setUint32(0x21c,0x6000,true);
    parseExceptionFunctions(new ByteView(bytes),{rva:0x5000,size:24},image,0x8664);
    assert.ok(image.functions.every(f=>f.address===0x10001000n));
    assert.equal(image.functions.some(f=>f.address===0x10002000n),false);
    assert.equal(image.metadata.exceptionDirectory.fragments.some(f=>f.address===0x10002000n&&f.primaryAddress===0x10001000n),true);
  }
  {
    const {bytes,view,image}=makeImage();
    view.setUint32(0x100,0x2000,true);view.setUint32(0x104,0x2040,true);view.setUint32(0x108,0x6010,true);
    bytes[0x210]=1|(4<<3);bytes[0x212]=0;
    view.setUint32(0x214,0x2000,true);view.setUint32(0x218,0x2040,true);view.setUint32(0x21c,0x6010,true);
    parseExceptionFunctions(new ByteView(bytes),{rva:0x5000,size:12},image,0x8664);
    assert.equal(image.functions.length,0);
    assert.equal(image.metadata.peMetadata.complete,false);
  }
}
peUnwindFragmentRegressions();
issue86To97Regressions();
console.log('binary-platform: PASS');
