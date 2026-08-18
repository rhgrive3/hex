import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeMachineEffectBundle } from '../../../../js/semantics/effects/index.js';
import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';
import { instruction, reg, legacy, vex2, evex, ops, physicalReads, physicalWrites } from './helpers.mjs';

function lift(input) { return liftX86MachineEffects(input, { instructionId:input.instructionId }); }

test('XMM is a lower YMM view and legacy writes preserve upper physical state', () => {
  const bundle = lift(instruction('pxor', [reg('xmm0','read-write'),reg('xmm1','read')], { prefixes:legacy(), instructionId:'p5-3:legacy-pxor' }));
  assert.equal(bundle.completeness, 'exact');
  assert.equal(physicalWrites(bundle,'ymm0').length, 1);
  assert.equal(physicalWrites(bundle,'xmm0').length, 0);
  assert.ok(physicalReads(bundle,'ymm0').length >= 2);
  assert.ok(ops(bundle,'value').some((operation) => operation.opcode === 'insert' && operation.metadata?.writePolicy === 'legacy-preserve-upper-128'));
  assert.equal(bundle.metadata.upperLaneBehavior, 'preserve-upper-128');
});

test('VEX.128 zeroes YMM upper 128 and VEX.256 replaces the full YMM', () => {
  const v128 = lift(instruction('vxorps', [reg('xmm0','write'),reg('xmm1','read'),reg('xmm2','read')], { prefixes:vex2(0xf0), instructionId:'p5-3:vex128-xor' }));
  assert.equal(v128.completeness, 'exact');
  assert.equal(v128.metadata.vectorWidthBits, 128);
  assert.equal(v128.metadata.upperLaneBehavior, 'zero-upper-128');
  assert.equal(physicalWrites(v128,'ymm0').length, 1);
  assert.ok(ops(v128,'value').some((operation) => operation.opcode === 'zext' && operation.metadata?.fromBits === 128 && operation.metadata?.toBits === 256));

  const v256 = lift(instruction('vxorps', [reg('ymm0','write'),reg('ymm1','read'),reg('ymm2','read')], { prefixes:vex2(0xf4), instructionId:'p5-3:vex256-xor' }));
  assert.equal(v256.completeness, 'exact');
  assert.equal(v256.metadata.vectorWidthBits, 256);
  assert.equal(v256.metadata.upperLaneBehavior, 'replace-ymm');
  assert.equal(physicalWrites(v256,'ymm0')[0].value.valueType.widthBits, 256);
});

test('unsupported vector state and malformed encoding fail closed', () => {
  assert.throws(() => lift(instruction('pxor', [reg('xmm16'),reg('xmm0')], { instructionId:'p5-3:xmm16' })), /x86-decoded-instruction-unknown-register/);
  assert.throws(() => lift(instruction('vxorps', [reg('zmm0'),reg('zmm1'),reg('zmm2')], { prefixes:evex(), instructionId:'p5-3:zmm' })), /x86-decoded-instruction-unknown-register/);
  const evexLow = lift(instruction('vxorps', [reg('xmm0'),reg('xmm1'),reg('xmm2')], { prefixes:evex(), instructionId:'p5-3:evex-low' }));
  assert.equal(evexLow.completeness, 'partial');
  assert.match(evexLow.unknownEffects.reason, /evex-physical-state-unmodelled/);
  const malformed = lift(instruction('vxorps', [reg('xmm0'),reg('xmm1'),reg('xmm2')], { prefixes:{ legacy:[], rex:null, vector:{ kind:'vex2', bytes:[0xc4,0] } }, instructionId:'p5-3:bad-vex' }));
  assert.equal(malformed.completeness, 'partial');
  assert.match(malformed.unknownEffects.reason, /prefix-metadata-malformed/);
  const mismatch = lift(instruction('vxorps', [reg('ymm0'),reg('ymm1'),reg('ymm2')], { prefixes:vex2(0xf0), instructionId:'p5-3:vex-mismatch' }));
  assert.equal(mismatch.completeness, 'partial');
  assert.match(mismatch.unknownEffects.reason, /width-operand-mismatch/);
});

test('formatted mnemonic/opStr are not semantic authority and provenance is stable', () => {
  const input = instruction('pxor', [reg('xmm3'),reg('xmm4')], { prefixes:legacy(), instructionId:'p5-3:structured-truth', mnemonic:'syscall', opStr:'zmm31, [evil]' });
  const first = lift(input), second = lift(input);
  assert.equal(first.metadata.instructionFamily, 'pxor');
  assert.equal(first.controlEffect.kind, 'fallthrough');
  assert.ok(first.operations.every((operation) => operation.metadata?.originInstructionId === input.instructionId));
  assert.ok(first.origin.instructionIds.includes(input.instructionId));
  assert.equal(serializeMachineEffectBundle(first), serializeMachineEffectBundle(second));
});

test('VZEROUPPER is bounded and updates only canonical modeled YMM state', () => {
  const bundle = lift(instruction('vzeroupper', [], { prefixes:vex2(0xf8), rawBytes:[0xc5,0xf8,0x77], instructionId:'p5-3:vzeroupper' }));
  assert.equal(bundle.completeness, 'exact');
  assert.equal(ops(bundle,'register-write').length, 16);
  assert.equal(ops(bundle,'register-write').every((operation) => /^ymm(?:[0-9]|1[0-5])$/.test(operation.register.registerId)), true);
  assert.ok(bundle.operations.length < 100);
  assert.equal(bundle.metadata.low128, 'preserved');
  assert.equal(bundle.metadata.upper128, 'zeroed');
});
