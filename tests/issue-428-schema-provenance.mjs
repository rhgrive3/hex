import assert from 'node:assert/strict';
import { decodeSchema, unrolledTablesFromFixed } from '../js/schema.js';

const mk = (overrides = {}) => ({
  row:1, addr:0x100000004n, base:19, disp:0, size:4,
  block:0, loop:null, baseGeneration:1, fromCall:true, callRow:0,
  ...overrides,
});

// Same raw x19 number across three CFG/lifetime regions is not one object/table.
{
  const fixed = [
    mk({ row:2, block:0, baseGeneration:1, disp:0, callRow:1 }),
    mk({ row:12, block:1, baseGeneration:2, disp:4, callRow:11 }),
    mk({ row:22, block:2, baseGeneration:3, disp:8, callRow:21 }),
  ];
  assert.deepEqual(unrolledTablesFromFixed(fixed), []);
}

// A true straight-line parser run keeps one base lifetime and per-store call provenance.
{
  const fixed = [
    mk({ row:1, disp:0, callRow:0 }),
    mk({ row:3, disp:4, callRow:2, addr:0x10000000cn }),
    mk({ row:5, disp:8, callRow:4, addr:0x100000014n }),
  ];
  const tables = unrolledTablesFromFixed(fixed);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].offsets, [0, 4, 8]);
  assert.deepEqual(tables[0].provenance.callRows, [0, 2, 4]);
  assert.equal(tables[0].provenance.baseGeneration, 1);
  assert.equal(tables[0].provenance.region, 'block:0');
}

// Real decode path: BL; STR W0,[X19,#off] repeated in one basic block.
{
  const bl = 0x94000000;
  const strW0X19 = (disp) => (0xb9000000 | (((disp / 4) & 0xfff) << 10) | (19 << 5)) >>> 0;
  const words = new Uint32Array([
    bl, strW0X19(0),
    bl, strW0X19(4),
    bl, strW0X19(8),
  ]);
  const schema = decodeSchema(words, 0x100000000n);
  const table = schema?.tables?.find((x) => x.kind === 'unrolled');
  assert.ok(table, 'real fixed-store parser run should still recover an unrolled table');
  assert.deepEqual(table.offsets, [0, 4, 8]);
  assert.deepEqual(table.provenance.callRows, [0, 2, 4]);
}

console.log('issue #428 schema provenance regressions passed');
