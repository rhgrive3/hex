import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flagReads,
  flagWrites,
  imm,
  instruction,
  intrinsics,
  lift,
  mem,
  operations,
  reg,
  registerReads,
  registerWrites,
} from './helpers.mjs';
import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';

function flagNames(bundle) { return flagWrites(bundle).map((operation) => operation.flag.flagId.replace('RFLAGS.','')); }

function expectAllArithmeticFlags(bundle) {
  assert.deepEqual(new Set(flagNames(bundle)), new Set(['CF','PF','AF','ZF','SF','OF']));
}

test('existing MOV and extend semantics retain canonical register identity', () => {
  const mov32 = lift('mov', [reg('eax','write'), reg('ebx','read')]);
  assert.equal(mov32.completeness, 'exact');
  assert.equal(registerWrites(mov32,'rax').length, 1);
  assert.equal(registerWrites(mov32,'rax')[0].metadata.view, 'eax');
  assert.equal(registerWrites(mov32,'rax')[0].metadata.writePolicy, 'zero-extend-32');

  const mov16 = lift('mov', [reg('ax','write'), reg('bx','read')]);
  assert.ok(operations(mov16,'value').some((operation) => operation.opcode === 'insert' && operation.metadata.lsb === 0));
  assert.equal(registerWrites(mov16,'rax').length, 1);

  const movHigh = lift('mov', [reg('ah','write'), reg('bl','read')]);
  assert.ok(operations(movHigh,'value').some((operation) => operation.opcode === 'insert' && operation.metadata.lsb === 8));
  assert.equal(registerWrites(movHigh,'rax').length, 1);

  const movzx = lift('movzx', [reg('eax','write'), reg('bl','read')]);
  assert.ok(operations(movzx,'value').some((operation) => operation.opcode === 'zext'));
  assert.equal(registerWrites(movzx,'rax')[0].metadata.writePolicy, 'zero-extend-32');

  const movsx = lift('movsx', [reg('rax','write'), reg('bl','read')]);
  assert.ok(operations(movsx,'value').some((operation) => operation.opcode === 'sext'));

  const movsxd = lift('movsxd', [reg('rax','write'), reg('ebx','read')]);
  assert.ok(operations(movsxd,'value').some((operation) => operation.opcode === 'sext'));
});

test('ADD/SUB write result and all six exact arithmetic flags', () => {
  for (const family of ['add','sub']) {
    const bundle = lift(family, [reg('rax','read-write'), imm(1n)]);
    assert.equal(registerWrites(bundle,'rax').length, 1);
    expectAllArithmeticFlags(bundle);
    const summary = intrinsics(bundle, `x86.flags.${family}`)[0];
    assert.ok(summary);
    assert.equal(summary.effectSummary.determinism, 'input-dependent');
    assert.equal(summary.metadata.exactArchitecturalSummary, true);
  }
});

test('ADC/SBB consume incoming CF as value provenance', () => {
  for (const family of ['adc','sbb']) {
    const bundle = lift(family, [reg('rax','read-write'), reg('rbx','read')]);
    assert.equal(flagReads(bundle,'CF').length, 1);
    const arithmetic = operations(bundle,'value').find((operation) => operation.opcode === family);
    assert.equal(arithmetic.inputs.length, 3);
    const flagSummary = intrinsics(bundle, `x86.flags.${family}`)[0];
    assert.equal(flagSummary.effectSummary.inputs.length, 4);
    assert.equal(flagSummary.metadata.carryInput, true);
    expectAllArithmeticFlags(bundle);
  }
});

test('INC/DEC preserve CF while defining OF/SF/ZF/AF/PF', () => {
  for (const family of ['inc','dec']) {
    const bundle = lift(family, [reg('eax','read-write')]);
    assert.equal(flagWrites(bundle,'CF').length, 0);
    assert.equal(flagReads(bundle,'CF').length, 0);
    assert.deepEqual(new Set(flagNames(bundle)), new Set(['PF','AF','ZF','SF','OF']));
    assert.equal(intrinsics(bundle, `x86.flags.${family}`)[0].metadata.unchanged.includes('CF'), true);
  }
});

test('NEG defines CF with zero-sensitive rule and all arithmetic flags', () => {
  const bundle = lift('neg', [reg('rax','read-write')]);
  expectAllArithmeticFlags(bundle);
  const summary = intrinsics(bundle, 'x86.flags.neg')[0];
  assert.match(summary.metadata.semanticRules.CF, /source == 0/);
  assert.equal(registerWrites(bundle,'rax').length, 1);
});

test('NOT writes its destination and does not access arithmetic flags', () => {
  const bundle = lift('not', [reg('rax','read-write')]);
  assert.equal(registerWrites(bundle,'rax').length, 1);
  assert.equal(flagWrites(bundle).length, 0);
  assert.equal(flagReads(bundle).length, 0);
});

test('AND/OR/XOR clear CF/OF, define PZS, and make AF explicit undefined', () => {
  for (const family of ['and','or','xor']) {
    const bundle = lift(family, [reg('rax','read-write'), reg('rbx','read')]);
    assert.equal(flagWrites(bundle,'CF')[0].metadata.definedness, 'fixed');
    assert.equal(flagWrites(bundle,'CF')[0].value.value, '0');
    assert.equal(flagWrites(bundle,'OF')[0].metadata.definedness, 'fixed');
    assert.equal(flagWrites(bundle,'AF')[0].metadata.definedness, 'undefined');
    assert.ok(intrinsics(bundle, 'x86.flag.undefined.af').length === 1);
    assert.deepEqual(new Set(flagNames(bundle)), new Set(['CF','OF','PF','ZF','SF','AF']));
  }
});

test('CMP/TEST never write a destination while producing correct flag definedness', () => {
  const cmp = lift('cmp', [reg('eax','read'), imm(7n)]);
  assert.equal(registerWrites(cmp).length, 0);
  expectAllArithmeticFlags(cmp);

  const testBundle = lift('test', [reg('eax','read'), reg('eax','read')]);
  assert.equal(registerWrites(testBundle).length, 0);
  assert.equal(flagWrites(testBundle,'AF')[0].metadata.definedness, 'undefined');
  assert.equal(flagWrites(testBundle,'CF')[0].metadata.definedness, 'fixed');
  assert.equal(flagWrites(testBundle,'OF')[0].metadata.definedness, 'fixed');
});

test('SETcc writes a byte view only and does not modify flags', () => {
  const bundle = lift('setne', [reg('ah','write')], { conditionCode:'ne' });
  assert.equal(flagReads(bundle,'ZF').length, 1);
  assert.equal(flagWrites(bundle).length, 0);
  assert.equal(registerWrites(bundle,'rax').length, 1);
  assert.ok(operations(bundle,'value').some((operation) => operation.opcode === 'insert' && operation.metadata.lsb === 8));
});

test('CMOVcc uses a conditional physical-register write and preserves false-path upper bits', () => {
  const bundle = lift('cmovne', [reg('eax','write'), reg('ebx','read')], { conditionCode:'ne' });
  assert.equal(flagReads(bundle,'ZF').length, 1);
  assert.equal(flagWrites(bundle).length, 0);
  assert.equal(registerReads(bundle,'rax').length >= 1, true);
  assert.equal(registerWrites(bundle,'rax').length, 1);
  const select = operations(bundle,'value').find((operation) => operation.opcode === 'select' && operation.metadata.semantic === 'x86-conditional-register-write');
  assert.ok(select);
  assert.equal(bundle.metadata.falsePathPreservesPhysicalRegister, true);
});

test('unsupported memory and malformed structured forms remain explicit/non-exact', () => {
  const memoryInc = lift('inc', [mem(64, { access:'read-write' })]);
  assert.equal(memoryInc.completeness, 'partial');
  assert.match(memoryInc.unknownEffects.reason, /deferred-to-p5-2/);

  const badCmp = lift('cmp', [imm(1n,32), reg('eax','read')]);
  assert.equal(badCmp.completeness, 'partial');
  assert.equal(registerWrites(badCmp).length, 0);

  assert.throws(() => liftX86MachineEffects(instruction('add', [reg('not-a-register'), imm(1n)])), /unknown-register/);
  const noDetail = liftX86MachineEffects(instruction('add', [], { detailAvailable:false }));
  assert.equal(noDetail, null);
});

test('semantic truth does not depend on formatted mnemonic/opStr and provenance survives', () => {
  const decoded = instruction('add', [reg('eax','read-write'), imm(1n)], {
    instructionId:'p5-1:provenance',
    mnemonic:'totally-wrong-display-name',
    opStr:'this string is deliberately useless',
  });
  const bundle = liftX86MachineEffects(decoded);
  assert.equal(bundle.metadata.instructionFamily, 'add');
  assert.ok(bundle.origin.instructionIds.includes('p5-1:provenance'));
  assert.equal(registerWrites(bundle,'rax').length, 1);
});
