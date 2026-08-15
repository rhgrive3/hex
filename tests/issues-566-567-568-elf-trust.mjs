import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseELF } from '../js/binary/elf.js';
import { mappedELFFileRangeForVa, mappedELFFileSpanForVa } from '../js/binary/elf-mapping.js';
import { makeElf64Fixture } from './universal-binary.mjs';
import { makeSectionlessElf64Fixture } from './universal-binary-sectionless.mjs';

function makeRelocatableElf64() {
  const b=new Uint8Array(0x700),v=new DataView(b.buffer);
  const w16=(o,x)=>v.setUint16(o,x,true),w32=(o,x)=>v.setUint32(o,x,true),w64=(o,x)=>v.setBigUint64(o,BigInt(x),true),wi64=(o,x)=>v.setBigInt64(o,BigInt(x),true);
  b.set([0x7f,0x45,0x4c,0x46,2,1,1,0,0],0);
  w16(16,1);w16(18,62);w32(20,1);w64(24,0);w64(32,0);w64(40,0x400);w32(48,0);w16(52,64);w16(54,56);w16(56,0);w16(58,64);w16(60,6);w16(62,5);
  b.fill(0x90,0x100,0x180);
  const str=new TextEncoder().encode('\0func\0ext\0');b.set(str,0x180);
  const sym=(p,name,info,shndx,value,size)=>{w32(p,name);b[p+4]=info;b[p+5]=0;w16(p+6,shndx);w64(p+8,value);w64(p+16,size);};
  sym(0x200,0,0,0,0,0);sym(0x218,1,0x12,1,0x40n,0x10n);sym(0x230,6,0x12,0,0,0);
  w64(0x260,0x24n);w64(0x268,(2n<<32n)|1n);wi64(0x270,0n);
  const shstr=new TextEncoder().encode('\0.text\0.strtab\0.symtab\0.rela.text\0.shstrtab\0');b.set(shstr,0x300);
  const no={text:1,str:7,sym:15,rela:23,shstr:34};
  const sh=(i,name,type,flags,addr,off,size,link=0,info=0,align=1,entsize=0)=>{const p=0x400+i*64;w32(p,name);w32(p+4,type);w64(p+8,flags);w64(p+16,addr);w64(p+24,off);w64(p+32,size);w32(p+40,link);w32(p+44,info);w64(p+48,align);w64(p+56,entsize);};
  sh(0,0,0,0,0,0,0);sh(1,no.text,1,0x6,0,0x100,0x80,0,0,16,0);sh(2,no.str,3,0,0,0x180,str.length,0,0,1,0);sh(3,no.sym,2,0,0,0x200,72,2,1,8,24);sh(4,no.rela,4,0,0,0x260,24,3,1,8,24);sh(5,no.shstr,3,0,0,0x300,shstr.length,0,0,1,0);
  return b;
}

// #566: ET_REL symbol and relocation addresses are section-relative identities,
// represented by a deterministic non-overlapping synthetic layout.
{
  const image=parseELF(makeRelocatableElf64());
  assert.equal(image.metadata.type,1);
  assert.equal(image.metadata.relocatableAddressModel?.kind,'synthetic-section-layout');
  const text=image.sections.find((s)=>s.name==='.text');assert.ok(text);assert.notEqual(text.address,0n);
  const fn=image.symbols.find((s)=>s.name==='func');assert.ok(fn);
  assert.equal(fn.originalValue,0x40n);assert.equal(fn.address,text.address+0x40n);
  assert.deepEqual(fn.sectionRelative,{sectionIndex:1,offset:0x40n});
  assert.ok(image.functions.some((f)=>f.address===text.address+0x40n&&f.exactFunctionStart));
  const rel=image.relocations[0];assert.equal(rel.address,text.address+0x24n);assert.equal(rel.fileOffset,0x124n);
  assert.deepEqual(rel.sectionRelative,{sectionIndex:1,offset:0x24n});
  const ext=image.imports.find((x)=>x.name==='ext');assert.equal(ext?.sites?.[0]?.address,text.address+0x24n);
  assert.ok(!image.functions.some((f)=>f.address===0x40n),'raw ET_REL st_value must never become a virtual function address');
}

// STT_FUNC is exact only with canonical executable start+extent provenance.
{
  const nonExec=makeElf64Fixture(),v=new DataView(nonExec.buffer);v.setBigUint64(24,0n,true);v.setBigUint64(0x280+64+8,0x2n,true);
  const image=parseELF(nonExec);assert.ok(!image.functions.some((f)=>f.address===0x401000n&&f.sources?.includes('symbol')));
  const oversized=makeElf64Fixture(),ov=new DataView(oversized.buffer);ov.setBigUint64(24,0n,true);ov.setBigUint64(0x190+16,0x1000n,true);
  const over=parseELF(oversized);assert.ok(!over.functions.some((f)=>f.address===0x401000n&&f.source==='symbol'));
}

// #567: section metadata shares one device-safe output/work budget.
{
  const image=parseELF(makeElf64Fixture(),{metadataLimits:{records:1,objects:32,stringBytes:4096,inputBytes:1<<20,operations:100,estimatedHeapBytes:1<<20,wallClockMs:5000}});
  assert.equal(image.metadata.elfMetadata.complete,false);
  assert.ok(image.metadata.elfMetadata.reasons.some((r)=>r.startsWith('budget:')));
  assert.ok(image.symbols.length<=1);
}

// #568: raw file adjacency is not a valid continuation of one PT_LOAD VA span.
{
  const image={segments:[
    {address:0x400000n,size:0x1000n,fileOffset:0n,fileSize:0x100n},
    {address:0x402000n,size:0x1000n,fileOffset:0x100n,fileSize:0x100n},
  ]};
  assert.equal(mappedELFFileRangeForVa(image,0x400080n)?.start,0x80);
  assert.equal(mappedELFFileSpanForVa(image,0x400080n,0x70)?.spanEnd,0xf0);
  assert.equal(mappedELFFileSpanForVa(image,0x400080n,0x90),null,'raw-adjacent second segment is not a continuation of the first VA mapping');
}

// DT_STRTAB may not read raw bytes beyond its owning PT_LOAD even when present
// in the backing file.
{
  const b=makeSectionlessElf64Fixture(),v=new DataView(b.buffer);
  v.setBigUint64(64+32,0x308n,true); // first PT_LOAD fileSize: strtab at 0x300 is truncated by mapping
  const image=parseELF(b);
  assert.equal(image.metadata.programDynamicPartial,true);
  assert.ok(image.warnings.some((x)=>x.includes('DT_STRTAB/DT_STRSZ')&&x.includes('PT_LOAD')));
  assert.ok(!image.libraries.includes('libc.so.6'));
}

// Guard that all dynamic table families route through mapped-span helpers.
{
  const dynamic=fs.readFileSync(new URL('../js/binary/elf-dynamic.js',import.meta.url),'utf8');
  assert.match(dynamic,/mappedELFFileSpanForVa\(image, strtab, strSize\)/);
  assert.match(dynamic,/mappedELFFileSpanForVa\(image, va, n\)/);
  assert.match(dynamic,/mappedELFFileRangeForVa\(image,hashVa\)/);
  const extended=fs.readFileSync(new URL('../js/binary/elf-extended.js',import.meta.url),'utf8');
  assert.match(extended,/mappedELFFileSpanForVa\(image,versym,count\*2\)/);
  assert.match(extended,/mappedELFFileRangeForVa\(image,verdef\)/);
  assert.match(extended,/mappedELFFileRangeForVa\(image,verneed\)/);
  const elf=fs.readFileSync(new URL('../js/binary/elf.js',import.meta.url),'utf8');
  assert.match(elf,/parseEhFrameHeader\(r, ehFrameHdr, image, bits, metadataBudget\)/);
  assert.doesNotMatch(elf,/count > 10000000/);
}

console.log('issues #566/#567/#568 ELF trust-boundary regressions: PASS');
