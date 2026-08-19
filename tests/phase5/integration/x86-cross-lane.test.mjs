import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionDecodedFunction } from '../../../js/targets/architecture/x86_64/semantic-function.js';
import { liftX86MachineEffects } from '../../../js/targets/architecture/x86_64/effects/index.js';
import { decoded, imm, mem, operations, reg } from '../effects/memory/helpers.mjs';

function lift(input) {
  const instruction = decoded(input);
  const bundle = liftX86MachineEffects(instruction);
  assert.ok(bundle, `expected MachineEffects for ${input.family}`);
  return { instruction, bundle };
}

const reads = (bundle) => operations(bundle, 'memory-read');
const writes = (bundle) => operations(bundle, 'memory-write');
const flagReads = (bundle, flag) => operations(bundle, 'flag-read').filter((operation) => operation.flag.flagId === `RFLAGS.${flag}`);
const flagWrites = (bundle, flag) => operations(bundle, 'flag-write').filter((operation) => flag == null || operation.flag.flagId === `RFLAGS.${flag}`);
const registerWrites = (bundle, registerId) => operations(bundle, 'register-write').filter((operation) => operation.register.registerId === registerId);

for (const family of ['adc', 'sbb']) {
  test(`${family.toUpperCase()} memory RMW consumes incoming CF through the shared scalar/flag contract`, () => {
    const { bundle } = lift({ family, operands:[mem({ base:'rax', widthBits:64, access:'read-write' }), reg('rbx', 64, 'read')] });
    assert.equal(bundle.completeness, 'exact-with-intrinsic');
    assert.equal(flagReads(bundle, 'CF').length, 1);
    const arithmetic = operations(bundle, 'value').find((operation) => operation.opcode === family);
    assert.ok(arithmetic);
    assert.equal(arithmetic.inputs.length, 3);
    assert.equal(arithmetic.metadata.carryInput, true);
    assert.equal(reads(bundle).length, 1);
    assert.equal(writes(bundle).length, 1);
  });
}

test('INC/DEC memory RMW preserve CF while updating the other architecturally defined flags', () => {
  for (const family of ['inc', 'dec']) {
    const { bundle } = lift({ family, operands:[mem({ base:'rax', widthBits:64, access:'read-write' })] });
    assert.equal(bundle.completeness, 'exact-with-intrinsic');
    assert.equal(flagReads(bundle, 'CF').length, 0);
    assert.equal(flagWrites(bundle, 'CF').length, 0);
    for (const flag of ['OF', 'SF', 'ZF', 'AF', 'PF']) assert.equal(flagWrites(bundle, flag).length, 1);
    assert.equal(reads(bundle).length, 1);
    assert.equal(writes(bundle).length, 1);
  }
});

test('memory shift with an effective count of zero preserves destination and flags without inventing a store', () => {
  const { bundle } = lift({ family:'shl', operands:[mem({ base:'rax', widthBits:64, access:'read-write' }), imm(64n, 8, 8)] });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.metadata.effectiveCount, 0);
  assert.equal(bundle.metadata.destinationPreserved, true);
  assert.equal(bundle.metadata.flagsPreserved, true);
  assert.equal(bundle.metadata.memoryReadForFaultSemantics, true);
  assert.equal(reads(bundle).length, 1);
  assert.equal(writes(bundle).length, 0);
  assert.equal(flagWrites(bundle).length, 0);
  assert.equal(bundle.statePreservation, undefined);
});

test('memory rotate count rules mask/modulo correctly and define only CF/OF for count one', () => {
  const zero = lift({ family:'rol', operands:[mem({ base:'rax', widthBits:8, access:'read-write' }), imm(8n, 8, 8)] }).bundle;
  assert.equal(zero.metadata.effectiveCount, 0);
  assert.equal(writes(zero).length, 0);
  assert.equal(flagWrites(zero).length, 0);

  const one = lift({ family:'ror', operands:[mem({ base:'rax', widthBits:64, access:'read-write' }), imm(1n, 8, 8)] }).bundle;
  assert.equal(one.completeness, 'exact-with-intrinsic');
  assert.equal(one.metadata.effectiveCount, 1);
  assert.deepEqual(flagWrites(one).map((operation) => operation.flag.flagId).sort(), ['RFLAGS.CF', 'RFLAGS.OF']);
  assert.equal(reads(one).length, 1);
  assert.equal(writes(one).length, 1);
});

test('memory MUL/IMUL/DIV/IDIV reuse canonical implicit accumulator/high-half state', () => {
  for (const family of ['mul', 'imul']) {
    const { bundle } = lift({ family, operands:[mem({ base:'rbx', widthBits:32, access:'read' })] });
    assert.equal(bundle.completeness, 'exact-with-intrinsic');
    assert.equal(reads(bundle).length, 1);
    assert.equal(registerWrites(bundle, 'rax').length, 1);
    assert.equal(registerWrites(bundle, 'rdx').length, 1);
  }

  const twoOperandImul = lift({ family:'imul', operands:[reg('eax', 32, 'read-write'), mem({ base:'rbx', widthBits:32, access:'read' })] }).bundle;
  assert.equal(twoOperandImul.completeness, 'exact-with-intrinsic');
  assert.equal(registerWrites(twoOperandImul, 'rax').length, 1);
  assert.equal(registerWrites(twoOperandImul, 'rdx').length, 0);

  for (const family of ['div', 'idiv']) {
    const { bundle } = lift({ family, operands:[mem({ base:'rbx', widthBits:32, access:'read' })] });
    assert.equal(bundle.completeness, 'exact-with-intrinsic');
    assert.equal(reads(bundle).length, 1);
    assert.equal(registerWrites(bundle, 'rax').length, 1);
    assert.equal(registerWrites(bundle, 'rdx').length, 1);
    assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'divide-error'));
  }
});

test('cross-lane memory RMW preserves one canonical address, RMW identity, and instruction provenance', () => {
  const { instruction, bundle } = lift({ family:'adc', operands:[mem({ base:'rax', index:'rcx', scale:4, displacement:-16n, widthBits:64, access:'read-write' }), reg('rdx', 64, 'read')] });
  const [read] = reads(bundle);
  const [write] = writes(bundle);
  assert.ok(bundle.origin.instructionIds.includes(instruction.instructionId));
  assert.equal(read.metadata.rmwId, write.metadata.rmwId);
  assert.deepEqual(read.access.addressExpr, write.access.addressExpr);
  assert.equal(read.access.addressExpr.originInstructionId, instruction.instructionId);
  for (const operation of bundle.operations) assert.equal(operation.metadata.originInstructionId, instruction.instructionId);
});

test('proven LOCKed cross-lane memory RMW maps to generic seq-cst while unlocked RMW does not', () => {
  const locked = lift({ family:'adc', prefixes:[0xf0], operands:[mem({ base:'rax', widthBits:64, access:'read-write' }), reg('rbx', 64, 'read')] }).bundle;
  assert.equal(locked.completeness, 'exact-with-intrinsic');
  assert.equal(locked.metadata.orderingMapping, 'seq-cst');
  assert.match(locked.metadata.orderingAuthority, /Intel SDM Vol\.3/);
  assert.equal(reads(locked)[0].access.atomic, true);
  assert.equal(writes(locked)[0].access.atomic, true);
  assert.equal(reads(locked)[0].access.ordering, 'seq-cst');
  assert.equal(writes(locked)[0].access.ordering, 'seq-cst');

  const unlocked = lift({ family:'adc', operands:[mem({ base:'rax', widthBits:64, access:'read-write' }), reg('rbx', 64, 'read')] }).bundle;
  assert.equal(reads(unlocked)[0].access.atomic, false);
  assert.equal(writes(unlocked)[0].access.atomic, false);
  assert.equal(reads(unlocked)[0].access.ordering, undefined);
  assert.equal(writes(unlocked)[0].access.ordering, undefined);
});

const cfgPlugin = Object.freeze({
  classifyControlFlow(instruction) { return instruction.control || 'fallthrough'; },
  directControlTarget(instruction) {
    const operand = instruction?.detail?.operands?.[0];
    return operand?.type === 'immediate' && operand.value != null ? BigInt(operand.value) : null;
  },
});

function cfgInsn(address, length, control = 'fallthrough', target = null) {
  return {
    address:BigInt(address),
    length,
    control,
    detail:{ operands:target == null ? [] : [{ type:'immediate', value:BigInt(target) }] },
  };
}

function blockAt(blocks, address) {
  return blocks.find((block) => block.startAddress === BigInt(address));
}

test('#795 conditional branch does not invent false fallthrough across a decode gap', () => {
  const blocks = partitionDecodedFunction([
    cfgInsn(0x100, 2, 'conditional-branch', 0x200),
    cfgInsn(0x200, 1, 'return'),
  ], cfgPlugin);
  const branch = blockAt(blocks, 0x100);
  assert.deepEqual(branch.successors, [{ to:'block-200', kind:'conditional-true' }]);
});

test('#795 exact physical conditional fallthrough is preserved when decoded', () => {
  const blocks = partitionDecodedFunction([
    cfgInsn(0x100, 2, 'conditional-branch', 0x200),
    cfgInsn(0x102, 1, 'return'),
    cfgInsn(0x200, 1, 'return'),
  ], cfgPlugin);
  const branch = blockAt(blocks, 0x100);
  assert.deepEqual(branch.successors, [
    { to:'block-200', kind:'conditional-true' },
    { to:'block-102', kind:'conditional-false' },
  ]);
});

test('#795 ordinary fallthrough does not jump to the next enumerated disjoint block', () => {
  const blocks = partitionDecodedFunction([
    cfgInsn(0x80, 2, 'conditional-branch', 0x200),
    cfgInsn(0x100, 4, 'fallthrough'),
    cfgInsn(0x200, 1, 'return'),
  ], cfgPlugin);
  const disjoint = blockAt(blocks, 0x100);
  assert.deepEqual(disjoint.successors, []);
});

test('#795 contiguous ordinary fallthrough connects to an exact decoded block boundary', () => {
  const blocks = partitionDecodedFunction([
    // The first conditional branch makes both 0x100 and its target 0x104 block starts.
    cfgInsn(0x80, 2, 'conditional-branch', 0x104),
    cfgInsn(0x100, 4, 'fallthrough'),
    cfgInsn(0x104, 1, 'return'),
  ], cfgPlugin);
  const contiguous = blockAt(blocks, 0x100);
  assert.deepEqual(contiguous.successors, [{ to:'block-104', kind:'fallthrough' }]);
});