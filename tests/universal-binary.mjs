import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ByteView, detectBinary, openBinary, auditBinary,
  fingerprintFunction, fingerprintImage,
} from '../js/binary/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function testReader() {
  const r = new ByteView(Uint8Array.from([0xe5, 0x8e, 0x26, 0x7f, 0, 1, 2, 3]));
  assert.equal(r.uleb(0).value, 624485n);
  assert.equal(r.u32(4), 0x03020100);
  assert.throws(() => r.u64(4), /outside file/);
}

function testDetection() {
  assert.equal(detectBinary(Uint8Array.from([0x7f,0x45,0x4c,0x46])).format, 'elf');
  assert.equal(detectBinary(Uint8Array.from([0x4d,0x5a,0,0])).format, 'pe');
  assert.equal(detectBinary(Uint8Array.from([0xcf,0xfa,0xed,0xfe])).format, 'macho');
  assert.equal(detectBinary(Uint8Array.from([1,2,3,4])).format, 'unknown');
}

function makeElf64Fixture() {
  const b = new Uint8Array(0x480);
  const v = new DataView(b.buffer);
  const w16=(o,x)=>v.setUint16(o,x,true), w32=(o,x)=>v.setUint32(o,x,true), w64=(o,x)=>v.setBigUint64(o,BigInt(x),true);
  b.set([0x7f,0x45,0x4c,0x46,2,1,1,0,0],0);
  w16(16,3); w16(18,62); w32(20,1); w64(24,0x401000n); w64(32,0n); w64(40,0x280n);
  w32(48,0); w16(52,64); w16(54,56); w16(56,0); w16(58,64); w16(60,6); w16(62,5);

  b.fill(0x90,0x100,0x110); b[0x10f]=0xc3;
  const dynstr = new TextEncoder().encode('\0puts\0myfunc\0libc.so.6\0'); b.set(dynstr,0x120);
  const sym=(p,name,info,shndx,value,size)=>{w32(p,name); b[p+4]=info; b[p+5]=0; w16(p+6,shndx); w64(p+8,value); w64(p+16,size)};
  sym(0x160,0,0,0,0,0); sym(0x178,1,0x12,0,0,0); sym(0x190,6,0x12,1,0x401000n,0x10n);
  v.setBigInt64(0x1c0,1n,true); w64(0x1c8,13n); v.setBigInt64(0x1d0,0n,true); w64(0x1d8,0n);
  const shstr = new TextEncoder().encode('\0.text\0.dynstr\0.dynsym\0.dynamic\0.shstrtab\0'); b.set(shstr,0x220);
  const nameOff={text:1,dynstr:7,dynsym:15,dynamic:23,shstr:32};
  const sh=(i,name,type,flags,addr,off,size,link=0,info=0,align=1,entsize=0)=>{const p=0x280+i*64;w32(p,name);w32(p+4,type);w64(p+8,flags);w64(p+16,addr);w64(p+24,off);w64(p+32,size);w32(p+40,link);w32(p+44,info);w64(p+48,align);w64(p+56,entsize)};
  sh(0,0,0,0n,0n,0n,0n); sh(1,nameOff.text,1,0x6n,0x401000n,0x100n,0x10n,0,0,16,0);
  sh(2,nameOff.dynstr,3,0x2n,0x402000n,0x120n,BigInt(dynstr.length),0,0,1,0);
  sh(3,nameOff.dynsym,11,0x2n,0x403000n,0x160n,72n,2,1,8,24);
  sh(4,nameOff.dynamic,6,0x3n,0x404000n,0x1c0n,32n,2,0,8,16);
  sh(5,nameOff.shstr,3,0n,0n,0x220n,BigInt(shstr.length),0,0,1,0);
  return b;
}

function makePe64Fixture() {
  const b = new Uint8Array(0x800);
  const v = new DataView(b.buffer);
  const w16=(o,x)=>v.setUint16(o,x,true), w32=(o,x)=>v.setUint32(o,x,true), w64=(o,x)=>v.setBigUint64(o,BigInt(x),true);
  w16(0,0x5a4d); w32(0x3c,0x80); w32(0x80,0x00004550);
  const coff=0x84; w16(coff,0x8664); w16(coff+2,3); w32(coff+4,0x12345678); w16(coff+16,0xf0); w16(coff+18,0x22);
  const opt=coff+20; w16(opt,0x20b); b[opt+2]=14; w32(opt+16,0x1000); w32(opt+20,0x1000); w64(opt+24,0x140000000n);
  w32(opt+32,0x1000); w32(opt+36,0x200); w32(opt+56,0x4000); w32(opt+60,0x200); w16(opt+68,3); w32(opt+108,16);
  const dirs=opt+112; w32(dirs+1*8,0x2000); w32(dirs+1*8+4,0x100); w32(dirs+3*8,0x3000); w32(dirs+3*8+4,12);
  const sec=opt+0xf0;
  const section=(i,name,vsize,rva,rawSize,raw,flags)=>{const p=sec+i*40; b.set(new TextEncoder().encode(name),p); w32(p+8,vsize); w32(p+12,rva); w32(p+16,rawSize); w32(p+20,raw); w32(p+36,flags)};
  section(0,'.text',0x100,0x1000,0x200,0x200,0x60000020);
  section(1,'.idata',0x200,0x2000,0x200,0x400,0xc0000040);
  section(2,'.pdata',0x100,0x3000,0x200,0x600,0x40000040);
  b.fill(0x90,0x200,0x210); b[0x20f]=0xc3;
  w32(0x400,0x2040); w32(0x40c,0x2080); w32(0x410,0x2060);
  w64(0x440,0x2090n); w64(0x448,0n);
  b.set(new TextEncoder().encode('KERNEL32.dll\0'),0x480);
  w16(0x490,0); b.set(new TextEncoder().encode('ExitProcess\0'),0x492);
  w32(0x600,0x1000); w32(0x604,0x1010); w32(0x608,0x3020);
  return b;
}

function testElf() {
  const image = openBinary(makeElf64Fixture());
  assert.equal(image.format,'elf'); assert.equal(image.arch,'x86_64'); assert.equal(image.bits,64);
  assert.equal(image.imports.find((x)=>x.name==='puts')?.source,'elf-dynsym');
  assert.equal(image.exports.find((x)=>x.name==='myfunc')?.address,0x401000n);
  assert.ok(image.functions.some((x)=>x.address===0x401000n));
  assert.ok(image.libraries.includes('libc.so.6'));
  assert.equal(image.addressToOffset(0x401000n),0x100n);
  const audit=auditBinary(image); assert.equal(audit.ok,true,JSON.stringify(audit.issues));
}

function testPe() {
  const image = openBinary(makePe64Fixture());
  assert.equal(image.format,'pe'); assert.equal(image.arch,'x86_64'); assert.equal(image.bits,64);
  assert.equal(image.imports.length,1); assert.equal(image.imports[0].name,'ExitProcess'); assert.equal(image.imports[0].library,'KERNEL32.dll');
  assert.equal(image.imports[0].sites[0].address,0x140002060n);
  const fn=image.functions.find((x)=>x.address===0x140001000n); assert.ok(fn); assert.equal(fn.size,0x10n); assert.equal(fn.source,'exception');
  assert.equal(image.addressToOffset(0x140001000n),0x200n);
  const fp=fingerprintFunction(image,fn); assert.equal(fp.bytes,16); assert.match(fp.hash,/^[0-9a-f]{16}$/);
  const audit=auditBinary(image); assert.equal(audit.ok,true,JSON.stringify(audit.issues));
}

function testRealMachO() {
  const candidates = [
    { name:'battlecats', minImports:2500, minFunctions:100000 },
    { name:'TsumTsum', minImports:3000, minFunctions:150000 },
    { name:'YWP', minImports:2500, minFunctions:250000 },
  ];
  for (const c of candidates) {
    const file=path.join(__dirname,c.name);
    if (!fs.existsSync(file)) continue;
    const image=openBinary(new Uint8Array(fs.readFileSync(file)));
    assert.equal(image.format,'macho',c.name); assert.equal(image.arch,'arm64',c.name); assert.equal(image.bits,64,c.name);
    assert.ok(image.sections.length>40,`${c.name}: sections`); assert.ok(image.imports.length>=c.minImports,`${c.name}: imports=${image.imports.length}`);
    assert.ok(image.functions.length>=c.minFunctions,`${c.name}: functions=${image.functions.length}`);
    assert.ok((image.metadata.chainedFixups?.bindingSites||0)>10000,`${c.name}: chained binding sites`);
    const withSites=image.imports.filter((x)=>x.sites?.length).length;
    assert.ok(withSites/image.imports.length>0.90,`${c.name}: import-site coverage ${withSites}/${image.imports.length}`);
    const audit=auditBinary(image); assert.equal(audit.errors,0,`${c.name}: ${JSON.stringify(audit.issues.slice(0,5))}`);
    const fp=fingerprintImage(image); assert.ok(fp.bytes>1_000_000,`${c.name}: executable fingerprint bytes`);
  }
}

testReader(); testDetection(); testElf(); testPe(); testRealMachO();
console.log('universal-binary: PASS');
