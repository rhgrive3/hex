import assert from 'node:assert/strict';
import test from 'node:test';

import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import {
  RISCV64_ABI_NAMES,
  RISCV64_PHYSICAL_REGISTERS,
  isRiscv64ZeroRegister,
  normalizeRiscv64RegisterName,
  riscv64RegisterDescriptor,
} from '../../../js/targets/architecture/riscv64/registers.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { liftRiscv64MachineEffects } from '../../../js/targets/architecture/riscv64/effects/index.js';

function lift(bytes, address = 0x1000n) {
  const decoded = createRiscv64DecodedInstruction({
    address, size: bytes.length, rawBytes: Uint8Array.from(bytes),
    instructionId: `i@${address}`, origin: { instructionIds: [`i@${address}`] },
  });
  return liftRiscv64MachineEffects(decoded, { instructionId: `i@${address}`, origin: { instructionIds: [`i@${address}`] }, mode: 'rv64imc' });
}

test('the physical register file is exactly x0..x31 with no flags register', () => {
  assert.equal(RISCV64_PHYSICAL_REGISTERS.length, 32);
  assert.deepEqual(RISCV64_PHYSICAL_REGISTERS.map((r) => r.id), Array.from({ length: 32 }, (_v, i) => `x${i}`));
  assert.equal(RISCV64_PHYSICAL_REGISTERS.filter((r) => r.kind === 'flags').length, 0);
  const plugin = architecturePluginV2('riscv64');
  assert.equal(plugin.registerFile().length, 32);
  assert.equal(plugin.registerFile().filter((r) => /flag|nzcv|rflags|eflags/i.test(String(r.id) + String(r.kind))).length, 0,
    'Phase 6 must not synthesise a condition-code register');
});

test('psABI names are views of the same physical state, not separate registers', () => {
  RISCV64_ABI_NAMES.forEach((abiName, index) => {
    assert.equal(normalizeRiscv64RegisterName(abiName), `x${index}`);
    assert.equal(riscv64RegisterDescriptor(abiName), riscv64RegisterDescriptor(`x${index}`),
      `${abiName} and x${index} must resolve to one descriptor`);
  });
  assert.equal(normalizeRiscv64RegisterName('fp'), 'x8');
  assert.equal(normalizeRiscv64RegisterName('s0'), 'x8');
  // The FP register file is outside the frozen profile and must not resolve.
  assert.equal(normalizeRiscv64RegisterName('ft0'), null);
  assert.equal(normalizeRiscv64RegisterName('fa0'), null);
});

test('only the architectural stack pointer carries the stack-pointer role', () => {
  const stackPointers = RISCV64_PHYSICAL_REGISTERS.filter((r) => r.kind === 'stack-pointer');
  assert.deepEqual(stackPointers.map((r) => r.id), ['x2']);
  assert.equal(riscv64RegisterDescriptor('sp').role, 'stack-pointer');
  assert.equal(riscv64RegisterDescriptor('ra').role, 'return-address');
  assert.equal(riscv64RegisterDescriptor('x8').role, 'frame-pointer');
});

test('x0 is hardwired: reads are the constant zero and writes are discarded', () => {
  assert.equal(isRiscv64ZeroRegister('x0'), true);
  assert.equal(isRiscv64ZeroRegister('zero'), true);
  assert.equal(isRiscv64ZeroRegister('x10'), false);

  // `addi x0, x0, 0` is the canonical nop: it must neither read nor write x0.
  const nop = lift([0x13, 0x00, 0x00, 0x00]);
  assert.ok(nop, 'nop must lift');
  assert.equal(nop.operations.filter((o) => o.kind === 'register-write').length, 0, 'a write to x0 must be discarded');
  assert.equal(nop.operations.filter((o) => o.kind === 'register-read' && o.register.registerId === 'x0').length, 0,
    'x0 must never be read as storage');
  assert.deepEqual(nop.metadata.discardedHardwiredZeroWrites, ['x0']);
  assert.equal(nop.completeness, 'exact');

  // `li a0, 0` is `addi a0, x0, 0`: the x0 source becomes a constant operand.
  const loadZero = lift([0x13, 0x05, 0x00, 0x00]);
  assert.equal(loadZero.operations.filter((o) => o.kind === 'register-read').length, 0);
  const writes = loadZero.operations.filter((o) => o.kind === 'register-write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].register.registerId, 'x10');
});

test('no lifted RV64 bundle ever emits flag operations', () => {
  const encodings = [
    [0x13, 0x05, 0xb5, 0xff],       // addi a0, a0, -5
    [0x33, 0x85, 0xb5, 0x00],       // add a0, a1, a1
    [0xb3, 0x25, 0xb5, 0x00],       // slt a1, a0, a1
    [0x63, 0x04, 0xb5, 0x00],       // beq a0, a1, +8
    [0x83, 0x35, 0x05, 0x00],       // ld a1, 0(a0)
    [0x33, 0x45, 0xb5, 0x02],       // div a0, a0, a1
  ];
  for (const bytes of encodings) {
    const bundle = lift(bytes);
    assert.ok(bundle, `must lift ${bytes.map((b) => b.toString(16)).join(' ')}`);
    assert.equal(bundle.operations.filter((o) => o.kind === 'flag-read' || o.kind === 'flag-write').length, 0,
      'RV64 has no flags register; the lifter must never fabricate flag effects');
  }
});
