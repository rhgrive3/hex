import assert from 'node:assert/strict';
import test from 'node:test';

import { executeFunction, imageMemory, layeredMemory, s64, u64 } from '../effects/helpers.mjs';
import { parseELF } from '../../../js/binary/elf.js';
import { buildPhase6VerificationCorpus } from '../../../tools/validation/phase6/build-verification-corpus.mjs';
import { parseLlvmObjdump } from '../../../tools/validation/phase6/llvm-oracle.mjs';
import { liftRiscv64MachineEffects } from '../../../js/targets/architecture/riscv64/effects/index.js';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

/**
 * Source-level semantic equivalence on real RISC-V compiler output.
 *
 * The mandatory corpus gate proves the pipeline completes with exact effects.
 * That is necessary but not sufficient: effects can be exact-shaped and still
 * compute the wrong value. So this test takes the *actual compiled machine
 * code* for each corpus function, executes the lifted MachineEffects through a
 * generic interpreter that knows nothing about RISC-V, and compares the result
 * against the behaviour of the C the corpus was compiled from -- transcribed
 * here independently of both the compiler and the lifter.
 *
 * Every optimization level is checked, so a lifting bug that only shows up in
 * an optimized instruction selection cannot hide behind -O0.
 */

const MASK32 = 0xffffffffn;
const low32 = (value) => BigInt.asUintN(32, BigInt(value));
const sext32 = (value) => u64(BigInt.asIntN(32, BigInt(value)));

/* The C source's meaning, written out again from tests/phase6/corpus/source/p6-corpus.c. */
const CASES = Object.freeze([
  {
    symbol: 'p6_scalar_integer_arithmetic',
    arguments: (a, b) => ({ x10: a, x11: b }),
    reference: (a, b) => u64(((a + b) ^ (a - b)) + (a | b)),
  },
  {
    symbol: 'p6_signed_unsigned_comparison',
    arguments: (a, b, c, d) => ({ x10: a, x11: b, x12: c, x13: d }),
    reference: (a, b, c, d) => {
      let r = 0n;
      if (s64(a) < s64(b)) r += 1n;
      if (s64(a) >= s64(b)) r += 2n;
      if (c < d) r += 4n;
      if (c >= d) r += 8n;
      if (s64(a) < 7n) r += 16n;
      if (c < 9n) r += 32n;
      return u64(r);
    },
  },
  {
    symbol: 'p6_conditional_branch_without_flags',
    arguments: (a, b, c) => ({ x10: a, x11: b, x12: c }),
    reference: (a, b, c) => {
      if (a === b) return 1n;
      if (s64(a) < s64(b)) return 2n;
      if (c >= 100n) return 3n;
      return 4n;
    },
  },
  {
    symbol: 'p6_switch_like_control_flow',
    arguments: (selector, value) => ({ x10: selector, x11: value }),
    reference: (selector, value) => {
      switch (Number(BigInt.asIntN(32, low32(selector)))) {
        case 0: return u64(value + 1n);
        case 1: return u64(value - 2n);
        case 2: return u64(value * 3n);
        case 3: return u64(value ^ 4n);
        case 4: return u64(value | 5n);
        case 5: return u64(value & 6n);
        case 6: return u64(value << 1n);
        case 7: return u64(s64(value) >> 2n);
        default: return u64(value);
      }
    },
  },
  {
    symbol: 'p6_return_values',
    arguments: (a, b) => ({ x10: a, x11: b }),
    reference: (a, b) => (s64(a) > s64(b) ? u64(a - b) : s64(a) < s64(b) ? u64(b - a) : 0n),
  },
  {
    symbol: 'p6_rv64_w_suffix_operations',
    // The C function takes i32/u32; the psABI passes them sign-extended.
    arguments: (a, b, c) => ({ x10: sext32(a), x11: sext32(b), x12: sext32(c) }),
    reference: (a, b, c) => {
      const x = BigInt.asIntN(32, low32(a));
      const y = BigInt.asIntN(32, low32(b));
      const z = low32(c);
      const shift = y & 31n;
      const sum = BigInt.asIntN(32, x + y);
      const difference = BigInt.asIntN(32, x - y);
      const product = BigInt.asIntN(32, x * y);
      const shifted = BigInt.asIntN(32, x << shift);
      const logical = BigInt.asIntN(32, (z >> shift) & MASK32);
      const arithmetic = BigInt.asIntN(32, x >> shift);
      return sext32(sum ^ difference ^ product ^ shifted ^ logical ^ arithmetic);
    },
  },
  {
    symbol: 'p6_shifts',
    arguments: (a, b, amount) => ({ x10: a, x11: b, x12: amount }),
    reference: (a, b, amount) => {
      const shift = amount & 63n;
      return u64(u64(a << shift) + (b >> shift) + u64(s64(a) >> shift)
        + u64(a << 5n) + (b >> 7n) + u64(s64(a) >> 9n));
    },
  },
  {
    symbol: 'p6_multiplication_and_division',
    arguments: (a, b, c, d) => ({ x10: a, x11: b, x12: c, x13: d }),
    reference: (a, b, c, d) => {
      const product = u64(a * b);
      // The C source guards division, so the RISC-V defined-edge-case results
      // are not reachable here; that behaviour is covered by the ISA reference
      // differential in tests/phase6/effects/integer-reference.test.mjs.
      const quotient = b === 0n ? 0n : u64(s64(a) / s64(b));
      const remainder = b === 0n ? 0n : u64(s64(a) % s64(b));
      const unsignedQuotient = d === 0n ? 0n : c / d;
      const unsignedRemainder = d === 0n ? 0n : c % d;
      return u64(product + quotient + remainder + unsignedQuotient + unsignedRemainder);
    },
  },
  {
    symbol: 'p6_compressed_instruction_mix',
    arguments: (a, b) => ({ x10: a, x11: b }),
    reference: (a, b) => {
      let t = u64(a + b);
      t = u64(t + 1n);
      t = u64(t - 1n);
      t = u64(t + t);
      t = t ^ b;
      t &= 0x7fn;
      return t;
    },
  },
  {
    symbol: 'p6_hardwired_zero_register',
    arguments: (a) => ({ x10: a }),
    reference: (a) => {
      if (a === 0n) return 0n;
      return u64(u64(-a) + 0n + 1n);
    },
  },
  {
    symbol: 'p6_multiple_arguments',
    arguments: (...values) => Object.fromEntries(values.map((value, index) => [`x${10 + index}`, value])),
    reference: (...v) => u64(v[0] + v[1] * 2n + v[2] * 3n + v[3] * 4n + v[4] * 5n + v[5] * 6n + v[6] * 7n + v[7] * 8n),
  },
]);

/* Deterministic inputs, including the boundary values that break naive lifting. */
const SAMPLES = Object.freeze([
  0n, 1n, 2n, 3n, 7n, 8n, 100n, 101n,
  u64(-1n), u64(-2n), u64(-100n),
  1n << 31n, (1n << 31n) - 1n, 1n << 32n,
  1n << 63n, (1n << 63n) - 1n, u64(-(1n << 63n)),
  0x0123456789abcdefn, 0xfedcba9876543210n,
]);

function inputTuples(arity, seed) {
  const tuples = [];
  for (let index = 0; index < SAMPLES.length; index += 1) {
    const tuple = [];
    for (let position = 0; position < arity; position += 1) {
      tuple.push(SAMPLES[(index + position * 5 + seed) % SAMPLES.length]);
    }
    tuples.push(tuple);
  }
  // Plus every ordered pair of the small values, which is where control flow bites.
  const small = [0n, 1n, 2n, 7n, 100n, u64(-1n)];
  for (const first of small) {
    for (const second of small) {
      tuples.push(Array.from({ length: arity }, (_value, position) => (position === 0 ? first : position === 1 ? second : SAMPLES[(position + seed) % SAMPLES.length])));
    }
  }
  return tuples;
}

test('lifted RV64 effects reproduce the C source semantics on real compiler output at every optimization level', async () => {
  const corpus = buildPhase6VerificationCorpus();
  const capstone = await createCapstoneRiscv64Session();
  const ledger = [];
  try {
    for (const fixture of corpus.fixtures) {
      const oracle = parseLlvmObjdump(fixture.disassembly);
      // Map the real image so jump tables and globals read correctly.
      const baseMemory = imageMemory(parseELF(new Uint8Array(fixture.bytes)), new Uint8Array(fixture.bytes));
      for (const item of CASES) {
        const functionOracle = oracle.get(item.symbol);
        assert.ok(functionOracle?.instructions?.length, `${fixture.id}: missing ${item.symbol}`);

        const bundlesByAddress = new Map();
        for (const decoded of capstone.decode(functionOracle.bytes, functionOracle.address)) {
          const instructionId = `p6:${fixture.id}:${item.symbol}:${decoded.address.toString(16)}`;
          const bundle = liftRiscv64MachineEffects(
            { ...decoded, instructionId, origin: { instructionIds: [instructionId], virtualRanges: [{ start: decoded.address, end: decoded.address + BigInt(decoded.size) }] } },
            { instructionId, origin: { instructionIds: [instructionId] }, mode: 'rv64imc' },
          );
          assert.ok(bundle, `${fixture.id}: ${item.symbol} failed to lift at 0x${decoded.address.toString(16)}`);
          bundlesByAddress.set(decoded.address.toString(), bundle);
        }

        const arity = item.arguments.length || item.reference.length;
        let checked = 0;
        for (const tuple of inputTuples(arity === 0 ? 8 : arity, item.symbol.length)) {
          const registers = item.arguments(...tuple);
          // The stack pointer must be a real, aligned address so that any
          // spilling the optimizer chose to do lands somewhere coherent.
          registers.x2 = 0x7fff_0000n;
          registers.x1 = 0xdead_0000n;
          const result = executeFunction(bundlesByAddress, {
            registers,
            memory: layeredMemory(baseMemory),
            entryAddress: functionOracle.address,
          });
          assert.equal(result.status, 'returned',
            `${fixture.id} ${item.symbol}: execution did not reach a return (${result.status} at 0x${result.pc.toString(16)})`);
          const actual = result.registers.get('x10');
          const expected = item.reference(...tuple);
          assert.equal(actual, expected,
            `${fixture.id} ${item.symbol}(${tuple.map((value) => `0x${value.toString(16)}`).join(', ')}) = 0x${actual?.toString(16)}, the C source says 0x${expected.toString(16)}`);
          checked += 1;
        }
        ledger.push({ fixture: fixture.id, symbol: item.symbol, checked });
      }
    }
  } finally { capstone.close(); }

  const totalChecks = ledger.reduce((sum, row) => sum + row.checked, 0);
  console.log(`P6_SOURCE_EQUIVALENCE=${JSON.stringify({
    fixtures: corpus.fixtures.length,
    functions: CASES.length,
    rows: ledger.length,
    semanticChecks: totalChecks,
  })}`);
  assert.equal(ledger.length, corpus.fixtures.length * CASES.length, 'every function must be checked in every fixture');
  assert.ok(totalChecks > 5000, `expected a substantial semantic sample, got ${totalChecks}`);
});
