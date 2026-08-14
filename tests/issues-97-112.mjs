import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';
import { ByteSource, asByteSource } from '../js/binary/source.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { checkedChunkIndex, safeRegionLength, utf8Len, isExactFunctionSeed } from '../js/platform/worker-validation.js';

function minimalPE({entry=0,sectionName='.text',longName=null}={}){
  const bytes=new Uint8Array(0x600); const v=new DataView(bytes.buffer); const le=true;
  const u16=(o,x)=>v.setUint16(o,x,le),u32=(o,x)=>v.setUint32(o,x,le),u64=(o,x)=>v.setBigUint64(o,BigInt(x),le);
  u16(0,0x5a4d);u32(0x3c,0x80);u32(0x80,0x4550); const c=0x84;
  u16(c,0x8664);u16(c+2,1);u16(c+16,0xf0);u16(c+18,0x22); const opt=c+20;
  u16(opt,0x20b);u32(opt+16,entry);u64(opt+24,0x140000000n);u32(opt+32,0x1000);u32(opt+36,0x200);u32(opt+56,0x2000);u32(opt+60,0x200);u16(opt+68,3);u32(opt+108,16);
  const s=opt+0xf0; const enc=new TextEncoder();
  let symbolPtr=0;
  if(longName){symbolPtr=0x500;u32(c+8,symbolPtr);u32(c+12,0);bytes.set(enc.encode('/4'),s);const b=enc.encode(longName+'\0');u32(symbolPtr,4+b.length);bytes.set(b,symbolPtr+4);}
  else bytes.set(enc.encode(sectionName),s);
  u32(s+8,0x100);u32(s+12,0x1000);u32(s+16,0x200);u32(s+20,0x200);u32(s+36,0x60000020);
  return bytes;
}
{
  const image=parsePE(minimalPE({entry:0}));
  assert.equal(image.entrypoint,null);
  assert.equal(image.functions.some((f)=>f.source==='entrypoint'),false);
}
{
  const image=parsePE(minimalPE({longName:'very_long_text_section'}));
  assert.equal(image.sections[0].name,'very_long_text_section');
}
// #108: maxReadLength options must be honored even for an existing ByteSource.
{
  class S extends ByteSource{constructor(){super(16n,{maxReadLength:16})}async read(_o,n){return new Uint8Array(n)}}
  const base=new S(), wrapped=asByteSource(base,{maxReadLength:4});
  assert.notEqual(wrapped,base); await wrapped.readExactly(0n,4); await assert.rejects(()=>wrapped.readExactly(0n,5));
}
// #109: InstrumentedByteSource forwards AbortSignal/options to its delegate.
{
  let seen=null;
  const delegate={size:8n,maxReadLength:8,async read(_o,n,opts){seen=opts;return new Uint8Array(n)}};
  const src=new InstrumentedByteSource(delegate); const ac=new AbortController();
  await src.read(0n,1,{signal:ac.signal}); assert.equal(seen.signal,ac.signal);
}
// #110 strict UTF-8 validity.
assert.equal(utf8Len(Uint8Array.from([0xe0,0x80,0x80]),0),0); // overlong
assert.equal(utf8Len(Uint8Array.from([0xed,0xa0,0x80]),0),0); // surrogate
assert.equal(utf8Len(Uint8Array.from([0xf4,0x90,0x80,0x80]),0),0); // > U+10FFFF
assert.equal(utf8Len(Uint8Array.from([0xf0,0x9f,0x98,0x80]),0),4);
// #105/#111 no lossy sizes or negative/fractional chunks.
assert.throws(()=>safeRegionLength(9007199254740992n));
assert.throws(()=>checkedChunkIndex(-1)); assert.throws(()=>checkedChunkIndex(1.5)); assert.equal(checkedChunkIndex(3),3);
// #112 heuristic starts are never globally labelled exact.
assert.equal(isExactFunctionSeed({source:'heuristic',confidence:1}),false);
assert.equal(isExactFunctionSeed({source:'exception',confidence:.999}),true);
console.log('issues-97-112: ok');
