import test from 'node:test';
import assert from 'node:assert/strict';
import { effects, legacy, legacyPrefix, ops, intrinsics } from './helpers.mjs';

test('LFENCE/SFENCE/MFENCE remain distinct partial results when generic barrier semantics are insufficient', () => {
  for(const family of ['lfence','sfence','mfence']){
    const bundle=effects(family,[],{prefixes:legacy(),instructionId:`p5-3:${family}`});
    assert.equal(bundle.completeness,'partial'); assert.equal(bundle.unknownEffects.reason,'x86-fence-generic-barrier-contract-insufficient'); assert.equal(bundle.metadata.operation,family); assert.equal(bundle.metadata.fenceKindsCollapsed,false); assert.equal(ops(bundle,'barrier').length,0);
  }
});

test('PAUSE is proven architectural state-preserving', () => {
  const bundle=effects('pause',[],{prefixes:legacyPrefix(0xf3),rawBytes:[0xf3,0x90],instructionId:'p5-3:pause'});
  assert.equal(bundle.completeness,'exact'); assert.equal(bundle.operations.length,0); assert.equal(bundle.statePreservation.proven,true); assert.equal(bundle.metadata.microarchitecturalHintOnly,true);
});

test('CPUID outputs are environment dependent and not falsely deterministic', () => {
  const bundle=effects('cpuid',[],{prefixes:legacy(),instructionId:'p5-3:cpuid'}); assert.equal(bundle.completeness,'partial'); assert.match(bundle.unknownEffects.reason,/environment-and-serialization-unmodelled/);
  const intrinsic=intrinsics(bundle,'x86.system.cpuid')[0]; assert.equal(intrinsic.effectSummary.determinism,'nondeterministic'); assert.deepEqual(intrinsic.effectSummary.registersWritten,['rax','rbx','rcx','rdx']); assert.equal(ops(bundle,'register-write').length,4);
});

test('RDTSC/RDTSCP model nondeterministic output shape and preserve hidden runtime state as partial', () => {
  const rdtsc=effects('rdtsc',[],{prefixes:legacy(),instructionId:'p5-3:rdtsc'}),rdtscp=effects('rdtscp',[],{prefixes:legacy(),instructionId:'p5-3:rdtscp'});
  for(const bundle of [rdtsc,rdtscp]){assert.equal(bundle.completeness,'partial'); assert.equal(intrinsics(bundle)[0].effectSummary.determinism,'nondeterministic'); assert.ok(bundle.possibleFaults.some((fault)=>fault.kind==='general-protection'));}
  assert.equal(ops(rdtsc,'register-write').length,2); assert.equal(ops(rdtscp,'register-write').length,3);
});

test('SYSCALL is not ordinary CALL and SYSRET is not ordinary RET', () => {
  const syscall=effects('syscall',[],{prefixes:legacy(),rawBytes:[0x0f,0x05],address:0x500000n,instructionId:'p5-3:syscall'}); assert.equal(syscall.completeness,'partial'); assert.equal(syscall.controlEffect.kind,'unknown'); assert.equal(syscall.metadata.ordinaryCall,false); assert.equal(syscall.metadata.stackCallSemantics,false); assert.ok(ops(syscall,'register-write').some((op)=>op.register.registerId==='rcx')); assert.ok(ops(syscall,'register-write').some((op)=>op.register.registerId==='r11'));
  const sysret=effects('sysretq',[],{prefixes:legacy(),instructionId:'p5-3:sysret'}); assert.equal(sysret.completeness,'partial'); assert.equal(sysret.controlEffect.kind,'unknown'); assert.equal(sysret.metadata.ordinaryReturn,false);
});

test('CLI/STI/HLT never become NOPs', () => {
  for(const family of ['cli','sti','hlt']){const bundle=effects(family,[],{prefixes:legacy(),instructionId:`p5-3:${family}`}); assert.equal(bundle.completeness,'partial',family); assert.equal(bundle.metadata.treatedAsNop,false,family); assert.ok(bundle.possibleFaults.some((fault)=>fault.kind==='general-protection'),family);}
});

test('x87 state remains explicit partial where the decoded form does not require absent ST registers', () => {
  const bundle=effects('fldz',[],{prefixes:legacy(),instructionId:'p5-3:fldz'}); assert.equal(bundle.completeness,'partial'); assert.match(bundle.unknownEffects.reason,/x87-physical-and-environment-state-unmodelled/); assert.equal(bundle.metadata.x87StateInvented,false);
});
