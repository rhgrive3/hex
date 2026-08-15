import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import { parseBaseRelocations, parseTlsDirectory, parseLoadConfig } from '../js/binary/pe-loader.js';
import { BlobByteSource, ByteSource, asByteSource } from '../js/binary/source.js';
import { CachedByteSource, ByteSourceCancelledError, InstrumentedByteSource } from '../js/bytesource/cached.js';
import { boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed } from '../js/platform/worker-validation.js';

const BASE=0x140000000n;
function fixture(size=0x400){
  const bytes=new Uint8Array(size), view=new DataView(bytes.buffer);
  const mapped={address:BASE,size:BigInt(bytes.length),fileOffset:0n,fileSize:BigInt(bytes.length),perms:{read:true,write:true}};
  const exec={address:BASE+0x200n,size:0x100n,fileOffset:0x200n,fileSize:0x100n,perms:{read:true,execute:true}};
  const image={imageBase:BASE,bits:64,sections:[mapped,exec],segments:[mapped],functions:[],relocations:[],warnings:[],metadata:{},
    addressToOffset(address){const d=BigInt(address)-BASE; return d>=0n&&d<BigInt(bytes.length)?d:null;},
    sectionAt(address){const a=BigInt(address); return a>=exec.address&&a<exec.address+exec.size?exec:null;}};
  return {bytes,view,r:new ByteView(bytes,{littleEndian:true}),image};
}
// #101 odd/truncated relocation blocks cannot desynchronize the parser.
{
  const {view,r,image}=fixture(); view.setUint32(0x40,0x200,true); view.setUint32(0x44,9,true);
  parseBaseRelocations(r,{rva:0x40,size:9},image,0x8664);
  assert.equal(image.relocations.length,0); assert.ok(image.warnings.some((w)=>/Malformed PE base-relocation block/.test(w)));
}
// #102 reserved relocation types stay unsupported evidence, never real relocations.
{
  const {view,r,image}=fixture(); view.setUint32(0x40,0x200,true); view.setUint32(0x44,10,true); view.setUint16(0x48,0xf000,true);
  parseBaseRelocations(r,{rva:0x40,size:10},image,0x8664);
  assert.equal(image.relocations.length,0); assert.ok(image.warnings.some((w)=>/unsupported PE base relocation type 15/.test(w)));
}
// #103 PE32+ TLS callback VA table contributes only executable function seeds.
{
  const {view,r,image}=fixture(); view.setBigUint64(0x40+24,BASE+0x100n,true); view.setBigUint64(0x100,BASE+0x220n,true); view.setBigUint64(0x108,0n,true);
  parseTlsDirectory(r,{rva:0x40,size:40},image);
  assert.deepEqual(image.metadata.tls.callbacks,[BASE+0x220n]); assert.ok(image.functions.some((f)=>f.address===BASE+0x220n&&f.source==='tls-callback'));
}
// #104 Load Config GuardCF table seeds executable entries with provenance.
{
  const {view,r,image}=fixture(); view.setUint32(0x40,0x98,true); view.setBigUint64(0x40+128,BASE+0x100n,true); view.setBigUint64(0x40+136,1n,true); view.setUint32(0x40+144,0,true); view.setUint32(0x100,0x220,true);
  parseLoadConfig(r,{rva:0x40,size:0x98},image);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions,[BASE+0x220n]); assert.ok(image.functions.some((f)=>f.address===BASE+0x220n&&f.source==='guard-cf'));
}
// #105 range boundaries remain exact above 2^53; only bounded chunk lengths become Number.
{
  const huge=(1n<<53n)+123n;
  assert.equal(regionSize(huge),huge);
  assert.equal(boundedOffset(huge-1n,huge),huge-1n);
  assert.equal(chunkLength(huge,256*1024),256*1024);
  assert.equal(typeof exactExternalInteger(huge),'bigint');
  assert.throws(()=>regionSize(Number.MAX_SAFE_INTEGER+1),/unsafe Number/);
}
// #111 invalid chunk indexes are rejected before BigInt offset arithmetic.
assert.throws(()=>checkedChunkIndex(-1)); assert.throws(()=>checkedChunkIndex(1.5)); assert.equal(checkedChunkIndex(3),3);
// #106/#107 request ownership and transactional open are retained in worker code.
const worker=fs.readFileSync(new URL('../js/platform/worker.js',import.meta.url),'utf8');
assert.match(worker,/active\.has\(requestKey\)/); assert.match(worker,/candidateSource/); assert.match(worker,/regionBytes = regionSize\(region\.size\)/); assert.match(worker,/let pos = 0n/);
// #108 options on an existing ByteSource become a stricter wrapper.
{
 class S extends ByteSource{constructor(){super(16n,{maxReadLength:16})}async read(_o,n){return new Uint8Array(n)}}
 const base=new S(), wrapped=asByteSource(base,{maxReadLength:4}); assert.notEqual(wrapped,base); await wrapped.readExactly(0n,4); await assert.rejects(()=>wrapped.readExactly(0n,5));
}
// #109 options/signals propagate, mid-read cancellation is observed, and one cached consumer cannot cancel another.
{
 let seen=null; const delegate={size:8n,maxReadLength:8,async read(_o,n,opts){seen=opts;return new Uint8Array(n)}};
 const src=new InstrumentedByteSource(delegate), ac=new AbortController(); await src.read(0n,1,{signal:ac.signal}); assert.equal(seen.signal,ac.signal);

 let release; const delayed={size:8n,maxReadLength:8,async read(_o,n){return new Promise((resolve)=>{release=()=>resolve(new Uint8Array(n));});}};
 const wrapped=asByteSource(delayed), mid=new AbortController(); const pending=wrapped.readExactly(0n,1,{signal:mid.signal}); mid.abort(); release();
 await assert.rejects(pending,(e)=>e?.name==='AbortError');

 const blob=new BlobByteSource(new Blob([Uint8Array.of(1,2,3)])); const pre=new AbortController(); pre.abort();
 await assert.rejects(()=>blob.readExactly(0n,1,{signal:pre.signal}),(e)=>e?.name==='AbortError');

 let backendResolve, backendReads=0;
 const shared={size:16n,maxReadLength:16,async read(_o,n,opts){backendReads++; assert.equal(opts?.signal,undefined); return new Promise((resolve)=>{backendResolve=()=>resolve(new Uint8Array(n).fill(7));});}};
 const cached=new CachedByteSource(shared,{pageSize:16,maxCachedBytes:16}); const a=new AbortController(), b=new AbortController();
 const first=cached.read(0n,4,{signal:a.signal}), second=cached.read(0n,4,{signal:b.signal}); a.abort(); await assert.rejects(first,ByteSourceCancelledError); backendResolve();
 assert.deepEqual([...await second],[7,7,7,7]); assert.equal(backendReads,1);
}
// #110 scalar-valid UTF-8 only.
assert.equal(utf8Len(Uint8Array.from([0xe0,0x80,0x80]),0),0); assert.equal(utf8Len(Uint8Array.from([0xed,0xa0,0x80]),0),0); assert.equal(utf8Len(Uint8Array.from([0xf4,0x90,0x80,0x80]),0),0); assert.equal(utf8Len(Uint8Array.from([0xf0,0x9f,0x98,0x80]),0),4);
// #112 heuristic starts are not globally advertised as exact.
assert.equal(isExactFunctionSeed({source:'heuristic',confidence:1}),false); assert.equal(isExactFunctionSeed({source:'exception',confidence:.999}),true);
console.log('issues-101-112: ok');
