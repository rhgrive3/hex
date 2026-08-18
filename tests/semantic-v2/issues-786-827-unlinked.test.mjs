import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, mustAlias } from '../../js/ir.js';
import { symbolicExecute } from '../../js/symbolic/executor.js';
import { buildValues, bin, constNode, constOf, same } from '../../js/expr.js';

const BASE = 0x700000000n;
function asm(lines, base = BASE) {
  return lines.map((line, row) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return { row, address: base + BigInt(row) * 4n, mn: sp < 0 ? s : s.slice(0, sp), ops: sp < 0 ? '' : s.slice(sp + 1).trim() };
  });
}
function model(lines, base = BASE) {
  const rows = asm(lines, base);
  const rowOfAddress = (addr) => {
    const rel = addr - base;
    return rel < 0n || rel >= BigInt(lines.length) * 4n ? null : Number(rel / 4n);
  };
  return { model: buildSemanticModel(rows, { startRow:0, endRow:lines.length - 1, rowOfAddress }), rowOfAddress };
}
function built(lines, base = BASE) {
  const m = model(lines, base);
  return { ...m, ir: buildIR(m.model, { rowOfAddress:m.rowOfAddress }) };
}

// #789: SDIV/UDIV by zero return architectural zero; widths control signedness.
assert.equal(constOf(bin('sdiv', constNode(123n), constNode(0n), 32)), 0n);
assert.equal(constOf(bin('udiv', constNode(123n), constNode(0n), 64)), 0n);
assert.equal(constOf(bin('sdiv', constNode(0x80000000n), constNode(-1n), 32)), -0x80000000n);
assert.equal(BigInt.asUintN(64, constOf(bin('udiv', constNode(-1n), constNode(1n), 64))), (1n << 64n) - 1n);

// #786: signed LT/GE and unsigned LO/HS diverge for the same bit pattern.
function branchRun(cond, bits, lhs, rhs) {
  const r0 = bits === 32 ? 'w0' : 'x0';
  const r1 = bits === 32 ? 'w1' : 'x1';
  const lines = [
    `cmp ${r0}, ${r1}`,
    `b.${cond} #0x${(BASE + 16n).toString(16)}`,
    'mov w2, #0',
    `b #0x${(BASE + 20n).toString(16)}`,
    'mov w2, #1',
    'ret',
  ];
  const { ir } = built(lines);
  return symbolicExecute(ir, { symbolicArgs:{ 0:lhs, 1:rhs }, maxPaths:4, maxSteps:128, timeoutMs:1000 });
}
const signed32 = branchRun('lt', 32, 0xffffffffn, 0n);
assert.equal(signed32.paths.length, 1);
assert.equal(signed32.paths[0].takenBranches[0]?.taken, true);
const unsigned32 = branchRun('lo', 32, 0xffffffffn, 0n);
assert.equal(unsigned32.paths.length, 1);
assert.equal(unsigned32.paths[0].takenBranches[0]?.taken, false);
const signed64 = branchRun('ge', 64, 0xffffffffffffffffn, 0n);
assert.equal(signed64.paths.length, 1);
assert.equal(signed64.paths[0].takenBranches[0]?.taken, false);
const unsigned64 = branchRun('hs', 64, 0xffffffffffffffffn, 0n);
assert.equal(unsigned64.paths.length, 1);
assert.equal(unsigned64.paths[0].takenBranches[0]?.taken, true);

// #788: a store through another unresolved FIELD root may alias and kills stale remembered values.
{
  const { ir } = built([
    'str w2, [x0]',
    'str w3, [x1]',
    'ldr w4, [x0]',
    'str w4, [x5]',
    'ret',
  ]);
  const out = symbolicExecute(ir, { symbolicArgs:{ 2:7n, 3:9n }, maxSteps:128, timeoutMs:1000 });
  assert.equal(out.paths.length, 1);
  const writes = out.paths[0].touchedFields;
  assert.ok(writes.length >= 3);
  assert.notEqual(writes.at(-1).valueText, '7', 'may-alias store must invalidate x0-root remembered value');
}

// #819: memory occurrence identity persists only across no-clobber paths.
{
  const { model:m } = model(['ldr w8, [x0]', 'ldr w9, [x0]', 'str w1, [x1]', 'ldr w10, [x0]', 'ret']);
  const values = buildValues(m);
  const a = values.defAt(0, 'x8'), b = values.defAt(1, 'x9'), c = values.defAt(3, 'x10');
  assert.equal(same(a, b), true, 'no-clobber loads should retain the same memory identity');
  assert.equal(same(a, c), false, 'intervening store must advance memory identity');
}
{
  const { model:m } = model(['ldr w8, [x0]', 'bl #0x700000010', 'ldr w9, [x0]', 'ret']);
  const values = buildValues(m);
  assert.equal(same(values.defAt(0, 'x8'), values.defAt(2, 'x9')), false, 'call must advance memory identity');
}
{
  const { model:m } = model(['ldr w8, [x0]', 'ldr w9, [x0]', 'ret']);
  m.instructions[0].memory.volatile = true;
  m.instructions[1].memory.volatile = true;
  const values = buildValues(m);
  assert.equal(same(values.defAt(0, 'x8'), values.defAt(1, 'x9')), false, 'volatile loads are distinct occurrences');
}

// #820: stack forwarding is exact-width and overlap-aware.
{
  const { model:m } = model(['str x0, [sp, #0]', 'ldr w1, [sp, #0]', 'ret']);
  const v = buildValues(m);
  assert.equal(same(v.at(0, 'x0'), v.defAt(1, 'x1')), false, '8-byte store must not forward as a 4-byte load');
}
{
  const { model:m } = model(['str x0, [sp, #0]', 'str w1, [sp, #4]', 'ldr x2, [sp, #0]', 'ret']);
  const v = buildValues(m);
  assert.equal(same(v.at(0, 'x0'), v.defAt(2, 'x2')), false, 'partial overlap invalidates wider slot');
}
{
  const { model:m } = model(['str x0, [sp, #0]', 'str w1, [sp, #8]', 'ldr x2, [sp, #0]', 'ret']);
  const v = buildValues(m);
  assert.equal(same(v.at(0, 'x0'), v.defAt(2, 'x2')), true, 'disjoint stack store preserves exact slot');
}
{
  const { model:m } = model(['stp x0, x1, [sp, #0]', 'ldr x2, [sp, #8]', 'ret']);
  const v = buildValues(m);
  assert.equal(same(v.at(0, 'x1'), v.defAt(1, 'x2')), true, 'pair store tracks each element interval');
}

// #822: legacy flag reconstruction is exact only when the predicate follows from represented data.
{
  const { model:m } = model(['adds w8, w0, w1', 'csel w2, w3, w4, hs', 'ret']);
  const v = buildValues(m);
  assert.equal(v.defAt(1, 'x2').cmp, null, 'ADDS carry condition must remain unknown in legacy expr');
}
{
  const { model:m } = model(['adds w8, w0, w1', 'csel w2, w3, w4, eq', 'ret']);
  const v = buildValues(m);
  assert.ok(v.defAt(1, 'x2').cmp?.a, 'ADDS EQ is exactly result==0');
}
{
  const { model:m } = model(['bics w8, w0, w1', 'csel w2, w3, w4, eq', 'ret']);
  const v = buildValues(m);
  const result = v.defAt(1, 'x2').cmp?.a;
  assert.equal(result?.op, 'and');
  assert.equal(result?.b?.op, 'not', 'BICS flags come from A & ~B');
}
{
  const { model:m } = model(['subs w8, w0, w1', 'csel w2, w3, w4, hs', 'ret']);
  const v = buildValues(m);
  assert.ok(v.defAt(1, 'x2').cmp?.a, 'SUBS retains exact compare semantics');
}

// #827: all restored stack locations use the total SP-relative coordinate.
{
  const { ir } = built([
    'add x29, sp, #16',
    'str x0, [x29, #-8]',
    'ldr x1, [sp, #8]',
    'ldr x2, [sp, #-8]',
    'ret',
  ]);
  const store = ir.instructions.find((i) => i.op === OP.STORE);
  const loads = ir.instructions.filter((i) => i.op === OP.LOAD);
  assert.equal(store.loc.disp, 8n);
  assert.equal(loads[0].loc.disp, 8n);
  assert.equal(loads[1].loc.disp, -8n);
  assert.equal(mustAlias(store.loc, loads[0].loc), true);
  assert.equal(mustAlias(store.loc, loads[1].loc), false);
}

console.log('issues #786 #788 #789 #819 #820 #822 #827 regressions: ok');
