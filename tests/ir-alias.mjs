/* Alias/safety regressions for the IR-backed dataflow facade. */
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates, findValueUpdatesLegacy } from '../js/dataflow.js';
import { buildIR, OP } from '../js/ir.js';

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


test('Memory SSA canonicalizes MOV aliases and reaches the latest exact store', () => {
  const ir = buildIR(modelOf([
    'mov x1, x0',
    'mov w8, #5',
    'str w8, [x0, #0x20]',
    'mov w9, #7',
    'str w9, [x1, #0x20]',
    'ldr w10, [x0, #0x20]',
    'ret',
  ]));
  const stores = ir.instructions.filter((x) => x.op === OP.STORE);
  const load = ir.instructions.find((x) => x.op === OP.LOAD && x.row === 5);
  ok(stores.length === 2 && stores[0].loc.key === stores[1].loc.key, 'MOV aliases must share one Memory-SSA location');
  ok(load?.reachingStore?.row === 4, 'load must reach the second aliasing store, not stale row 2');
});

test('Memory SSA canonicalizes zero-offset pointer ADD aliases', () => {
  const ir = buildIR(modelOf([
    'add x1, x0, #0',
    'mov w8, #7',
    'str w8, [x1, #0x20]',
    'ldr w9, [x0, #0x20]',
    'ret',
  ]));
  const store = ir.instructions.find((x) => x.op === OP.STORE);
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(store?.loc.key === load?.loc.key, 'zero-offset ADD must preserve pointer identity');
  ok(load?.reachingStore === store, 'load must reach store through zero-offset alias');
});

test('Memory SSA canonicalizes PHI when every incoming pointer has the same provenance', () => {
  const ir = buildIR(modelOf([
    'cmp w2, #0',
    'b.eq #0x100000010',
    'mov x1, x0',
    'b #0x100000014',
    'mov x1, x0',
    'mov w8, #7',
    'str w8, [x1, #0x20]',
    'ldr w9, [x0, #0x20]',
    'ret',
  ]));
  const store = ir.instructions.find((x) => x.op === OP.STORE);
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(store?.loc.key === load?.loc.key, 'same-provenance PHI must retain one alias class');
  ok(load?.reachingStore === store, 'PHI alias must preserve exact reaching store');
});

test('different pointer arguments remain may-alias and clobber stale reaching stores', () => {
  const ir = buildIR(modelOf([
    'mov w8, #5',
    'str w8, [x0, #0x20]',
    'mov w9, #7',
    'str w9, [x1, #0x20]',
    'ldr w10, [x0, #0x20]',
    'ret',
  ]));
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(!load?.reachingStore, 'x1 store must invalidate stale x0 reachingStore');
  ok(load?.memUse?.kind === 'clobber' && load.memUse.inst?.row === 3, 'may-alias store must be represented as the reaching clobber');
});

test('may-alias object store blocks false RMW evidence across p/q', () => {
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'mov w9, #7',
    'str w9, [x1, #0x20]',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const modern = findValueUpdates(model);
  ok(!modern.some((u) => u.store?.row === 4 && u.kind === 'read-modify-write'), 'may-alias clobber must prevent false RMW proof');
});

test('proven stack storage remains distinct from an object field store', () => {
  const ir = buildIR(modelOf([
    'mov w8, #5',
    'str w8, [sp, #0x20]',
    'mov w9, #7',
    'str w9, [x0, #0x20]',
    'ldr w10, [sp, #0x20]',
    'ret',
  ]));
  const load = ir.instructions.find((x) => x.op === OP.LOAD && x.row === 4);
  ok(load?.reachingStore?.row === 1, 'different proven storage classes must not destroy stack precision');
});

test('overlapping partial store clobbers a wider field reaching store', () => {
  const ir = buildIR(modelOf([
    'str x8, [x0, #0x20]',
    'strb w9, [x0, #0x24]',
    'ldr x10, [x0, #0x20]',
    'ret',
  ]));
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(!load?.reachingStore, 'partial overlapping store must invalidate wider exact value');
  ok(load?.memUse?.kind === 'clobber' && load.memUse.inst?.row === 1, 'partial overlap must remain explicit clobber evidence');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
