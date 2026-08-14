import assert from 'node:assert/strict';
import { parseOperands } from '../js/arm64.js';
import { buildValues, render, same } from '../js/expr.js';
import { goalEvidenceConfidence } from '../js/report.js';
import { GROUP } from '../js/evidence.js';
import { findGlobals } from '../js/linkage.js';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('ok', name); } catch (error) { console.error('not ok', name); throw error; } }
function I(row, mnemonic, operands, reads = [], writes = [], extra = {}) {
  return { row, address: 0x1000n + BigInt(row * 4), mnemonic, operands, ops: parseOperands(operands), reads, writes, ...extra };
}
function model(instructions) { return { instructions, calls: [], addressRefs: [], basicBlocks: [{ startRow: instructions[0]?.row ?? 0, rows: instructions.map((x) => x.row), isJoin: false }] }; }

await test('CCMP does not masquerade as unconditional CMP for a later CSEL', () => {
  const m = model([
    I(0, 'cmp', 'x2, #0', ['x2']),
    I(1, 'ccmp', 'x0, x1, #0, eq', ['x0','x1']),
    I(2, 'csel', 'x3, x4, x5, lt', ['x4','x5'], ['x3']),
  ]);
  const v = buildValues(m);
  const sel = v.defAt(2, 'x3');
  assert.equal(sel.k, 'sel');
  assert.equal(sel.cmp, null);
});

await test('unsupported NZCV writer invalidates an earlier CMP', () => {
  const m = model([
    I(0, 'cmp', 'x0, #4', ['x0']),
    I(1, 'adcs', 'x8, x1, x2', ['x1','x2'], ['x8']),
    I(2, 'csel', 'x3, x4, x5, eq', ['x4','x5'], ['x3']),
  ]);
  const sel = buildValues(m).defAt(2, 'x3');
  assert.equal(sel.k, 'sel');
  assert.equal(sel.cmp, null);
});

await test('CINC alias increments on condition true, not false', () => {
  const m = model([
    I(0, 'cmp', 'x0, #0', ['x0']),
    I(1, 'cinc', 'x1, x2, eq', ['x2'], ['x1']),
  ]);
  const sel = buildValues(m).defAt(1, 'x1');
  assert.equal(sel.k, 'sel');
  assert.equal(sel.a.k, 'bin'); assert.equal(sel.a.op, 'add');
  assert.equal(sel.b.k, 'arg'); assert.equal(sel.b.n, 2);
});

await test('32-bit GP writes zero extend into the architectural X register', () => {
  const m = model([
    I(0, 'movz', 'x0, #0xffff, lsl #48', [], ['x0']),
    I(1, 'add', 'w0, w0, #1', ['x0'], ['x0']),
  ]);
  const out = buildValues(m).defAt(1, 'x0');
  assert.equal(out.k, 'const');
  assert.equal(out.v, 1n);
});

await test('arbitrary W-register reads are explicit low-32 zero extensions', () => {
  const m = model([I(0, 'mov', 'w1, w0', ['x0'], ['x1'])]);
  const out = buildValues(m).defAt(0, 'x1');
  assert.equal(out.k, 'un'); assert.equal(out.op, 'uxt32');
});

await test('floating arithmetic uses floating nodes and preserves fractional immediates', () => {
  const m = model([
    I(0, 'fmov', 's0, #1.5', [], ['v0']),
    I(1, 'fadd', 's1, s0, s0', ['v0'], ['v1']),
  ]);
  const out = buildValues(m).defAt(1, 'v1');
  assert.equal(out.k, 'fconst');
  assert.equal(out.v, 3);
  assert.equal(render(out), '3');
});

await test('indexed memory preserves extend and scale in the value identity', () => {
  const memOp = parseOperands('x0, [x1, w2, uxtw #2]')[1];
  const m = model([I(0, 'ldr', 'x0, [x1, w2, uxtw #2]', ['x1','x2'], ['x0'], {
    memory: { kind: 'load', base: 'x1', disp: 0n, index: 'x2', indexed: true, stack: false, size: 8 },
  })]);
  assert.equal(memOp.shift.op, 'uxtw'); assert.equal(memOp.shift.amount, 2);
  const out = buildValues(m).defAt(0, 'x0');
  assert.equal(out.k, 'mem');
  assert.equal(out.indexExtend, 'uxtw'); assert.equal(out.indexScale, 2);
  assert.match(render(out), /uint32|\* 4|<< 2/);
});

await test('memory identity includes load signedness and result width', () => {
  const base = { k: 'reg', reg: 'x1', row: 0 };
  const a = { k: 'mem', baseReg: 'x1', base, disp: 0n, size: 4, signed: false, resultBits: 32, index: null };
  const b = { ...a, signed: true, resultBits: 64 };
  assert.equal(same(a, b), false);
});

await test('variable shift counts wrap modulo destination width', () => {
  const m = model([
    I(0, 'movz', 'w1, #1', [], ['x1']),
    I(1, 'movz', 'w2, #32', [], ['x2']),
    I(2, 'lslv', 'w0, w1, w2', ['x1','x2'], ['x0']),
  ]);
  const out = buildValues(m).defAt(2, 'x0');
  assert.equal(out.k, 'const'); assert.equal(out.v, 1n);
});

await test('post-index memory separates access offset from base writeback', () => {
  const ops = parseOperands('x0, [x1], #8');
  const mem = ops.find((x) => x.k === 'mem');
  assert.equal(mem.mode, 'post'); assert.equal(mem.disp, null); assert.equal(mem.addressDisp, null); assert.equal(mem.writebackDisp.value, 8n);
  const m = model([I(0, 'ldr', 'x0, [x1], #8', ['x1'], ['x0','x1'], {
    memory: { kind: 'load', base: 'x1', disp: 0n, index: null, indexed: false, stack: false, size: 8 },
  })]);
  const v = buildValues(m);
  assert.equal(v.defAt(0, 'x0').disp, 0n);
  assert.match(render(v.defAt(0, 'x1')), /8/);
});

await test('correlated goal hits do not inflate confidence; heterogeneous sources do', () => {
  const repeated = Array.from({ length: 4 }, () => ({ group: GROUP.SEMANTIC }));
  const independent = [{ group: GROUP.SEMANTIC }, { group: GROUP.METADATA }, { group: GROUP.DATAFLOW }];
  assert.equal(goalEvidenceConfidence(repeated), 0.52);
  assert.ok(goalEvidenceConfidence(independent) >= 0.9);
});

await test('global xref counting is exact beyond 400k and includes zerofill ranges', () => {
  const target = 0x5000n;
  const refs = new Array(400001);
  refs[1] = target; // the old step=2 sampler skipped this only hit.
  const program = { refCount: refs.length, refTo: refs, refSitesTo: () => [] };
  const regions = [{ name: '__DATA,__bss', section: '__bss', vmAddr: 0x5000n, size: 0n, declaredSize: 0x100n, exec: false }];
  const out = findGlobals(null, program, regions, { minRefs: 1, limit: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].addr, target); assert.equal(out[0].refs, 1);
});

console.log(`issue-303-plus: ${passed} tests passed`);
