/* End-to-end check: pinpointLocation consumes the IR-backed dataflow facade. */
import { buildSemanticModel } from '../js/blocks.js';
import { GOALS } from '../js/goals.js';
import { pinpointLocation } from '../js/pinpoint.js';
import { AMOUNT, SHAPE, foldShapes } from '../js/shapes.js';

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

const program = {
  functionRange: () => ({ start: BASE, end: BASE + 48n }),
  functionStartOf: () => BASE,
};

const result = await pinpointLocation({
  goal,
  ranked: [{ addr: BASE, name: 'applyDamage', strings: ['damage', 'hp'] }],
  program,
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

// Automatic analysis has already paid for the whole-program value-shape pass.
// The first pinpoint access request must expand to a superset and perform one
// whole-region fieldAccessMany scan; later goals using the same scanner must be
// served from that cache. The requested size contract is restored on readback.
{
  const shapes = foldShapes({
    count: 2, capped: false,
    disp: Int32Array.of(0x20, 0x40),
    size: Uint8Array.of(4, 8),
    flags: Uint8Array.of(
      SHAPE.DECREASE | SHAPE.CLAMP | SHAPE.CROSS,
      SHAPE.INCREASE,
    ),
    amtKind: Uint8Array.of(AMOUNT.FIELD, AMOUNT.IMM),
    amtDisp: Int32Array.of(0x30, 0),
    addr: BigUint64Array.of(BASE + 32n, BASE + 36n),
    span: Int32Array.of(0x100, 0x100),
    amtSize: Uint8Array.of(4, 0),
    amtSpan: Int32Array.of(0x100, 0),
  });
  let scans = 0;
  let batchedOffsets = 0;
  const scanAccess = async (requested) => {
    scans++;
    batchedOffsets = requested.length;
    const groups = new Map();
    for (const item of requested) {
      const key = BigInt(item.offset).toString();
      const at = BigInt(item.offset) === 0x20n ? BASE + 32n : BASE + 36n;
      groups.set(key, [{ addr: at, kind: 'store', size: BigInt(item.offset) === 0x20n ? 4 : 8 }]);
    }
    return groups;
  };
  const common = {
    goal,
    ranked: [{ addr: BASE, name: 'applyDamage', strings: ['damage', 'hp'] }],
    program,
    analyze: async () => model,
    shapes,
    scanAccess,
    budget: { left: 12 },
    limit: 10,
  };
  const first = await pinpointLocation(common);
  const second = await pinpointLocation({ ...common, budget: { left: 12 } });
  eq(scans, 1, 'all pinpoint goals sharing a scanner must reuse one whole-region access pass');
  ok(batchedOffsets >= 2, 'first access pass must include the shape-index superset, not only the current top value');
  ok(first.changeSites.some((site) => site.first === BASE + 32n && site.stores > 0),
    'batched access evidence must remain available as a grouped change site');
  ok(second.changeSites.some((site) => site.first === BASE + 32n && site.stores > 0),
    'cached access evidence must remain available to later goals');
}

// A direct/manual pinpoint call has no automatic shape index. It must preserve
// the legacy scan request instead of broadening every requested displacement to
// size=0 or scanning unrelated fields.
{
  let requested = null;
  const direct = await pinpointLocation({
    goal,
    ranked: [{ addr: BASE, name: 'applyDamage', strings: ['damage', 'hp'] }],
    program,
    analyze: async () => model,
    scanAccess: async (items) => {
      requested = items.map((item) => ({ offset: BigInt(item.offset), size: Number(item.size) || 0 }));
      const groups = new Map();
      for (const item of requested) groups.set(item.offset.toString(), [{ addr: BASE + 32n, kind: 'store', size: item.size || 4 }]);
      return groups;
    },
    budget: { left: 12 },
    limit: 10,
  });
  ok(requested?.length, 'direct pinpoint should still call its supplied scanner');
  ok(requested.some((item) => item.offset === 0x20n && item.size === 4),
    'direct pinpoint must preserve the legacy requested field size');
  ok(direct.changeSites.length > 0, 'direct pinpoint scan evidence remains available');
}

process.stdout.write('  ok  pinpointLocation consumes SSA RMW + threshold\n');
process.stdout.write('  ok  pinpoint access scanning batches once across goals\n');
process.stdout.write('  ok  direct pinpoint preserves legacy scan requests\n');
