import assert from 'node:assert/strict';
import test from 'node:test';

import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { evaluateBundle, liftBytes, s64, u64 } from './helpers.mjs';

function bType(funct3, rs1, rs2, offset) {
  const imm = offset >>> 0;
  const word = ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15)
    | (funct3 << 12) | ((((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7)) | 0x63) >>> 0;
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}
function iType(opcode, rd, funct3, rs1, imm) {
  const word = ((((imm & 0xfff) >>> 0) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}
function sType(funct3, rs1, rs2, imm) {
  const word = ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}

const BRANCHES = Object.freeze([
  { name: 'beq', funct3: 0, predicate: 'eq', reference: (a, b) => a === b },
  { name: 'bne', funct3: 1, predicate: 'ne', reference: (a, b) => a !== b },
  { name: 'blt', funct3: 4, predicate: 'slt', reference: (a, b) => s64(a) < s64(b) },
  { name: 'bge', funct3: 5, predicate: 'sge', reference: (a, b) => s64(a) >= s64(b) },
  { name: 'bltu', funct3: 6, predicate: 'ult', reference: (a, b) => a < b },
  { name: 'bgeu', funct3: 7, predicate: 'uge', reference: (a, b) => a >= b },
]);

test('conditional branches compare registers directly and never touch flag state', () => {
  const samples = [0n, 1n, u64(-1n), 1n << 63n, (1n << 63n) - 1n, 42n];
  for (const branch of BRANCHES) {
    const { bundle } = liftBytes(bType(branch.funct3, 11, 12, 8), 0x1000n);
    assert.ok(bundle, `${branch.name} must lift`);
    assert.equal(bundle.completeness, 'exact');
    assert.equal(bundle.controlEffect.kind, 'conditional-branch');
    assert.equal(BigInt(bundle.controlEffect.target.value), 0x1008n, 'taken target is pc + sext(imm)');
    assert.equal(BigInt(bundle.controlEffect.fallthrough.value), 0x1004n, 'fallthrough is the next instruction');
    assert.equal(bundle.metadata.flagsRegisterUsed, false);
    assert.equal(bundle.operations.filter((o) => o.kind === 'flag-read' || o.kind === 'flag-write').length, 0);
    assert.equal(bundle.operations.filter((o) => o.kind === 'register-write').length, 0, 'a branch writes no register');

    // The condition is a value produced by this instruction, so it can be
    // evaluated directly. Nothing has to remember previously computed flags.
    const conditionId = bundle.controlEffect.condition.temporaryId;
    assert.ok(conditionId, 'the branch condition must be an explicit value');
    for (const a of samples) {
      for (const b of samples) {
        const { temporaries } = evaluateBundle(bundle, { x11: a, x12: b });
        const actual = temporaries.get(conditionId) === 1n;
        assert.equal(actual, branch.reference(a, b), `${branch.name}(0x${a.toString(16)}, 0x${b.toString(16)})`);
      }
    }
  }
});

test('jal and jalr separate architectural linking from calling convention', () => {
  const plugin = architecturePluginV2('riscv64');
  const jalWord = (rd, offset) => {
    const imm = offset >>> 0;
    const word = ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20)
      | (((imm >> 12) & 0xff) << 12) | (rd << 7) | 0x6f) >>> 0;
    return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
  };

  // jal ra, +16 links, so it is architecturally a call.
  const call = liftBytes(jalWord(1, 16), 0x1000n);
  assert.equal(call.bundle.controlEffect.kind, 'call');
  assert.equal(BigInt(call.bundle.controlEffect.target.value), 0x1010n);
  assert.equal(evaluateBundle(call.bundle).registers.get('x1'), 0x1004n, 'the link value is the address after the instruction');
  assert.equal(call.bundle.metadata.abiSemantics, false, 'instruction semantics must not encode ABI policy');
  assert.equal(plugin.classifyControlFlow(call.decoded), 'call');

  // jal x0, +16 creates no link, so it is a plain jump even though it prints alike.
  const jump = liftBytes(jalWord(0, 16), 0x1000n);
  assert.equal(jump.bundle.controlEffect.kind, 'branch');
  assert.equal(jump.bundle.operations.filter((o) => o.kind === 'register-write').length, 0);
  assert.equal(plugin.classifyControlFlow(jump.decoded), 'branch');

  // jalr x0, 0(ra) is the ISA's return-address-stack pop hint.
  const ret = liftBytes(iType(0x67, 0, 0, 1, 0), 0x1000n);
  assert.equal(ret.bundle.controlEffect.kind, 'return');
  assert.equal(ret.bundle.metadata.returnAddressStackHint, 'x1');
  assert.equal(plugin.classifyControlFlow(ret.decoded), 'return');

  // jalr x0, 0(a0) is an ordinary indirect jump, not a return.
  const indirect = liftBytes(iType(0x67, 0, 0, 10, 0), 0x1000n);
  assert.equal(indirect.bundle.controlEffect.kind, 'indirect');
  assert.equal(indirect.bundle.metadata.returnAddressStackHint, null);

  // jalr ra, 8(a0) links, so it is an indirect call.
  const indirectCall = liftBytes(iType(0x67, 1, 0, 10, 8), 0x1000n);
  assert.equal(indirectCall.bundle.controlEffect.kind, 'call');
  assert.equal(indirectCall.bundle.metadata.linkRegister, 'x1');
});

test('jalr clears the low bit of the computed target, as the ISA requires', () => {
  const { bundle } = liftBytes(iType(0x67, 0, 0, 10, 3), 0x1000n);
  const targetId = bundle.controlEffect.target.temporaryId;
  const { temporaries } = evaluateBundle(bundle, { x10: 0x2000n });
  assert.equal(temporaries.get(targetId), 0x2002n, '0x2000 + 3 with bit 0 cleared is 0x2002');
});

test('loads and stores keep exact width, extension and address provenance', () => {
  const loads = [
    { name: 'lb', funct3: 0, width: 8, signed: true },
    { name: 'lh', funct3: 1, width: 16, signed: true },
    { name: 'lw', funct3: 2, width: 32, signed: true },
    { name: 'ld', funct3: 3, width: 64, signed: true },
    { name: 'lbu', funct3: 4, width: 8, signed: false },
    { name: 'lhu', funct3: 5, width: 16, signed: false },
    { name: 'lwu', funct3: 6, width: 32, signed: false },
  ];
  for (const load of loads) {
    const { bundle } = liftBytes(iType(0x03, 10, load.funct3, 11, 12));
    assert.equal(bundle.completeness, 'exact', load.name);
    const read = bundle.operations.find((o) => o.kind === 'memory-read');
    assert.ok(read, `${load.name} must emit a memory read`);
    assert.equal(read.access.widthBits, load.width);
    assert.equal(read.access.endian, 'little');
    assert.equal(read.access.space, 'memory');
    assert.equal(bundle.metadata.resultExtension, load.signed ? 'sign-extend' : 'zero-extend');
    // Alignment is not proven, so the fault must stay explicit.
    assert.equal(read.access.alignment, undefined);
    assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'memory-access-fault'));
    const address = bundle.operations.find((o) => o.kind === 'value' && o.metadata?.addressArithmetic === 'base-plus-displacement');
    assert.ok(address, 'the effective address must be an explicit value with provenance');
    assert.equal(address.metadata.baseRegister, 'x11');
    assert.equal(address.metadata.displacement, '12');
  }

  const stores = [
    { name: 'sb', funct3: 0, width: 8 },
    { name: 'sh', funct3: 1, width: 16 },
    { name: 'sw', funct3: 2, width: 32 },
    { name: 'sd', funct3: 3, width: 64 },
  ];
  for (const store of stores) {
    const { bundle } = liftBytes(sType(store.funct3, 11, 12, 8));
    assert.equal(bundle.completeness, 'exact', store.name);
    const write = bundle.operations.find((o) => o.kind === 'memory-write');
    assert.ok(write, `${store.name} must emit a memory write`);
    assert.equal(write.access.widthBits, store.width);
    assert.equal(bundle.operations.filter((o) => o.kind === 'register-write').length, 0, 'a store writes no register');
  }
});

test('environment calls stay explicitly partial instead of becoming state-preserving nops', () => {
  for (const [name, bytes] of [['ecall', [0x73, 0x00, 0x00, 0x00]], ['ebreak', [0x73, 0x00, 0x10, 0x00]]]) {
    const { bundle } = liftBytes(bytes);
    assert.equal(bundle.completeness, 'partial', `${name} must not claim exactness`);
    assert.equal(bundle.controlEffect.kind, 'trap');
    assert.equal(bundle.unknownEffects.preservation, 'not-assumed');
    for (const category of ['registers', 'memory', 'control']) {
      assert.ok(bundle.unknownEffects.categories.includes(category), `${name} must not assume ${category} are preserved`);
    }
    assert.equal(bundle.statePreservation, undefined);
  }
});

test('fence records its exact predecessor and successor sets', () => {
  // fence rw, rw
  const { bundle } = liftBytes([0x0f, 0x00, 0x30, 0x03]);
  assert.equal(bundle.completeness, 'exact');
  const barrier = bundle.operations.find((o) => o.kind === 'barrier');
  assert.ok(barrier);
  assert.deepEqual(barrier.scope.predecessor, ['read', 'write']);
  assert.deepEqual(barrier.scope.successor, ['read', 'write']);
});
