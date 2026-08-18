import assert from 'node:assert/strict';
import test from 'node:test';

import { abiPlugin, resolveABIPlugin } from '../../../js/targets/abi/index.js';
import {
  RISCV_CALLEE_SAVED,
  RISCV_CALLER_SAVED,
  RISCV_INTEGER_ARGUMENT_REGISTERS,
  RISCV_INTEGER_RETURN_REGISTERS,
  RISCV_UNALLOCATABLE,
  riscvAbiFromElfFlags,
} from '../../../js/targets/abi/riscv-lp64.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';

const lp64 = abiPlugin('lp64');

test('the integer calling convention matches the psABI register table', () => {
  assert.deepEqual([...RISCV_INTEGER_ARGUMENT_REGISTERS], ['x10','x11','x12','x13','x14','x15','x16','x17'], 'a0-a7');
  assert.deepEqual([...RISCV_INTEGER_RETURN_REGISTERS], ['x10','x11'], 'a0-a1');
  assert.deepEqual([...RISCV_CALLEE_SAVED], ['x2','x8','x9','x18','x19','x20','x21','x22','x23','x24','x25','x26','x27'], 'sp and s0-s11');
  assert.ok(RISCV_CALLER_SAVED.includes('x1'), 'ra is caller-saved');
  for (const temporary of ['x5','x6','x7','x28','x29','x30','x31']) {
    assert.ok(RISCV_CALLER_SAVED.includes(temporary), `${temporary} (a temporary) is caller-saved`);
  }
  // A register may not be in both sets, and the reserved ones are in neither.
  for (const register of RISCV_CALLEE_SAVED) assert.ok(!RISCV_CALLER_SAVED.includes(register), `${register} cannot be both`);
  for (const reserved of RISCV_UNALLOCATABLE) {
    assert.ok(!RISCV_CALLER_SAVED.includes(reserved) && !RISCV_CALLEE_SAVED.includes(reserved),
      `${reserved} is reserved by the psABI and must not be claimed as saved by either side`);
  }
  assert.deepEqual([...RISCV_UNALLOCATABLE], ['x0','x3','x4'], 'zero, gp and tp');
});

test('stack and unwind rules follow the psABI, including the absence of a red zone', () => {
  const stack = lp64.stackRules();
  assert.equal(stack.alignment, 16);
  assert.equal(stack.stackGrows, 'down');
  assert.equal(stack.argumentSlotBytes, 8);
  assert.equal(stack.framePointer, 'x8');
  // The return address arrives in ra, so the call does not push it and the
  // callee's incoming stack arguments start at sp+0.
  assert.equal(stack.returnAddressBytes, 0);
  assert.equal(stack.returnAddressRegister, 'x1');
  assert.equal(stack.calleeEntryAlignmentOffset, 0);
  assert.equal(lp64.redZone(), 0, 'the RISC-V psABI defines no red zone');
  assert.deepEqual(lp64.unwindRules(), { framePointer: 'x8', returnAddress: 'register', returnAddressRegister: 'x1' });
});

test('a syscall convention is not invented from the psABI', () => {
  for (const id of ['lp64', 'lp64f', 'lp64d']) {
    assert.equal(abiPlugin(id).syscallABI, null, `${id} must not claim a syscall ABI; that is platform policy`);
  }
});

test('integer arguments allocate a0-a7 then the stack', () => {
  const parameters = Array.from({ length: 10 }, (_value, index) => ({ type: 'long', bits: 64, name: `p${index}` }));
  const classified = lp64.classifyArguments({ callPrototype: { args: parameters } });
  assert.equal(classified.arguments.length, 10);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(classified.arguments[index].location, 'register');
    assert.equal(classified.arguments[index].reg, RISCV_INTEGER_ARGUMENT_REGISTERS[index]);
  }
  assert.deepEqual(classified.stackArguments.map((entry) => entry.offset), [0, 8], 'the ninth and tenth arguments go on the stack');
  assert.equal(classified.stackArgsUnknown, false);
});

test('aggregates follow the psABI size rule and returns use a0/a1', () => {
  const small = lp64.classifyArguments({ callPrototype: { args: [{ type: 'struct', aggregate: true, bits: 128 }] } });
  assert.equal(small.arguments[0].location, 'registers');
  assert.deepEqual(small.arguments[0].regs, ['x10', 'x11'], 'up to 2*XLEN passes in two integer registers');

  const large = lp64.classifyArguments({ callPrototype: { args: [{ type: 'struct', aggregate: true, bits: 256 }] } });
  assert.equal(large.arguments[0].abiClass, 'aggregate-by-reference', 'beyond 2*XLEN the aggregate is passed by reference');
  assert.equal(large.arguments[0].pointer, true);

  assert.deepEqual(lp64.classifyFunctionReturn({ functionPrototype: { returnType: 'long', returnsValue: true } }),
    { reg: 'x10', abiName: 'a0', bits: 64 });
  const wide = lp64.classifyFunctionReturn({ functionPrototype: { returnType: 'int128', returnBits: 128, returnsValue: true } });
  assert.deepEqual(wide.regs, ['x10', 'x11'], 'a 2*XLEN scalar returns in a0-a1');
  const indirect = lp64.classifyFunctionReturn({ functionPrototype: { returnType: 'struct', aggregate: true, returnBits: 512, returnsValue: true } });
  assert.equal(indirect.indirect, true, 'a return larger than 2*XLEN is returned in memory');
});

test('with no prototype the ABI stays conservative rather than guessing', () => {
  const classified = lp64.classifyArguments({});
  assert.equal(classified.partial, true);
  assert.equal(classified.stackArgsUnknown, true);
  assert.equal(classified.stackArgsMayContainPointers, true);
  const unknownCall = lp64.defaultUnknownCallEffects();
  assert.equal(unknownCall.memoryEffects, 'unknown');
  assert.equal(unknownCall.mayThrow, true);
  for (const register of RISCV_CALLER_SAVED) {
    assert.ok(unknownCall.registerClobbers.includes(register), `${register} must be assumed clobbered by an unknown call`);
  }
});

test('the floating-point ABI is selected from ELF flags, never assumed', () => {
  assert.equal(riscvAbiFromElfFlags(0x0).abiId, 'lp64');
  assert.equal(riscvAbiFromElfFlags(0x1).abiId, 'lp64');
  assert.equal(riscvAbiFromElfFlags(0x1).compressed, true);
  assert.equal(riscvAbiFromElfFlags(0x3).abiId, 'lp64f');
  assert.equal(riscvAbiFromElfFlags(0x5).abiId, 'lp64d');
  assert.equal(riscvAbiFromElfFlags(0x11).totalStoreOrdering, true);

  // Variants outside the frozen profile stay explicitly unsupported.
  assert.equal(riscvAbiFromElfFlags(0x7).supported, false, 'lp64q');
  assert.equal(riscvAbiFromElfFlags(0x9).supported, false, 'RVE');
  assert.equal(riscvAbiFromElfFlags(0x1, { bits: 32 }).supported, false, 'RV32');

  // Hardware-float variants classify integer arguments exactly but must not
  // claim exact floating-point classification.
  assert.equal(riscvAbiFromElfFlags(0x0).exactness, 'exact');
  assert.equal(riscvAbiFromElfFlags(0x5).exactness, 'partial-floating-point-classification');
  const hard = abiPlugin('lp64d').classifyArguments({ callPrototype: { args: [{ type: 'struct', aggregate: true, bits: 128 }] } });
  assert.equal(hard.partial, true, 'lp64d small-aggregate flattening is not proven and must stay partial');
});

test('the ABI resolves for riscv64 and never leaks across architectures', () => {
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux' }).id, 'lp64');
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', abiId: 'lp64d' }).id, 'lp64d');
  for (const id of ['lp64', 'lp64f', 'lp64d']) assert.equal(abiPlugin(id).architectureId, 'riscv64');
  assert.notEqual(resolveABIPlugin({ architecture: 'x86_64', platform: 'linux' }).id, 'lp64');
  assert.notEqual(resolveABIPlugin({ architecture: 'arm64', platform: 'linux' }).id, 'lp64');
});

test('the semantic ABI adapter exposes register roles that generic code would otherwise hardcode', () => {
  const adapter = semanticAbiAdapter(lp64);
  assert.deepEqual([...adapter.argumentRegisters()], [...RISCV_INTEGER_ARGUMENT_REGISTERS]);
  assert.equal(adapter.returnRegister({ returnType: 'long' }), 'x10');
  assert.equal(adapter.returnRegister({ returnType: 'void' }), null);
  // x0 is RISC-V's hardwired zero. If generic code assumed AArch64's `x0`
  // result register it would read this location instead.
  assert.notEqual(adapter.returnRegister({ returnType: 'long' }), 'x0');
  assert.deepEqual([...adapter.frameBookkeepingRegisters()].sort(), ['x1', 'x8']);
});
