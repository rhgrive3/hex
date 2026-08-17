import assert from 'node:assert/strict';
import test from 'node:test';

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

test('LOCKed cross-lane memory RMW is atomic but ordering is explicit partial, never guessed seq-cst', () => {
  const { bundle } = lift({ family:'adc', prefixes:[0xf0], operands:[mem({ base:'rax', widthBits:64, access:'read-write' }), reg('rbx', 64, 'read')] });
  assert.equal(bundle.completeness, 'partial');
  assert.match(bundle.unknownEffects.reason, /ordering-not-representable/);
  assert.equal(bundle.metadata.orderingMapping, 'unmapped-not-seq-cst');
  assert.equal(reads(bundle)[0].access.atomic, true);
  assert.equal(writes(bundle)[0].access.atomic, true);
  assert.equal(reads(bundle)[0].access.ordering, undefined);
  assert.equal(writes(bundle)[0].access.ordering, undefined);
});
