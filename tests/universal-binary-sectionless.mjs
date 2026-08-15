import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { openBinary, auditBinary, fingerprintImage } from '../js/binary/index.js';
import { makeElf64Fixture } from './universal-binary.mjs';

export function makeSectionlessElf64Fixture() {
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

function issue74To85Regressions() {
  const malformed = (mutate, pattern) => { const b=makeElf64Fixture(); mutate(new DataView(b.buffer),b); assert.throws(()=>openBinary(b),pattern); };
  malformed((v)=>v.setUint16(52,63,true),/e_ehsize/);
  const withPh=makeElf64Fixture(); const wpv=new DataView(withPh.buffer); wpv.setBigUint64(32,0x40n,true); wpv.setUint16(56,1,true); wpv.setUint16(54,55,true); assert.throws(()=>openBinary(withPh),/e_phentsize/);
  malformed((v)=>v.setUint16(58,63,true),/e_shentsize/);

  const xnum=makeElf64Fixture(), xv=new DataView(xnum.buffer); xv.setBigUint64(32,0x40n,true); xv.setUint16(56,0xffff,true); xv.setUint32(0x280+44,1,true); xv.setUint32(0x40,1,true); xv.setUint32(0x44,5,true); xv.setBigUint64(0x48,0n,true); xv.setBigUint64(0x50,0x400000n,true); xv.setBigUint64(0x60,BigInt(xnum.length),true); xv.setBigUint64(0x68,BigInt(xnum.length),true); xv.setBigUint64(0x70,0x1000n,true);
  const xnumImage=openBinary(xnum); assert.equal(xnumImage.metadata.extendedProgramHeaderCount,1); assert.ok(xnumImage.segments.length>=1);

  const shortSym=makeElf64Fixture(), ssv=new DataView(shortSym.buffer); ssv.setBigUint64(0x280+3*64+56,8n,true); const shortSymImage=openBinary(shortSym); assert.ok(shortSymImage.warnings.some(x=>x.includes('symbol table')&&x.includes('entry size')));
  const shortRel=makeElf64Fixture(), srv=new DataView(shortRel.buffer), relSec=0x280+4*64; srv.setUint32(relSec+4,4,true); srv.setBigUint64(relSec+56,8n,true); srv.setUint32(relSec+40,3,true); const shortRelImage=openBinary(shortRel); assert.ok(shortRelImage.warnings.some(x=>x.includes('relocation section')&&x.includes('entry size')));

  const xidx=makeElf64Fixture(), xiv=new DataView(xidx.buffer); xiv.setUint16(60,7,true); const xp=0x280+6*64; xiv.setUint32(xp+4,18,true); xiv.setBigUint64(xp+24,0x440n,true); xiv.setBigUint64(xp+32,12n,true); xiv.setUint32(xp+40,3,true); xiv.setBigUint64(xp+56,4n,true); xiv.setUint16(0x190+6,0xffff,true); xiv.setUint32(0x440+8,1,true); const xi=openBinary(xidx); assert.equal(xi.symbols.find(s=>s.name==='myfunc')?.sectionIndex,1);

  const merged=makeElf64Fixture(), mv=new DataView(merged.buffer); mv.setBigUint64(32,0x40n,true); mv.setUint16(56,1,true); mv.setUint32(0x40,2,true); mv.setUint32(0x44,6,true); mv.setBigUint64(0x48,0x1c0n,true); mv.setBigUint64(0x50,0x404000n,true); mv.setBigUint64(0x60,32n,true); mv.setBigUint64(0x68,32n,true); mv.setBigUint64(0x70,8n,true); mv.setUint16(60,7,true); const mp=0x280+6*64; mv.setUint32(mp+4,4,true); mv.setBigUint64(mp+32,0n,true); mv.setUint32(mp+40,3,true); mv.setBigUint64(mp+56,24n,true); const mergedImage=openBinary(merged); assert.ok(mergedImage.metadata.programDynamic);

  const eh=makeElf64Fixture(), ev=new DataView(eh.buffer); ev.setBigUint64(32,0x40n,true); ev.setUint16(56,1,true); ev.setUint32(0x40,0x6474e550,true); ev.setUint32(0x44,4,true); ev.setBigUint64(0x48,0x200n,true); ev.setBigUint64(0x50,0x405000n,true); ev.setBigUint64(0x60,16n,true); ev.setBigUint64(0x68,16n,true); ev.setBigUint64(0x70,4n,true); eh.set([1,0xff,3,3],0x200); ev.setUint32(0x204,1,true); ev.setUint32(0x208,0x401000,true); ev.setUint32(0x20c,0,true); const ehImage=openBinary(eh); assert.equal(ehImage.metadata.ehFrameHeader?.declaredFunctions,1); assert.ok(ehImage.functions.find(f=>f.address===0x401000n)?.sources?.includes('unwind'));

  const syment=makeSectionlessElf64Fixture(), syv=new DataView(syment.buffer); syv.setBigUint64(0x200+4*16+8,8n,true); const sy=openBinary(syment); assert.ok(sy.warnings.some(x=>x.includes('DT_SYMENT')));
  const relent=makeSectionlessElf64Fixture(), rv=new DataView(relent.buffer); rv.setBigUint64(0x200+8*16+8,8n,true); const ri=openBinary(relent); assert.ok(ri.warnings.some(x=>x.includes('entry size'))); assert.equal(ri.relocations.length,0);
  const plt=makeSectionlessElf64Fixture(), pv=new DataView(plt.buffer); pv.setBigUint64(64+56+32,0xd0n,true); pv.setBigUint64(64+56+40,0xd0n,true); const dyn=(i,tag,val)=>{const p=0x200+i*16;pv.setBigInt64(p,BigInt(tag),true);pv.setBigUint64(p+8,BigInt(val),true);}; dyn(9,23,0x4003a0); dyn(10,2,24); dyn(11,20,999); dyn(12,0,0); const pi=openBinary(plt); assert.ok(pi.warnings.some(x=>x.includes('DT_PLTREL'))); assert.equal(pi.metadata.programDynamicPartial,true);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
  issue74To85Regressions();
  console.log('universal-binary-sectionless: PASS');
}
