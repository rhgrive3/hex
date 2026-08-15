import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import {
  mappedFileRangeForRva, mappedFileSpanForRva, createPEMetadataBudget,
  parseExports, parseCoffSymbols,
} from '../js/binary/pe-loader.js';

function imageWithSections(sections) {
  return {
    imageBase: 0x10000000n, bits:64, sections, segments:[...sections],
    metadata:{}, warnings:[], symbols:[], functions:[], imports:[], exports:[], relocations:[], libraries:[],
    sectionAt(address) {
      const a=BigInt(address); return sections.find((s)=>a>=s.address&&a<s.address+s.size)||null;
    },
    addressToOffset(address) {
      const a=BigInt(address);
      for(const s of sections){if(a>=s.address&&a<s.address+s.fileSize)return s.fileOffset+(a-s.address);}
      return null;
    },
  };
}

// #536: raw adjacency is not RVA continuity. A span that starts in .rdata and
// continues into raw bytes belonging to a different RVA owner must fail.
{
  const a={index:1,address:0x10001000n,size:0x40n,fileOffset:0x100n,fileSize:0x40n,perms:{read:true,execute:false}};
  const b={index:2,address:0x10003000n,size:0x40n,fileOffset:0x140n,fileSize:0x40n,perms:{read:true,execute:false}};
  const image=imageWithSections([a,b]);
  assert.equal(mappedFileRangeForRva(image,0x1010)?.start,0x110);
  assert.equal(mappedFileSpanForRva(image,0x1010,0x20)?.spanEnd,0x130);
  assert.equal(mappedFileSpanForRva(image,0x1020,0x30),null,'raw-adjacent second section is not the same RVA mapping');
}

// Export function-array count cannot read through a mapping boundary into raw
// adjacent bytes and manufacture high-confidence export/function seeds.
{
  const bytes=new Uint8Array(0x200);const dv=new DataView(bytes.buffer);
  const a={index:1,address:0x10001000n,size:0x40n,fileOffset:0x100n,fileSize:0x40n,perms:{read:true,execute:true}};
  const b={index:2,address:0x10003000n,size:0x40n,fileOffset:0x140n,fileSize:0x40n,perms:{read:true,execute:true}};
  const image=imageWithSections([a,b]);
  const h=0x100;dv.setUint32(h+12,0x1038,true);dv.setUint32(h+16,1,true);dv.setUint32(h+20,16,true);dv.setUint32(h+24,0,true);dv.setUint32(h+28,0x1020,true);
  bytes[0x138]=0x78;bytes[0x139]=0;
  parseExports(new ByteView(bytes),{rva:0x1000,size:0x40},image);
  assert.equal(image.exports.length,0);assert.equal(image.functions.length,0);
  assert.equal(image.metadata.peMetadata.complete,false);
  assert.ok(image.metadata.peMetadata.reasons.includes('exports:function-array-span'));
}

// #535: valid export metadata is bounded by parser-wide record/object budgets,
// not a device-hostile fixed 10,000,000-entry allowance.
{
  const bytes=new Uint8Array(0x1400);const dv=new DataView(bytes.buffer);
  const sec={index:1,address:0x10001000n,size:0x1000n,fileOffset:0x100n,fileSize:0x1000n,perms:{read:true,execute:true}};
  const image=imageWithSections([sec]);const h=0x100;
  dv.setUint32(h+12,0x1060,true);dv.setUint32(h+16,1,true);dv.setUint32(h+20,10,true);dv.setUint32(h+24,0,true);dv.setUint32(h+28,0x1080,true);bytes[0x160]=0x78;bytes[0x161]=0;
  for(let i=0;i<10;i++)dv.setUint32(0x180+i*4,0x1200+i*4,true);
  const budget=createPEMetadataBudget(image,{limits:{records:3,objects:100,stringBytes:4096,inputBytes:1<<20,operations:1000,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  parseExports(new ByteView(bytes),{rva:0x1000,size:0x40},image,budget);
  assert.equal(image.exports.length,3);assert.equal(image.functions.length,3);
  assert.equal(image.metadata.peMetadata.complete,false);
  assert.ok(image.metadata.peMetadata.reasons.some((x)=>x.includes('export-function-record:records')));
}

// COFF uses the same budget contract and stops object amplification safely.
{
  const bytes=new Uint8Array(0x400);const dv=new DataView(bytes.buffer);const ptr=0x100,count=10,strBase=ptr+count*18;
  const sec={index:1,address:0x10001000n,size:0x1000n,fileOffset:0n,fileSize:0x400n,perms:{read:true,execute:true}};const image=imageWithSections([sec]);
  for(let i=0;i<count;i++){const p=ptr+i*18;bytes[p]=0x66;bytes[p+1]=0x30+(i%10);dv.setUint32(p+8,i*4,true);dv.setInt16(p+12,1,true);dv.setUint16(p+14,0x20,true);dv.setUint8(p+16,2);dv.setUint8(p+17,0);}dv.setUint32(strBase,4,true);
  const budget=createPEMetadataBudget(image,{limits:{records:3,objects:100,stringBytes:4096,inputBytes:1<<20,operations:1000,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  parseCoffSymbols(new ByteView(bytes),ptr,count,image,budget);
  assert.equal(image.symbols.length,3);assert.equal(image.functions.length,3);assert.equal(image.metadata.peMetadata.complete,false);
}

// A 10M COFF count over a tiny backing file is rejected before materialization.
{
  const bytes=new Uint8Array(0x200),image=imageWithSections([]);
  parseCoffSymbols(new ByteView(bytes),0x100,10_000_000,image);
  assert.equal(image.symbols.length,0);assert.equal(image.metadata.peMetadata.complete,false);
  assert.ok(image.metadata.peMetadata.reasons.includes('coff:symbol-table-span'));
}

const src=fs.readFileSync(new URL('../js/binary/pe-loader.js',import.meta.url),'utf8');
for(const marker of [
  'parseDelayImports','parseTlsDirectory','parseLoadConfig','parseExceptionFunctions','parseBaseRelocations',
]) assert.ok(src.includes(marker));
assert.match(src,/mappedFileSpanForRva\(image,dir\.rva,dir\.size\)/);
assert.match(src,/mappedFileRangeForAddress\(image,callbacksVa\)/);
assert.match(src,/mappedFileRangeForAddress\(image,tableVa\)/);
const pe=fs.readFileSync(new URL('../js/binary/pe.js',import.meta.url),'utf8');
assert.match(pe,/const metadataBudget = createPEMetadataBudget/);
for(const call of ['parseCoffSymbols','parseImports','parseExports','parseExceptionFunctions','parseBaseRelocations','parseDelayImports','parseTlsDirectory','parseLoadConfig']){
  assert.match(pe,new RegExp(`${call}\\([^;]*metadataBudget\\)`),`${call} must consume the shared parser budget`);
}

console.log('issues #535/#536 PE budget + mapped-span regressions: PASS');
