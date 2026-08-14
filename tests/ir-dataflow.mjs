/* Regression tests for the incremental IR -> dataflow migration. */
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates, findValueUpdatesLegacy } from '../js/dataflow.js';
import { irFor, irText, readModifyWrite, OP } from '../js/ir.js';

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

test('linear RMW keeps the public shape and is proven by IR', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #10',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  const u = updates.find((x) => x.store && x.store.row === 2);
  ok(u, 'update exists');
  eq(u.kind, 'read-modify-write');
  eq(u.engine, 'ir-ssa');
  eq(u.location.disp, 0x20n);
  ok(u.steps.some((s) => s.op === 'add'), 'add step survives adapter');
  ok(u.evidence.some((e) => e && e.detail && e.detail.engine === 'ir-ssa'), 'IR provenance is visible');
});

test('SSA can prove an RMW across a control-flow join that legacy refuses to cross', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',        // 0
    'cmp w0, #0',                  // 1
    'b.eq #0x100000014',           // 2 -> 5
    'add w8, w8, #1',              // 3
    'b #0x100000018',              // 4 -> 6
    'add w8, w8, #2',              // 5
    'str w8, [x19, #0x20]',        // 6
    'ret',                          // 7
  ]);
  const legacy = findValueUpdatesLegacy(model);
  const modern = findValueUpdates(model);
  ok(!legacy.some((u) => u.store && u.store.row === 6 && u.kind === 'read-modify-write'),
    'legacy stays conservative at the join');
  const u = modern.find((x) => x.store && x.store.row === 6 && x.kind === 'read-modify-write');
  if (!u) {
    const ir = irFor(model);
    const rmw = ir ? readModifyWrite(ir) : [];
    throw new Error('SSA/phi proves the joined update; directRmw=' + rmw.length + '\n' + (ir ? irText(ir) : '<no ir>'));
  }
  eq(u.engine, 'ir-ssa');
});

test('different load/store locations are not promoted to RMW by IR', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x30]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  ok(!updates.some((u) => u.store && u.store.row === 2 && u.engine === 'ir-ssa'),
    'IR does not claim a same-location cycle');
});

test('indexed/unknown memory is never upgraded to a concrete IR field update', () => {
  const model = modelOf([
    'ldr w8, [x19, x1, lsl #2]',
    'add w8, w8, #1',
    'str w8, [x19, x1, lsl #2]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  ok(!updates.some((u) => u.engine === 'ir-ssa'), 'unknown aliases stay unproven');
});

test('unknown indexed store clobbers an older concrete Memory-SSA store', () => {
  const model = modelOf([
    'str w1, [x19, #0x20]',
    'str w2, [x19, x3, lsl #2]',
    'ldr w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  const load = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 2);
  ok(load, 'load exists');
  ok(!load.reachingStore, 'stale concrete store is blocked');
  ok(load.memUse && load.memUse.kind === 'clobber' && load.memUse.unknownAlias,
    'unknown store is recorded as the barrier');
  eq(ir.memorySafety.blockedLoads, 1);
});

test('unknown indexed store after a load does not erase earlier provenance', () => {
  const model = modelOf([
    'str w1, [x19, #0x20]',
    'ldr w8, [x19, #0x20]',
    'str w2, [x19, x3, lsl #2]',
    'ret',
  ]);
  const ir = irFor(model);
  const load = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 1);
  ok(load && load.reachingStore, 'the later unknown write cannot travel backward in time');
  eq(load.reachingStore.row, 0);
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
