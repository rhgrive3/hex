/* Alias/safety regressions for the IR-backed dataflow facade. */
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates, findValueUpdatesLegacy } from '../js/dataflow.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) { failures.push({ name, err }); process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n'); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

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

test('pointer copy does not split one object field into two locations', () => {
  const model = modelOf([
    'mov x20, x19',
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x20, #0x20]',
    'ret',
  ]);
  const legacy = findValueUpdatesLegacy(model);
  ok(!legacy.some((u) => u.store && u.store.row === 3 && u.kind === 'read-modify-write'),
    'legacy keeps x19/x20 separate');
  const modern = findValueUpdates(model);
  const u = modern.find((x) => x.store && x.store.row === 3 && x.kind === 'read-modify-write');
  ok(u && u.engine === 'ir-ssa', 'IR canonicalizes the copied pointer');
});

test('unknown indexed write between read and write cannot be revived by legacy fallback', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w9, [x19, x3, lsl #2]',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const legacy = findValueUpdatesLegacy(model);
  ok(legacy.some((u) => u.store && u.store.row === 3 && u.kind === 'read-modify-write'),
    'fixture demonstrates the legacy false-positive path');
  const modern = findValueUpdates(model);
  ok(!modern.some((u) => u.store && u.store.row === 3 && u.kind === 'read-modify-write'),
    'facade must suppress an RMW invalidated by an unknown alias barrier');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
