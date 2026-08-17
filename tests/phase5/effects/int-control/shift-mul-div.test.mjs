import assert from 'node:assert/strict';
import test from 'node:test';

import { flagReads, flagWrites, imm, intrinsics, lift, operations, reg, registerReads, registerWrites } from './helpers.mjs';

function flagSet(bundle) { return new Set(flagWrites(bundle).map((operation) => operation.flag.flagId.replace('RFLAGS.',''))); }

test('shift effective count zero preserves the view/flags while r32 still zero-extends the physical GPR', () => {
  for (const family of ['shl','sal','shr','sar']) {
    const bundle = lift(family, [reg('eax','read-write'), imm(32n)]);
    assert.equal(bundle.completeness, 'exact');
    assert.equal(bundle.metadata.effectiveCount, 0);
    assert.equal(bundle.metadata.destinationViewPreserved, true);
    assert.equal(bundle.metadata.flagsPreserved, true);
    assert.equal(bundle.metadata.zeroExtend32Write, true);
    assert.equal(flagWrites(bundle).length, 0);
    assert.equal(registerWrites(bundle,'rax').length, 1);
    assert.equal(registerWrites(bundle,'rax')[0].metadata.writePolicy, 'zero-extend-32');
    assert.ok(operations(bundle,'value').some((operation) => operation.opcode === 'zext' && operation.metadata.fromBits === 32 && operation.metadata.toBits === 64));
  }

  const wide = lift('shl', [reg('rax','read-write'), imm(64n)]);
  assert.equal(wide.operations.length, 0);
  assert.equal(wide.statePreservation.proven, true);
});

test('shift count one defines CF/OF and PZS while AF is undefined', () => {
  for (const family of ['shl','shr','sar']) {
    const bundle = lift(family, [reg('eax','read-write'), imm(1n)]);
    assert.equal(registerWrites(bundle,'rax').length, 1);
    assert.equal(flagWrites(bundle,'CF')[0].metadata.definedness, 'defined');
    assert.equal(flagWrites(bundle,'OF')[0].metadata.definedness, 'defined');
    assert.equal(flagWrites(bundle,'AF')[0].metadata.definedness, 'undefined');
    for (const flag of ['PF','ZF','SF']) assert.equal(flagWrites(bundle,flag)[0].metadata.definedness, 'defined');
    assert.match(intrinsics(bundle,'x86.integer.')[0].metadata.semanticRules.result,/effectiveCount|effective count/i);
  }
});

test('shift count greater than one leaves OF explicit undefined', () => {
  for (const family of ['shl','shr','sar']) {
    const bundle = lift(family, [reg('ax','read-write'), imm(2n)]);
    assert.equal(flagWrites(bundle,'OF')[0].metadata.definedness, 'undefined');
    assert.equal(flagWrites(bundle,'AF')[0].metadata.definedness, 'undefined');
    assert.equal(flagWrites(bundle,'CF')[0].metadata.definedness, 'defined');
  }

  const wideByteShift = lift('shl', [reg('al','read-write'), imm(8n)]);
  assert.equal(flagWrites(wideByteShift,'CF')[0].metadata.definedness, 'undefined');
});

test('variable CL shift models count-zero view preservation with architectural r32 zero-extension', () => {
  const bundle = lift('shl', [reg('eax','read-write'), reg('cl','read')]);
  assert.equal(registerReads(bundle,'rcx').length >= 1, true);
  assert.ok(operations(bundle,'value').some((operation) => operation.opcode === 'and' && operation.metadata.semantic === 'x86-effective-count-mask'));
  const select = operations(bundle,'value').find((operation) => operation.opcode === 'select' && operation.metadata.semantic === 'x86-conditional-register-write');
  assert.ok(select);
  assert.equal(select.metadata.falsePathViewWrite, true);
  assert.equal(registerWrites(bundle,'rax').length, 1);
  const zeroExtensions = operations(bundle,'value').filter((operation) => operation.opcode === 'zext' && operation.metadata.fromBits === 32 && operation.metadata.toBits === 64);
  assert.equal(zeroExtensions.length >= 2, true);
  for (const flag of ['CF','PF','AF','ZF','SF','OF']) assert.equal(flagWrites(bundle,flag).length, 1);
  assert.equal(flagReads(bundle,'CF').length >= 1, true);
});

test('ROL/ROR affect only CF and count-dependent OF, including r32 zero-count write semantics', () => {
  for (const family of ['rol','ror']) {
    const one = lift(family, [reg('eax','read-write'), imm(1n)]);
    assert.deepEqual(flagSet(one), new Set(['CF','OF']));
    assert.equal(flagWrites(one,'OF')[0].metadata.definedness, 'defined');

    const two = lift(family, [reg('eax','read-write'), imm(2n)]);
    assert.deepEqual(flagSet(two), new Set(['CF','OF']));
    assert.equal(flagWrites(two,'OF')[0].metadata.definedness, 'undefined');

    const dwordZero = lift(family, [reg('eax','read-write'), imm(32n)]);
    assert.equal(flagWrites(dwordZero).length, 0);
    assert.equal(registerWrites(dwordZero,'rax').length, 1);
    assert.equal(dwordZero.metadata.zeroExtend32Write, true);
  }

  const rotateModuloZero = lift('rol', [reg('al','read-write'), imm(8n)]);
  assert.equal(rotateModuloZero.operations.length, 0);
  assert.equal(rotateModuloZero.statePreservation.proven, true);
});

test('MUL one-operand form uses implicit accumulator/high-half architectural state', () => {
  const byte = lift('mul', [reg('bl','read')]);
  assert.equal(registerReads(byte,'rax').length >= 1, true);
  assert.equal(registerWrites(byte,'rax').length, 1);
  assert.equal(intrinsics(byte,'x86.integer.mul.implicit')[0].metadata.productWidthBits, 16);
  assert.match(intrinsics(byte,'x86.integer.mul.implicit')[0].metadata.semanticRules.product,/unsigned/i);

  const dword = lift('mul', [reg('ebx','read')]);
  assert.equal(registerReads(dword,'rax').length >= 1, true);
  assert.equal(registerWrites(dword,'rax').length, 1);
  assert.equal(registerWrites(dword,'rdx').length, 1);
  assert.equal(flagWrites(dword,'CF').length, 1);
  assert.equal(flagWrites(dword,'OF').length, 1);
  for (const flag of ['PF','AF','ZF','SF']) assert.equal(flagWrites(dword,flag)[0].metadata.definedness, 'undefined');
});

test('IMUL one/two/three operand forms remain distinct', () => {
  const one = lift('imul', [reg('rbx','read')]);
  assert.equal(one.metadata.form, 'one-operand-implicit');
  assert.equal(registerWrites(one,'rax').length, 1);
  assert.equal(registerWrites(one,'rdx').length, 1);
  assert.match(intrinsics(one,'x86.integer.imul.implicit')[0].metadata.semanticRules.product,/signed/i);

  const two = lift('imul', [reg('eax','read-write'), reg('ebx','read')]);
  assert.equal(two.metadata.form, 'two-operand');
  assert.equal(registerWrites(two,'rax').length, 1);
  assert.equal(registerWrites(two,'rdx').length, 0);
  assert.match(intrinsics(two,'x86.integer.imul.truncated')[0].metadata.semanticRules.overflow,/sign-extension/);

  const three = lift('imul', [reg('eax','write'), reg('ebx','read'), imm(-7n)]);
  assert.equal(three.metadata.form, 'three-operand');
  assert.equal(registerWrites(three,'rax').length, 1);
  assert.equal(registerReads(three,'rax').length, 0);
});

test('DIV consumes implicit dividend pair and writes quotient/remainder with divide-error possibility', () => {
  const bundle = lift('div', [reg('ecx','read')]);
  assert.equal(registerReads(bundle,'rax').length >= 1, true);
  assert.equal(registerReads(bundle,'rdx').length >= 1, true);
  assert.equal(registerWrites(bundle,'rax').length, 1);
  assert.equal(registerWrites(bundle,'rdx').length, 1);
  assert.equal(bundle.metadata.form, 'implicit-dividend-pair');
  assert.equal(bundle.metadata.signed, false);
  assert.equal(bundle.possibleFaults.length, 1);
  assert.equal(bundle.possibleFaults[0].kind, 'divide-error');
  assert.equal(bundle.possibleFaults[0].condition.anyOf[0].kind, 'divisor-zero');
  assert.equal(bundle.possibleFaults[0].condition.anyOf[1].kind, 'quotient-out-of-range');
  assert.match(intrinsics(bundle,'x86.integer.div')[0].metadata.semanticRules.quotient,/unsigned/);
  assert.match(intrinsics(bundle,'x86.integer.div')[0].metadata.semanticRules.fault,/divisor is zero/);
  for (const flag of ['CF','PF','AF','ZF','SF','OF']) assert.equal(flagWrites(bundle,flag)[0].metadata.definedness, 'undefined');
});

test('8-bit DIV combines AL/AH result into AX and preserves the rest of RAX', () => {
  const bundle = lift('div', [reg('bl','read')]);
  assert.equal(registerReads(bundle,'rax').length >= 2, true);
  assert.equal(registerWrites(bundle,'rax').length, 1);
  assert.ok(operations(bundle,'value').some((operation) => operation.opcode === 'concat' && operation.metadata.semantic === 'x86-div-result-ax'));
  assert.ok(operations(bundle,'value').some((operation) => operation.opcode === 'insert' && operation.metadata.widthBits === 16));
});

test('IDIV records signed quotient/remainder contract and undefined arithmetic flags', () => {
  const bundle = lift('idiv', [reg('rcx','read')]);
  assert.equal(bundle.metadata.signed, true);
  const summary = intrinsics(bundle,'x86.integer.idiv')[0];
  assert.equal(summary.metadata.signed, true);
  assert.match(summary.metadata.semanticRules.quotient,/truncated toward zero/);
  assert.match(summary.metadata.semanticRules.remainder,/same sign as dividend/);
  assert.equal(bundle.possibleFaults[0].condition.anyOf[1].signed, true);
  assert.deepEqual(flagSet(bundle), new Set(['CF','PF','AF','ZF','SF','OF']));
});
