import assert from 'node:assert/strict';
import { Emulator } from '../../js/emu.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues, constOf } from '../../js/expr.js';
import { MK, mustAlias, mayAliasProvenance } from '../../js/ir.js';

async function executeUnaryFlags() {
  const emu = new Emulator({});
  const cases = [
    { reg: 'w1', dst: 'w0', bits: 32, value: 0n, out: 0n, flags: { n: false, z: true, c: true, v: false } },
    { reg: 'w1', dst: 'w0', bits: 32, value: 1n, out: 0xffffffffn, flags: { n: true, z: false, c: false, v: false } },
    { reg: 'w1', dst: 'w0', bits: 32, value: 0x80000000n, out: 0x80000000n, flags: { n: true, z: false, c: false, v: true } },
    { reg: 'x1', dst: 'x0', bits: 64, value: 0x8000000000000000n, out: 0x8000000000000000n, flags: { n: true, z: false, c: false, v: true } },
  ];
  for (const entry of cases) {
    emu.reset();
    emu.set(entry.reg, entry.value);
    await emu.execute('negs', `${entry.dst}, ${entry.reg}`, 0n);
    assert.equal(emu.get(entry.dst), entry.out, `NEGS ${entry.bits}-bit result`);
    assert.deepEqual(emu.nzcv, entry.flags, `NEGS ${entry.bits}-bit NZCV for ${entry.value.toString(16)}`);
  }

  emu.reset();
  emu.set('w1', 1n);
  emu.nzcv = { n: false, z: true, c: true, v: true };
  const before = { ...emu.nzcv };
  await emu.execute('neg', 'w0, w1', 0n);
  assert.deepEqual(emu.nzcv, before, 'NEG must not alter NZCV');

  emu.reset();
  emu.set('w1', 1n);
  await emu.execute('negs', 'w0, w1', 0n);
  assert.equal(emu.cond('mi'), true);
  assert.equal(emu.cond('cc'), true);
  assert.equal(emu.cond('eq'), false);
  emu.reset();
  emu.set('w1', 0x80000000n);
  await emu.execute('negs', 'w0, w1', 0n);
  assert.equal(emu.cond('vs'), true, 'NEGS overflow must drive VS');
}

function applyBinary(op, a, b, bits) {
  let value;
  if (op === 'add') value = a + b;
  else if (op === 'sub') value = a - b;
  else if (op === 'and') value = a & b;
  else if (op === 'orr') value = a | b;
  else if (op === 'eor') value = a ^ b;
  else throw new Error(`unknown test operation ${op}`);
  return BigInt.asUintN(bits, value);
}

async function shiftedAsrWidth() {
  for (const [bits, prefix, signBit] of [
    [32, 'w', 0x80000000n],
    [64, 'x', 0x8000000000000000n],
  ]) {
    const emu = new Emulator({});
    const a = bits === 32 ? 0x12345678n : 0x123456789abcdef0n;
    const shifted = BigInt.asIntN(bits, signBit) >> 1n;
    for (const op of ['add', 'sub', 'and', 'orr', 'eor']) {
      emu.reset();
      emu.set(`${prefix}1`, a);
      emu.set(`${prefix}2`, signBit);
      await emu.execute(op, `${prefix}0, ${prefix}1, ${prefix}2, asr #1`, 0n);
      assert.equal(
        emu.get(`${prefix}0`),
        applyBinary(op, a, shifted, bits),
        `${op} ${prefix} shifted ASR must use ${bits}-bit sign`,
      );
    }
  }

  const emu = new Emulator({});
  emu.set('w2', 0x80000000n);
  await emu.execute('add', 'w0, wzr, w2, asr #0', 0n);
  assert.equal(emu.get('w0'), 0x80000000n);
  await emu.execute('add', 'w0, wzr, w2, asr #31', 0n);
  assert.equal(emu.get('w0'), 0xffffffffn);
  emu.set('w2', 0x7ffffffen);
  await emu.execute('add', 'w0, wzr, w2, asr #1', 0n);
  assert.equal(emu.get('w0'), 0x3fffffffn);
  emu.set('x2', 0x8000000000000000n);
  await emu.execute('add', 'x0, xzr, x2, asr #63', 0n);
  assert.equal(emu.get('x0'), 0xffffffffffffffffn);
}

const BASE = 0x100000000n;
function asm(lines) {
  return lines.map((line, row) => {
    const text = String(line).trim();
    const space = text.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row) * 4n,
      mn: space < 0 ? text : text.slice(0, space),
      ops: space < 0 ? '' : text.slice(space + 1).trim(),
    };
  });
}
function expressionConstant(lines, row, register) {
  const instructions = asm(lines);
  const model = buildSemanticModel(instructions, { startRow: 0, endRow: instructions.length - 1 });
  return constOf(buildValues(model).defAt(row, register));
}

function signedBitfieldExpressions() {
  assert.equal(expressionConstant(['mov x1, #0x80', 'sbfx x0, x1, #0, #8'], 1, 'x0'), -128n);
  assert.equal(expressionConstant(['mov x1, #0x8000', 'sbfx x0, x1, #8, #8'], 1, 'x0'), -128n);
  assert.equal(expressionConstant(['mov x1, #0x7f', 'sbfx x0, x1, #0, #8'], 1, 'x0'), 127n);
  assert.equal(expressionConstant(['mov w1, #0x80', 'sbfx w0, w1, #0, #8'], 1, 'x0'), 0xffffff80n);
  assert.equal(expressionConstant(['mov x1, #0xffffffffffffffff', 'sbfx x0, x1, #0, #64'], 1, 'x0'), -1n);
  assert.equal(expressionConstant(['mov x1, #0x80', 'ubfx x0, x1, #0, #8'], 1, 'x0'), 128n, 'UBFX must stay zero-extended');
}

function aliasUnknownSizeSafety() {
  const stack = (disp, size) => ({ kind: MK.STACK, disp: BigInt(disp), size });
  const global = (address, size) => ({ kind: MK.GLOBAL, address: BigInt(address), size });

  assert.equal(mustAlias(stack(0, null), stack(0, 4)), false, 'unknown stack size cannot prove MustAlias');
  assert.equal(mustAlias(global(0x1000, null), global(0x1000, 8)), false, 'unknown global size cannot prove MustAlias');
  assert.equal(mayAliasProvenance(stack(0, null), stack(64, 4)), true, 'unknown stack size cannot prove NoAlias');
  assert.equal(mayAliasProvenance(global(0x1000, null), global(0x2000, 8)), true, 'unknown global size cannot prove NoAlias');

  assert.equal(mustAlias(stack(0, 4), stack(0, 4)), true, 'known identical stack access remains MustAlias');
  assert.equal(mustAlias(global(0x1000, 8), global(0x1000, 8)), true, 'known identical global access remains MustAlias');
  assert.equal(mayAliasProvenance(stack(0, 4), stack(4, 4)), false, 'known disjoint stack ranges remain NoAlias');
  assert.equal(mayAliasProvenance(global(0x1000, 8), global(0x1008, 8)), false, 'known disjoint global ranges remain NoAlias');
}

await executeUnaryFlags();
await shiftedAsrWidth();
signedBitfieldExpressions();
aliasUnknownSizeSafety();
console.log('issues 802/821/824/859 correctness regressions: PASS');
