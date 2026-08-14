/* End-to-end check: pinpointLocation consumes the IR-backed dataflow facade. */
import { buildSemanticModel } from '../js/blocks.js';
import { GOALS } from '../js/goals.js';
import { pinpointLocation } from '../js/pinpoint.js';

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

function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': got ' + String(a) + ', want ' + String(b)); }

const model = modelOf([
  'mov x19, x0',
  'ldr w9, [x20, #0x30]',          // amount source
  'ldr w8, [x19, #0x20]',          // current value
  'cmp w2, #0',
  'b.eq #0x10000001c',             // row 7
  'sub w8, w8, w9',
  'b #0x100000020',                // row 8
  'sub w8, w8, w9',
  'str w8, [x19, #0x20]',          // join
  'mov w11, #100',
  'cmp w8, w11',                   // propagated threshold
  'ret',
]);

const goal = GOALS.find((g) => g.id === 'hp');
ok(goal, 'hp goal exists');

const result = await pinpointLocation({
  goal,
  ranked: [{ addr: BASE, name: 'applyDamage', strings: ['damage', 'hp'] }],
  program: {
    functionRange: () => ({ start: BASE, end: BASE + 48n }),
    functionStartOf: () => BASE,
  },
  analyze: async () => model,
  budget: { left: 12 },
  limit: 10,
});

ok(result.checked >= 1, 'pinpoint analyzed the candidate function');
ok(result.candidates.length >= 1, 'pinpoint produced a location candidate');
const c = result.candidates.find((x) => x.offset === 0x20n) || result.candidates[0];
eq(c.offset, 0x20n, 'candidate field offset');
ok(c.updates && c.updates.length, 'candidate carries update proof');
eq(c.updates[0].engine, 'ir-ssa', 'final pinpoint candidate uses SSA proof');
ok(c.updates[0].steps.some((s) => s.op === 'sub'), 'arithmetic survives into pinpoint');
ok(c.compares && c.compares.some((x) => x.value === 100n && x.engine === 'ir-ssa'),
  'SSA-propagated guard reaches pinpoint');

process.stdout.write('  ok  pinpointLocation consumes SSA RMW + threshold\n');
