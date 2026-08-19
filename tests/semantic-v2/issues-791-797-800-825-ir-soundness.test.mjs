import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  OP, MK, irFor, branchConstraints, valueRange, mustAlias, mayAliasProvenance,
} from '../../js/ir.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - BASE;
    if (delta < 0n || delta >= BigInt(rows.length * 4) || delta % 4n !== 0n) return null;
    return Number(delta / 4n);
  };
  return {
    model: buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress }),
    rowOfAddress,
  };
}

function build(lines, tag) {
  const { model, rowOfAddress } = modelOf(lines);
  const ir = irFor(model, { rowOfAddress, decoderSemanticVersion:`issue-soundness-${tag}` });
  assert.ok(ir, `${tag}: IR must build`);
  return ir;
}

function loads(ir) { return ir.instructions.filter((inst) => inst.op === OP.LOAD); }
function stores(ir) { return ir.instructions.filter((inst) => inst.op === OP.STORE); }
function firstBranchFact(ir, label = '') {
  const fact = branchConstraints(ir)[0];
  assert.ok(fact, `branch constraint must exist${label ? `: ${label}` : ''}`);
  return fact;
}

// #791 — promoted globals retain each access extent independently of iteration order.
{
  const ir = build([
    'adr x19, #0x100001000',
    'ldr w8, [x19, #0x20]',
    'ldr x9, [x19, #0x20]',
    'ret',
  ], '791-32-64');
  const [narrow, wide] = loads(ir);
  assert.equal(narrow.loc.kind, MK.GLOBAL);
  assert.equal(wide.loc.kind, MK.GLOBAL);
  assert.equal(narrow.loc.address, 0x100001020n);
  assert.equal(wide.loc.address, 0x100001020n);
  assert.equal(narrow.loc.size, 4);
  assert.equal(wide.loc.size, 8);
  assert.notEqual(narrow.loc.key, wide.loc.key);
  assert.equal(mustAlias(narrow.loc, wide.loc), false, 'different global extents are not MustAlias');
  assert.equal(mayAliasProvenance(narrow.loc, wide.loc), true, 'same-address partial overlap remains MayAlias');
}

{
  const ir = build([
    'adr x19, #0x100001000',
    'ldr x8, [x19, #0x20]',
    'ldr w9, [x19, #0x20]',
    'ret',
  ], '791-64-32');
  const [wide, narrow] = loads(ir);
  assert.equal(wide.loc.size, 8);
  assert.equal(narrow.loc.size, 4);
  assert.equal(mustAlias(wide.loc, narrow.loc), false, 'result is order independent');
  assert.equal(mayAliasProvenance(wide.loc, narrow.loc), true);
}

{
  const ir = build([
    'adr x19, #0x100001000',
    'ldr x8, [x19, #0x20]',
    'ldr w9, [x19, #0x24]',
    'ret',
  ], '791-overlap');
  const [wide, tail] = loads(ir);
  assert.equal(wide.loc.address, 0x100001020n);
  assert.equal(tail.loc.address, 0x100001024n);
  assert.equal(wide.loc.size, 8);
  assert.equal(tail.loc.size, 4);
  assert.equal(mayAliasProvenance(wide.loc, tail.loc), true, '[A,A+8) overlaps [A+4,A+8)');
}

{
  const ir = build([
    'adr x19, #0x100001000',
    'str w0, [x19, #0x20]',
    'ldr x1, [x19, #0x20]',
    'ret',
  ], '791-memoryssa');
  const store = stores(ir)[0];
  const load = loads(ir)[0];
  assert.equal(store.loc.size, 4);
  assert.equal(load.loc.size, 8);
  assert.notEqual(load.reachingStore, store, 'MemorySSA must not exact-forward a 32-bit store into a 64-bit load');
}

// #797 — branch RHS bitpatterns are interpreted in the comparison domain.
{
  const ir = build([
    'mov x1, #-1',
    'cmp x0, x1',
    'b.gt #0x100000010',
    'mov x2, #0',
    'ret',
  ], '797-x-signed-minus1');
  const fact = firstBranchFact(ir);
  assert.equal(fact.taken.constant, -1n);
  assert.notEqual(fact.taken.range?.impossible, true, '0 > -1 remains feasible in signed domain');
  assert.equal(fact.taken.signedness, 'signed');
}

{
  const ir = build([
    'mov x1, #-1',
    'cmp x0, x1',
    'b.hi #0x100000010',
    'mov x2, #0',
    'ret',
  ], '797-x-unsigned-minus1');
  const fact = firstBranchFact(ir);
  assert.equal(fact.taken.constant, 0xffffffffffffffffn);
  assert.equal(fact.taken.range?.impossible, true, 'unsigned x > UINT64_MAX is correctly impossible');
}

{
  const ir = build([
    'mov w1, #0xffffffff',
    'cmp w0, w1',
    'b.gt #0x100000010',
    'mov w2, #0',
    'ret',
  ], '797-w-signed-minus1');
  const fact = firstBranchFact(ir);
  assert.equal(fact.taken.constant, -1n);
  assert.notEqual(fact.taken.range?.impossible, true);
}

{
  const ir = build([
    'mov w1, #0x80000000',
    'cmp w0, w1',
    'b.ge #0x100000010',
    'mov w2, #0',
    'ret',
  ], '797-w-intmin');
  const fact = firstBranchFact(ir);
  assert.equal(fact.taken.constant, -0x80000000n);
  assert.notEqual(fact.taken.range?.impossible, true);
}

// #825 — shifted constants use architectural W/X bitvector semantics.
for (const [tag, lines, expected] of [
  ['w-lsl-wrap', ['mov w1, #0x80000000', 'cmp w0, w1, lsl #1', 'b.eq #0x100000010', 'nop', 'ret'], 0n],
  ['x-lsl-wrap', ['mov x1, #0x8000000000000000', 'cmp x0, x1, lsl #1', 'b.eq #0x100000010', 'nop', 'ret'], 0n],
  ['w-lsr', ['mov w1, #0x80000000', 'cmp w0, w1, lsr #31', 'b.eq #0x100000010', 'nop', 'ret'], 1n],
  ['w-asr', ['mov w1, #0x80000000', 'cmp w0, w1, asr #31', 'b.eq #0x100000010', 'nop', 'ret'], 0xffffffffn],
  ['w-ror', ['mov w1, #0x80000001', 'cmp w0, w1, ror #1', 'b.eq #0x100000010', 'nop', 'ret'], 0xc0000000n],
]) {
  const fact = firstBranchFact(build(lines, `825-${tag}`), `#825 ${tag}`);
  assert.equal(fact.taken.constant, expected, `#825 ${tag}`);
  assert.notEqual(fact.taken.range?.impossible, true, `${tag} taken equality must remain representable`);
}

// #800 — a signed compare after AND-with-sign-bit cannot inherit a false nonnegative range.
for (const [tag, andLine, branchLine] of [
  ['w', 'and w0, w1, #0x80000000', 'b.lt #0x100000010'],
  ['x', 'and x0, x1, #0x8000000000000000', 'b.lt #0x100000010'],
]) {
  const ir = build([
    andLine,
    'cmp ' + (tag === 'w' ? 'w0' : 'x0') + ', #0',
    branchLine,
    'nop',
    'ret',
  ], `800-${tag}-signbit`);
  const fact = firstBranchFact(ir);
  assert.notEqual(fact.taken.range?.impossible, true, `${tag} sign-bit AND can be negative`);
  assert.notEqual(fact.fallthrough.range?.impossible, true, `${tag} sign-bit AND can also be nonnegative`);
}

// Low masks still keep useful precision.
{
  const ir = build([
    'and w0, w1, #0xff',
    'cmp w0, #0x80',
    'b.lt #0x100000010',
    'nop',
    'ret',
  ], '800-low-mask');
  const masked = ir.instructions.find((inst) => inst.op === OP.BIN && inst.sub === 'and')?.dst;
  const range = valueRange(masked);
  assert.ok(range);
  assert.equal(range.min, 0n);
  assert.equal(range.max, 0xffn);
}

console.log('issues #791/#797/#800/#825 semantic IR soundness regressions: ok');
