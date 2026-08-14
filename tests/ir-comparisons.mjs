/* Constant-threshold regressions for the IR-backed dataflow facade. */
import { buildSemanticModel } from '../js/blocks.js';
import { constantComparisons, constantComparisonsLegacy, findValueUpdates } from '../js/dataflow.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) { failures.push({ name, err }); process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n'); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': got ' + String(a) + ', want ' + String(b)); }

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

test('SSA recovers a threshold held in another register', () => {
  const model = modelOf([
    'mov w9, #100',
    'cmp w8, w9',
    'b.hi #0x10000000c',
    'ret',
  ]);
  eq(constantComparisonsLegacy(model).length, 0, 'legacy cannot see the propagated constant');
  const rows = constantComparisons(model);
  eq(rows.length, 1);
  eq(rows[0].row, 1);
  eq(rows[0].value, 100n);
  eq(rows[0].register, 'x8');
  eq(rows[0].engine, 'ir-ssa');
  eq(rows[0].propagated, true);
});

test('direct literal comparison is enriched, not duplicated', () => {
  const model = modelOf(['cmp w8, #100', 'ret']);
  const rows = constantComparisons(model);
  eq(rows.length, 1, 'one machine comparison stays one finding');
  eq(rows[0].value, 100n);
  eq(rows[0].row, 0);
});

test('comparison without a proven constant is not invented', () => {
  const model = modelOf(['cmp w8, w9', 'ret']);
  const rows = constantComparisons(model);
  eq(rows.length, 0);
});

test('constant propagated through a copy remains a threshold', () => {
  const model = modelOf([
    'mov w10, #999',
    'mov w9, w10',
    'cmp w8, w9',
    'ret',
  ]);
  const rows = constantComparisons(model);
  ok(rows.length === 1, 'comparison recovered');
  eq(rows[0].value, 999n);
  eq(rows[0].register, 'x8');
});

test('MOVZ/MOVK assembled constants remain whole thresholds', () => {
  const model = modelOf([
    'movz w9, #0x1234',
    'movk w9, #0x5678, lsl #16',
    'cmp w8, w9',
    'ret',
  ]);
  const rows = constantComparisons(model);
  ok(rows.length === 1, 'assembled comparison recovered');
  eq(rows[0].value, 0x56781234n, 'MOVK fragment is inserted instead of mistaken for the full constant');
  eq(rows[0].register, 'x8');
});

test('propagated guard is not exposed generically after multiple location candidates were found', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ldr w10, [x19, #0x40]',
    'add w10, w10, #1',
    'str w10, [x19, #0x40]',
    'mov w9, #100',
    'cmp w8, w9',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  ok(updates.some((u) => u.location && u.location.disp === 0x20n), 'first location found');
  ok(updates.some((u) => u.location && u.location.disp === 0x40n), 'second location found');
  const rows = constantComparisons(model);
  ok(!rows.some((r) => r.row === 7 && r.propagated),
    'unscoped SSA threshold is withheld instead of being attached to both locations');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
