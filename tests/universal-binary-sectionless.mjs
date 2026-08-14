import assert from 'node:assert/strict';
import { openBinary, auditBinary, fingerprintImage } from '../js/binary/index.js';

function makeSectionlessElf64Fixture() {
  const b = new Uint8Array(0x500);
  const v = new DataView(b.buffer);
  const w16=(o,x)=>v.setUint16(o,x,true), w32=(o,x)=>v.setUint32(o,x,true), w64=(o,x)=>v.setBigUint64(o,BigInt(x),true), wi64=(o,x)=>v.setBigInt64(o,BigInt(x),true);
  b.set([0x7f,0x45,0x4c,0x46,2,1,1,0,0],0);
  w16(16,3); w16(18,62); w32(20,1); w64(24,0x400180n); w64(32,64n); w64(40,0n);
  w32(48,0); w16(52,64); w16(54,56); w16(56,2); w16(58,64); w16(60,0); w16(62,0);

  let p=64;
  w32(p,1); w32(p+4,7); w64(p+8,0n); w64(p+16,0x400000n); w64(p+24,0x400000n); w64(p+32,0x500n); w64(p+40,0x500n); w64(p+48,0x1000n);
  p+=56;
  w32(p,2); w32(p+4,6); w64(p+8,0x200n); w64(p+16,0x400200n); w64(p+24,0x400200n); w64(p+32,0xa0n); w64(p+40,0xa0n); w64(p+48,8n);

  b.fill(0x90,0x180,0x190); b[0x18f]=0xc3;
  const dynstr=new TextEncoder().encode('\0puts\0libc.so.6\0'); b.set(dynstr,0x300);
  const dyn=(index,tag,value)=>{const q=0x200+index*16;wi64(q,tag);w64(q+8,value)};
  dyn(0,1n,6n); dyn(1,5n,0x400300n); dyn(2,10n,BigInt(dynstr.length)); dyn(3,6n,0x400340n); dyn(4,11n,24n);
  dyn(5,4n,0x400380n); dyn(6,7n,0x4003a0n); dyn(7,8n,24n); dyn(8,9n,24n); dyn(9,0n,0n);

  w32(0x358,1); b[0x35c]=0x12; b[0x35d]=0; w16(0x35e,0); w64(0x360,0n); w64(0x368,0n);
  w32(0x380,1); w32(0x384,2); w32(0x388,1); w32(0x38c,0); w32(0x390,0);
  w64(0x3a0,0x400420n); w64(0x3a8,(1n<<32n)|7n); wi64(0x3b0,0n);
  return b;
}

const image=openBinary(makeSectionlessElf64Fixture());
assert.equal(image.format,'elf');
assert.equal(image.sections.length,0);
assert.equal(image.entrypoint,0x400180n);
assert.ok(image.libraries.includes('libc.so.6'));
const imp=image.imports.find((x)=>x.name==='puts');
assert.ok(imp);
assert.equal(imp.source,'PT_DYNAMIC');
assert.equal(imp.sites?.[0]?.address,0x400420n);
assert.equal(image.relocations.length,1);
assert.equal(image.metadata.programDynamic?.sectionless,true);
assert.equal(image.metadata.programDynamic?.symbols,2);
assert.equal(auditBinary(image).errors,0);
assert.ok(fingerprintImage(image).bytes>0);
console.log('universal-binary-sectionless: PASS');
