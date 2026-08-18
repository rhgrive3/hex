import assert from 'node:assert/strict';
import test from 'node:test';

import { MASK64, evaluateBundle, liftBytes, s64, sampleValues, u64 } from './helpers.mjs';

/**
 * Differential test of the RV64 lifter against an independent reference model.
 *
 * The reference below is written straight from the RISC-V Unprivileged ISA
 * definitions and shares no code with the lifter. The evaluator in helpers.mjs
 * understands only the generic MachineEffects vocabulary. So a passing case
 * means "the emitted effects compute what the ISA says", not "the lifter agrees
 * with itself".
 */

/** Encode an R-type instruction word. */
function rType(opcode, rd, funct3, rs1, rs2, funct7) {
  const word = (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode;
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}
/** Encode an I-type instruction word. */
function iType(opcode, rd, funct3, rs1, imm) {
  const word = (((imm & 0xfff) >>> 0) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode;
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}

const RD = 10; // a0
const RS1 = 11; // a1
const RS2 = 12; // a2

const sext32 = (value) => u64(BigInt.asIntN(32, BigInt(value)));
const low32 = (value) => BigInt.asUintN(32, BigInt(value));

/* Reference semantics, transcribed from the ISA, keyed by encoding. */
const REGISTER_CASES = Object.freeze([
  { name: 'add', bytes: rType(0x33, RD, 0, RS1, RS2, 0x00), reference: (a, b) => u64(a + b) },
  { name: 'sub', bytes: rType(0x33, RD, 0, RS1, RS2, 0x20), reference: (a, b) => u64(a - b) },
  { name: 'and', bytes: rType(0x33, RD, 7, RS1, RS2, 0x00), reference: (a, b) => a & b },
  { name: 'or', bytes: rType(0x33, RD, 6, RS1, RS2, 0x00), reference: (a, b) => a | b },
  { name: 'xor', bytes: rType(0x33, RD, 4, RS1, RS2, 0x00), reference: (a, b) => a ^ b },
  { name: 'sll', bytes: rType(0x33, RD, 1, RS1, RS2, 0x00), reference: (a, b) => u64(a << (b & 63n)) },
  { name: 'srl', bytes: rType(0x33, RD, 5, RS1, RS2, 0x00), reference: (a, b) => a >> (b & 63n) },
  { name: 'sra', bytes: rType(0x33, RD, 5, RS1, RS2, 0x20), reference: (a, b) => u64(s64(a) >> (b & 63n)) },
  { name: 'slt', bytes: rType(0x33, RD, 2, RS1, RS2, 0x00), reference: (a, b) => (s64(a) < s64(b) ? 1n : 0n) },
  { name: 'sltu', bytes: rType(0x33, RD, 3, RS1, RS2, 0x00), reference: (a, b) => (a < b ? 1n : 0n) },
  // RV64 *W forms: 32-bit result, sign-extended to XLEN.
  { name: 'addw', bytes: rType(0x3b, RD, 0, RS1, RS2, 0x00), reference: (a, b) => sext32(low32(a) + low32(b)) },
  { name: 'subw', bytes: rType(0x3b, RD, 0, RS1, RS2, 0x20), reference: (a, b) => sext32(low32(a) - low32(b)) },
  { name: 'sllw', bytes: rType(0x3b, RD, 1, RS1, RS2, 0x00), reference: (a, b) => sext32(low32(a) << (b & 31n)) },
  { name: 'srlw', bytes: rType(0x3b, RD, 5, RS1, RS2, 0x00), reference: (a, b) => sext32(low32(a) >> (b & 31n)) },
  { name: 'sraw', bytes: rType(0x3b, RD, 5, RS1, RS2, 0x20), reference: (a, b) => sext32(BigInt.asIntN(32, low32(a)) >> (b & 31n)) },
  // "M" standard extension.
  { name: 'mul', bytes: rType(0x33, RD, 0, RS1, RS2, 0x01), reference: (a, b) => u64(a * b) },
  { name: 'mulh', bytes: rType(0x33, RD, 1, RS1, RS2, 0x01), reference: (a, b) => u64((s64(a) * s64(b)) >> 64n) },
  { name: 'mulhu', bytes: rType(0x33, RD, 3, RS1, RS2, 0x01), reference: (a, b) => u64((a * b) >> 64n) },
  { name: 'mulhsu', bytes: rType(0x33, RD, 2, RS1, RS2, 0x01), reference: (a, b) => u64((s64(a) * b) >> 64n) },
  { name: 'mulw', bytes: rType(0x3b, RD, 0, RS1, RS2, 0x01), reference: (a, b) => sext32(low32(a) * low32(b)) },
  {
    name: 'div',
    bytes: rType(0x33, RD, 4, RS1, RS2, 0x01),
    // ISA: divide by zero yields all ones; MIN / -1 overflows to MIN. No trap.
    reference: (a, b) => (b === 0n ? MASK64 : (s64(a) === -(1n << 63n) && s64(b) === -1n) ? u64(-(1n << 63n)) : u64(s64(a) / s64(b))),
  },
  { name: 'divu', bytes: rType(0x33, RD, 5, RS1, RS2, 0x01), reference: (a, b) => (b === 0n ? MASK64 : a / b) },
  {
    name: 'rem',
    bytes: rType(0x33, RD, 6, RS1, RS2, 0x01),
    // ISA: remainder by zero yields the dividend; MIN % -1 yields 0.
    reference: (a, b) => (b === 0n ? a : (s64(a) === -(1n << 63n) && s64(b) === -1n) ? 0n : u64(s64(a) % s64(b))),
  },
  { name: 'remu', bytes: rType(0x33, RD, 7, RS1, RS2, 0x01), reference: (a, b) => (b === 0n ? a : a % b) },
  {
    name: 'divw',
    bytes: rType(0x3b, RD, 4, RS1, RS2, 0x01),
    reference: (a, b) => {
      const x = BigInt.asIntN(32, low32(a));
      const y = BigInt.asIntN(32, low32(b));
      if (y === 0n) return u64(-1n);
      if (x === -(1n << 31n) && y === -1n) return u64(-(1n << 31n));
      return sext32(x / y);
    },
  },
  {
    name: 'remw',
    bytes: rType(0x3b, RD, 6, RS1, RS2, 0x01),
    reference: (a, b) => {
      const x = BigInt.asIntN(32, low32(a));
      const y = BigInt.asIntN(32, low32(b));
      if (y === 0n) return sext32(x);
      if (x === -(1n << 31n) && y === -1n) return 0n;
      return sext32(x % y);
    },
  },
]);

test('RV64 register-register semantics match an independent ISA reference model', () => {
  for (const item of REGISTER_CASES) {
    const { bundle } = liftBytes(item.bytes);
    assert.ok(bundle, `${item.name} must lift`);
    assert.equal(bundle.completeness, 'exact', `${item.name} must be exact`);
    let checked = 0;
    for (const a of sampleValues(11n)) {
      for (const b of sampleValues(29n)) {
        const { registers } = evaluateBundle(bundle, { x11: a, x12: b });
        const expected = item.reference(a, b);
        assert.equal(
          registers.get('x10'),
          expected,
          `${item.name}(0x${a.toString(16)}, 0x${b.toString(16)}) = 0x${registers.get('x10')?.toString(16)}, ISA says 0x${expected.toString(16)}`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 1000, `${item.name} must be checked over a real sample (${checked})`);
  }
});

test('RV64 register-immediate semantics match an independent ISA reference model', () => {
  const immediates = [0n, 1n, -1n, 5n, -5n, 2047n, -2048n, 255n];
  const cases = [
    { name: 'addi', funct3: 0, opcode: 0x13, reference: (a, imm) => u64(a + imm) },
    { name: 'andi', funct3: 7, opcode: 0x13, reference: (a, imm) => a & u64(imm) },
    { name: 'ori', funct3: 6, opcode: 0x13, reference: (a, imm) => a | u64(imm) },
    { name: 'xori', funct3: 4, opcode: 0x13, reference: (a, imm) => a ^ u64(imm) },
    { name: 'slti', funct3: 2, opcode: 0x13, reference: (a, imm) => (s64(a) < imm ? 1n : 0n) },
    // sltiu compares against the sign-extended immediate treated as unsigned.
    { name: 'sltiu', funct3: 3, opcode: 0x13, reference: (a, imm) => (a < u64(imm) ? 1n : 0n) },
    { name: 'addiw', funct3: 0, opcode: 0x1b, reference: (a, imm) => sext32(low32(a) + u64(imm)) },
  ];
  for (const item of cases) {
    for (const imm of immediates) {
      const { bundle } = liftBytes(iType(item.opcode, RD, item.funct3, RS1, Number(imm)));
      assert.ok(bundle, `${item.name} must lift`);
      for (const a of sampleValues(7n)) {
        const { registers } = evaluateBundle(bundle, { x11: a });
        assert.equal(registers.get('x10'), item.reference(a, imm),
          `${item.name}(0x${a.toString(16)}, ${imm})`);
      }
    }
  }
});

test('shift-immediate forms mask the shift amount exactly as the ISA specifies', () => {
  for (let shamt = 0; shamt < 64; shamt += 1) {
    const slli = liftBytes(iType(0x13, RD, 1, RS1, shamt)).bundle;
    const srli = liftBytes(iType(0x13, RD, 5, RS1, shamt)).bundle;
    const srai = liftBytes(iType(0x13, RD, 5, RS1, shamt | 0x400)).bundle;
    for (const a of sampleValues(3n, 6)) {
      assert.equal(evaluateBundle(slli, { x11: a }).registers.get('x10'), u64(a << BigInt(shamt)), `slli ${shamt}`);
      assert.equal(evaluateBundle(srli, { x11: a }).registers.get('x10'), a >> BigInt(shamt), `srli ${shamt}`);
      assert.equal(evaluateBundle(srai, { x11: a }).registers.get('x10'), u64(s64(a) >> BigInt(shamt)), `srai ${shamt}`);
    }
  }
  // *W shift-immediate forms use a 5-bit amount and sign-extend the 32-bit result.
  for (let shamt = 0; shamt < 32; shamt += 1) {
    const slliw = liftBytes(iType(0x1b, RD, 1, RS1, shamt)).bundle;
    const srliw = liftBytes(iType(0x1b, RD, 5, RS1, shamt)).bundle;
    const sraiw = liftBytes(iType(0x1b, RD, 5, RS1, shamt | 0x400)).bundle;
    for (const a of sampleValues(5n, 6)) {
      assert.equal(evaluateBundle(slliw, { x11: a }).registers.get('x10'), sext32(low32(a) << BigInt(shamt)), `slliw ${shamt}`);
      assert.equal(evaluateBundle(srliw, { x11: a }).registers.get('x10'), sext32(low32(a) >> BigInt(shamt)), `srliw ${shamt}`);
      assert.equal(evaluateBundle(sraiw, { x11: a }).registers.get('x10'), sext32(BigInt.asIntN(32, low32(a)) >> BigInt(shamt)), `sraiw ${shamt}`);
    }
  }
});

test('lui and auipc form values exactly as the ISA specifies', () => {
  // lui a0, 0xfffff  -> sign-extended 0xfffff000
  const luiBytes = (() => { const word = (0xfffff << 12) | (RD << 7) | 0x37; return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff]; })();
  const lui = liftBytes(luiBytes).bundle;
  assert.equal(evaluateBundle(lui).registers.get('x10'), u64(BigInt.asIntN(32, 0xfffff000n)));

  // auipc a0, 0x10 at address 0x2000 -> 0x2000 + 0x10000
  const auipcBytes = (() => { const word = (0x10 << 12) | (RD << 7) | 0x17; return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff]; })();
  const auipc = liftBytes(auipcBytes, 0x2000n).bundle;
  assert.equal(evaluateBundle(auipc).registers.get('x10'), 0x2000n + 0x10000n);
  assert.equal(auipc.metadata.valueOrigin, 'auipc-pc-relative');
});

test('writes whose destination is x0 are discarded rather than performed', () => {
  // `add x0, a1, a2` must compute nothing observable.
  const { bundle } = liftBytes(rType(0x33, 0, 0, RS1, RS2, 0x00));
  assert.equal(bundle.completeness, 'exact');
  const { registers } = evaluateBundle(bundle, { x11: 5n, x12: 7n });
  assert.equal(registers.get('x0'), undefined, 'x0 must never receive a value');
  assert.deepEqual(bundle.metadata.discardedHardwiredZeroWrites, ['x0']);
});
