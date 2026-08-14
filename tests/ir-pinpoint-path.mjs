/* Verify that the IR-backed dataflow facade reaches the verification path used by pinpoint.js. */
import { buildSemanticModel } from '../js/blocks.js';
import { verifyFunctionHandlesField } from '../js/verify.js';
import { amountOf, amountOfLegacy } from '../js/dataflow.js';

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

test('verifyFunctionHandlesField sees an SSA-proven RMW across a join', () => {
  const model = modelOf([
    'mov x19, x0',
    'ldr w8, [x19, #0x20]',
    'cmp w2, #0',
    'b.eq #0x100000018',
    'add w8, w8, #1',
    'b #0x10000001c',
    'add w8, w8, #2',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const verified = verifyFunctionHandlesField(model, 0x20n);
  ok(verified.touches, 'field is touched');
  ok(verified.writes, 'field is written');
  ok(verified.rmw, 'pinpoint verification path receives the SSA RMW');
  const u = verified.use.rmw[0];
  eq(u.engine, 'ir-ssa', 'verification is backed by IR');
});

test('IR-backed update keeps the amount source expected by role/pinpoint logic', () => {
  const model = modelOf([
    'mov x19, x0',
    'ldr w9, [x20, #0x30]',
    'ldr w8, [x19, #0x20]',
    'sub w8, w8, w9',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const verified = verifyFunctionHandlesField(model, 0x20n);
  ok(verified.rmw, 'RMW is verified');
  const update = verified.use.rmw[0];
  const change = amountOf(model, update);
  ok(change && change.amount, 'amount origin is preserved');
  eq(change.amount.kind, 'field', 'amount comes from another field');
  eq(change.amount.disp, 0x30n, 'amount field offset');
});

test('SSA amount origin survives a join where the legacy backward window stops', () => {
  const model = modelOf([
    'mov x19, x0',                    // 0
    'ldr w9, [x20, #0x30]',           // 1 amount source
    'cmp w2, #0',                     // 2
    'b.eq #0x100000018',              // 3 -> 6
    'mov w10, w9',                    // 4
    'b #0x10000001c',                 // 5 -> 7
    'mov w10, w9',                    // 6 same source on both paths
    'ldr w8, [x19, #0x20]',           // 7 join
    'sub w8, w8, w10',                // 8
    'str w8, [x19, #0x20]',           // 9
    'ret',                             // 10
  ]);
  const verified = verifyFunctionHandlesField(model, 0x20n);
  ok(verified.rmw, 'joined RMW is verified');
  const update = verified.use.rmw[0];
  eq(update.engine, 'ir-ssa');
  const old = amountOfLegacy(model, update);
  const modern = amountOf(model, update);
  ok(!old.amount || old.amount.kind !== 'field', 'fixture demonstrates the legacy join limitation');
  ok(modern.amount, 'SSA provides the amount');
  eq(modern.amount.kind, 'field');
  eq(modern.amount.disp, 0x30n);
  eq(modern.amount.engine, 'ir-ssa');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
