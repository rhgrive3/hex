import assert from 'node:assert/strict';
import test from 'node:test';

import { flagReads, imm, lift, mem, operations, reg, registerReads, registerWrites } from './helpers.mjs';

function memoryReads(bundle) { return operations(bundle,'memory-read'); }
function memoryWrites(bundle) { return operations(bundle,'memory-write'); }

test('direct JMP uses structured immediate target exactly', () => {
  const bundle = lift('jmp', [imm(0x12345678n)], { address:0x1000n, length:5 });
  assert.equal(bundle.controlEffect.kind, 'branch');
  assert.equal(bundle.controlEffect.target.value, String(0x12345678n));
  assert.equal(bundle.metadata.instructionLength, 5);
});

test('register and structured-memory indirect JMP are explicit', () => {
  const register = lift('jmp', [reg('rax','read')]);
  assert.equal(register.controlEffect.kind, 'indirect');
  assert.equal(registerReads(register,'rax').length, 1);
  assert.equal(register.possibleFaults.length, 0);

  const memory = lift('jmp', [mem(64, { base:'rax' })]);
  assert.equal(memory.controlEffect.kind, 'indirect');
  assert.equal(memoryReads(memory).length, 1);
  assert.equal(memory.possibleFaults[0].kind, 'memory-access-fault');
  assert.equal(memory.metadata.memoryIndirect, true);
});

test('malformed narrow indirect JMP/CALL targets fail closed', () => {
  for (const family of ['jmp','call']) {
    const bundle = lift(family, [reg('eax','read')]);
    assert.equal(bundle.completeness, 'partial');
    assert.equal(bundle.controlEffect.kind, 'unknown');
    assert.match(bundle.unknownEffects.reason, new RegExp(`x86-${family}-target-unmodelled`));
    assert.equal(registerReads(bundle,'rax').length, 0);
  }
});

test('Jcc has explicit condition, target, and exact variable-length fallthrough', () => {
  const bundle = lift('je', [imm(0x2000n)], { address:0x1000n, length:2, conditionCode:'e' });
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(bundle.controlEffect.target.value, String(0x2000n));
  assert.equal(bundle.controlEffect.fallthrough.value, String(0x1002n));
  assert.equal(flagReads(bundle,'ZF').length, 1);
  assert.equal(bundle.metadata.conditionCode, 'e');
});

test('JRCXZ/JECXZ/JCXZ use the appropriate count register, not RFLAGS', () => {
  for (const [family,physical] of [['jrcxz','rcx'],['jecxz','rcx'],['jcxz','rcx']]) {
    const bundle = lift(family, [imm(0x1100n)], { conditionCode:null });
    assert.equal(bundle.controlEffect.kind, 'conditional-branch');
    assert.equal(flagReads(bundle).length, 0);
    assert.equal(registerReads(bundle,physical).length, 1);
    assert.equal(bundle.metadata.conditionKind, 'count-register');
  }
});

test('CALL models only architectural transfer, return address, RSP, and stack store', () => {
  const bundle = lift('call', [imm(0x2000n)], { address:0x1000n, length:5 });
  assert.equal(bundle.controlEffect.kind, 'call');
  assert.equal(bundle.controlEffect.target.value, String(0x2000n));
  assert.equal(bundle.controlEffect.fallthrough.value, String(0x1005n));
  assert.equal(bundle.metadata.returnAddress, String(0x1005n));
  assert.equal(bundle.metadata.stackDelta, -8);
  assert.equal(bundle.metadata.abiSemantics, false);
  assert.equal(registerReads(bundle,'rsp').length, 1);
  assert.equal(registerWrites(bundle,'rsp').length, 1);
  assert.equal(memoryWrites(bundle).length, 1);
  assert.equal(memoryWrites(bundle)[0].metadata.returnAddress, true);
  assert.equal(bundle.possibleFaults.some((fault) => fault.kind === 'memory-access-fault'), true);
  assert.equal(registerReads(bundle,'rdi').length, 0);
  assert.equal(registerReads(bundle,'rcx').length, 0);
});

test('indirect CALL resolves register before RSP mutation and memory target through frozen addressing', () => {
  const register = lift('call', [reg('rsp','read')], { address:0x3000n, length:2 });
  const rspReads = registerReads(register,'rsp');
  const rspWrite = registerWrites(register,'rsp')[0];
  assert.equal(rspReads.length, 2);
  assert.ok(register.operations.indexOf(rspReads[0]) < register.operations.indexOf(rspWrite));
  assert.equal(register.controlEffect.kind, 'call');

  const memory = lift('call', [mem(64, { base:'rax' })], { address:0x3000n, length:2 });
  assert.equal(memoryReads(memory).length, 1);
  assert.equal(memoryWrites(memory).length, 1);
  assert.equal(memory.possibleFaults.length, 2);
  assert.equal(memory.metadata.memoryIndirect, true);
});

test('RET pops target and advances RSP by 8', () => {
  const bundle = lift('ret', [], { address:0x4000n, length:1 });
  assert.equal(bundle.controlEffect.kind, 'return');
  assert.equal(memoryReads(bundle).length, 1);
  assert.equal(registerReads(bundle,'rsp').length, 1);
  assert.equal(registerWrites(bundle,'rsp').length, 1);
  assert.equal(bundle.metadata.stackDelta, '8');
  assert.equal(bundle.metadata.immediateAdjustment, '0');
  assert.equal(bundle.metadata.abiSemantics, false);
});

test('RET imm adds the immediate adjustment after popping the return address', () => {
  const bundle = lift('ret', [imm(24n,16)], { address:0x4000n, length:3 });
  assert.equal(bundle.controlEffect.kind, 'return');
  assert.equal(bundle.metadata.immediateAdjustment, '24');
  assert.equal(bundle.metadata.stackDelta, '32');
});

test('NOP has explicit architectural preservation proof', () => {
  const bundle = lift('nop', [], { length:9 });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.operations.length, 0);
  assert.equal(bundle.controlEffect.kind, 'fallthrough');
  assert.equal(bundle.statePreservation.proven, true);
});

test('UD2 and INT3 use existing trap/fault vocabulary', () => {
  const ud2 = lift('ud2', [], { length:2 });
  assert.equal(ud2.controlEffect.kind, 'trap');
  assert.equal(ud2.possibleFaults[0].kind, 'invalid-opcode');
  assert.equal(ud2.possibleFaults[0].detail.vector, '#UD');

  const int3 = lift('int3', [], { length:1 });
  assert.equal(int3.controlEffect.kind, 'trap');
  assert.equal(int3.possibleFaults[0].kind, 'breakpoint-trap');
  assert.equal(int3.possibleFaults[0].detail.vector, '#BP');
});

test('unknown conditional detail and malformed RET fail closed', () => {
  const badCondition = lift('jfuture', [imm(0x5000n)], { conditionCode:'future' });
  assert.equal(badCondition.completeness, 'partial');
  assert.equal(badCondition.controlEffect.kind, 'unknown');

  const badRet = lift('ret', [reg('rax')]);
  assert.equal(badRet.completeness, 'partial');
  assert.equal(badRet.controlEffect.kind, 'unknown');
});
