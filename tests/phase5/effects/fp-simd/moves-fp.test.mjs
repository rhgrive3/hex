import test from 'node:test';
import assert from 'node:assert/strict';
import { liftX86FloatingPointEffects } from '../../../../js/targets/architecture/x86_64/effects/fp.js';
import { effects, instruction, reg, mem, legacy, legacyPrefix, vex2, ops, physicalWrites, intrinsics } from './helpers.mjs';

test('MOVSS/MOVSD scalar lane rules and memory widths are exact', () => {
  const movss = effects('movss',[reg('xmm0','write'),reg('xmm1','read')],{prefixes:legacyPrefix(0xf3),instructionId:'p5-3:movss'});
  assert.equal(movss.completeness,'exact'); assert.equal(movss.metadata.scalarWidthBits,32); assert.equal(movss.metadata.xmmBitsAboveScalar,'preserved'); assert.equal(movss.metadata.upperLaneBehavior,'preserve-upper-128'); assert.equal(physicalWrites(movss,'ymm0').length,1);
  assert.ok(ops(movss,'value').some((op)=>op.opcode==='insert'&&op.metadata?.widthBits===32));
  const movsd = effects('movsd',[reg('xmm2','write'),reg('xmm3','read')],{prefixes:legacyPrefix(0xf2),instructionId:'p5-3:movsd'});
  assert.equal(movsd.completeness,'exact'); assert.equal(movsd.metadata.scalarWidthBits,64); assert.equal(movsd.metadata.xmmBitsAboveScalar,'preserved');
  const load = effects('movss',[reg('xmm0','write'),mem(32)],{prefixes:legacyPrefix(0xf3),instructionId:'p5-3:movss-load'});
  assert.equal(load.completeness,'exact'); assert.equal(ops(load,'memory-read')[0].access.widthBits,32); assert.equal(load.metadata.xmmBitsAboveScalar,'zero');
  const store = effects('movsd',[mem(64,{access:'write'}),reg('xmm1','read')],{prefixes:legacyPrefix(0xf2),instructionId:'p5-3:movsd-store'});
  assert.equal(store.completeness,'exact'); assert.equal(ops(store,'memory-write')[0].access.widthBits,64);
});

test('MOVSD string spelling is not stolen without vector evidence', () => {
  const candidate=instruction('movsd',[],{prefixes:legacy(),instructionId:'p5-3:string-movsd'});
  assert.equal(liftX86FloatingPointEffects(candidate,{instructionId:candidate.instructionId}),null);
});

test('full SSE/SSE2 moves preserve exact width and aligned-vs-unaligned faults', () => {
  for(const family of ['movaps','movups','movapd','movupd','movdqa','movdqu']){
    const regForm=effects(family,[reg('xmm0','write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:`p5-3:${family}:reg`});
    assert.equal(regForm.completeness,'exact',family); assert.equal(regForm.metadata.vectorWidthBits,128); assert.equal(regForm.metadata.upperLaneBehavior,'preserve-upper-128');
    const load=effects(family,[reg('xmm0','write'),mem(128)],{prefixes:legacy(),instructionId:`p5-3:${family}:load`});
    assert.equal(load.completeness,'exact',family); assert.equal(ops(load,'memory-read')[0].access.widthBits,128);
    const aligned=['movaps','movapd','movdqa'].includes(family); assert.equal(load.possibleFaults.some((fault)=>fault.kind==='alignment-fault'),aligned,family);
  }
});

test('MOVD/MOVQ scalar integer transfers preserve canonical vector identity', () => {
  const movd=effects('movd',[reg('xmm0','write'),reg('eax','read')],{prefixes:legacyPrefix(0x66),instructionId:'p5-3:movd'});
  assert.equal(movd.completeness,'exact'); assert.equal(movd.metadata.scalarWidthBits,32); assert.equal(physicalWrites(movd,'ymm0').length,1);
  const movq=effects('movq',[mem(64,{access:'write'}),reg('xmm0','read')],{prefixes:legacyPrefix(0x66),instructionId:'p5-3:movq'});
  assert.equal(movq.completeness,'exact'); assert.equal(ops(movq,'memory-write')[0].access.widthBits,64);
});

test('VEX.128 scalar move uses merge-source low lane and zeroes physical upper state', () => {
  const bundle=effects('vmovss',[reg('xmm0','write'),reg('xmm1','read'),reg('xmm2','read')],{prefixes:vex2(0xf2),instructionId:'p5-3:vmovss'});
  assert.equal(bundle.completeness,'exact'); assert.equal(bundle.metadata.xmmBitsAboveScalar,'from-vex-merge-source'); assert.equal(bundle.metadata.upperLaneBehavior,'zero-upper-128'); assert.equal(physicalWrites(bundle,'ymm0').length,1);
});

test('scalar arithmetic and sqrt consume and produce canonical MXCSR while lane preservation is explicit', () => {
  for(const family of ['addss','addsd','subss','subsd','mulss','mulsd','divss','divsd','sqrtss','sqrtsd']){
    const is64=family.endsWith('sd'); const bundle=effects(family,[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacyPrefix(is64?0xf2:0xf3),instructionId:`p5-3:${family}`});
    assert.equal(bundle.completeness,'exact-with-intrinsic',family); assert.equal(bundle.metadata.fpEnvironmentModeled,true,family); assert.equal(bundle.metadata.fpEnvironmentContract,'x86-mxcsr/v1',family); assert.equal(physicalWrites(bundle,'mxcsr').length,1,family); assert.equal(physicalWrites(bundle,'ymm0').length,1,family); assert.ok(ops(bundle,'value').some((op)=>op.opcode==='insert'&&op.metadata?.scalarLane===true),family);
  }
});

test('packed FP arithmetic uses canonical MXCSR exact-with-intrinsic semantics', () => {
  for(const family of ['addps','addpd','subps','subpd','mulps','mulpd','divps','divpd']){
    const bundle=effects(family,[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:`p5-3:${family}`});
    assert.equal(bundle.completeness,'exact-with-intrinsic',family); assert.equal(bundle.metadata.fpEnvironmentModeled,true,family); assert.equal(bundle.metadata.fpEnvironmentContract,'x86-mxcsr/v1',family); assert.equal(physicalWrites(bundle,'mxcsr').length,1,family); assert.equal(intrinsics(bundle,'x86.fp.packed-arithmetic').length,1);
  }
});

test('conversion families carry canonical MXCSR without assuming a default rounding mode', () => {
  const cases=[['cvtss2sd',[reg('xmm0','read-write'),reg('xmm1','read')]],['cvtsd2ss',[reg('xmm0','read-write'),reg('xmm1','read')]],['cvtsi2ss',[reg('xmm0','read-write'),reg('eax','read')]],['cvtsi2sd',[reg('xmm0','read-write'),reg('rax','read')]],['cvttss2si',[reg('eax','write'),reg('xmm1','read')]],['cvttsd2si',[reg('rax','write'),reg('xmm1','read')]]];
  for(const [family,operands] of cases){const bundle=effects(family,operands,{prefixes:legacy(),instructionId:`p5-3:${family}`}); assert.equal(bundle.completeness,'exact-with-intrinsic',family); assert.equal(bundle.metadata.fpEnvironmentContract,'x86-mxcsr/v1'); assert.equal(physicalWrites(bundle,'mxcsr').length,1);}
});

test('UCOMI/COMI comparisons encode unordered flag tuple and canonical MXCSR dependence', () => {
  for(const family of ['ucomiss','ucomisd','comiss','comisd']){
    const bundle=effects(family,[reg('xmm0','read'),reg('xmm1','read')],{prefixes:legacy(),instructionId:`p5-3:${family}`}); assert.equal(bundle.completeness,'exact-with-intrinsic',family); assert.equal(bundle.metadata.fpEnvironmentContract,'x86-mxcsr/v1'); assert.equal(physicalWrites(bundle,'mxcsr').length,1);
    const compare=intrinsics(bundle,'x86.fp.scalar-compare-flags')[0]; assert.deepEqual(compare.metadata.unordered,{ZF:1,PF:1,CF:1}); assert.equal(bundle.metadata.destinationWrite,false);
    assert.equal(ops(bundle,'flag-write').length,6);
  }
});

test('memory forms needing P5-2 address-size/TLS improvements remain explicit P5-I handoffs', () => {
  const addr32=effects('movss',[reg('xmm0','write'),mem(32,{addressSizeBits:32})],{prefixes:legacyPrefix(0xf3),instructionId:'p5-3:addr32'}); assert.equal(addr32.completeness,'partial'); assert.equal(addr32.metadata.classification,'P5-I-INTEGRATION-REQUIRED');
  const fs=effects('movss',[reg('xmm0','write'),mem(32,{segment:'fs'})],{prefixes:legacyPrefix(0xf3),instructionId:'p5-3:fs'}); assert.equal(fs.completeness,'partial'); assert.equal(fs.metadata.classification,'P5-I-INTEGRATION-REQUIRED');
});
