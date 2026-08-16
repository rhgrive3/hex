import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { constantComparisons } from '../../js/dataflow.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const lines = [
  'mov w9, #100',
  'cmp w8, w9',
  'b.hi #0x10000000c',
  'ret',
];
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
  const delta = address - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};

const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
try {
  const ir = buildIR(model, { rowOfAddress });
  assert.ok(ir, 'explicit v2 compatibility route must produce IR');
  const comparisons = constantComparisons(model, { ir, allowUnscopedPropagated:true });
  if (comparisons.length !== 1 || comparisons[0].value !== 100n) {
    const shape = (value, depth = 0, active = new Set()) => {
      if (!value) return null;
      const out = { id:value.id, reg:value.reg, bits:value.bits, kind:value.kind, const:value.const == null ? null : String(value.const) };
      if (!value.def || depth >= 4 || active.has(value.id)) return out;
      active.add(value.id);
      out.def = { op:value.def.op, sub:value.def.sub, row:value.def.row,
        args:(value.def.args || []).map((arg) => shape(arg?.value, depth + 1, active)) };
      active.delete(value.id);
      return out;
    };
    console.log('V2_THRESHOLD_PROJECTION_DIAG ' + JSON.stringify({
      args:[...(ir.args || new Map()).entries()].map(([reg,value]) => [reg, shape(value)]),
      comparisons,
      cmp:(ir.instructions || []).filter((inst) => inst.op === OP.CMP).map((inst) => ({
        row:inst.row,
        args:(inst.args || []).map((arg) => shape(arg?.value)),
      })),
      branch:(ir.instructions || []).filter((inst) => inst.op === OP.CBR).map((inst) => ({
        row:inst.row,
        cond:inst.cond,
        args:(inst.args || []).map((arg) => shape(arg?.value)),
        extra:inst.extra,
      })),
      state:(ir.instructions || []).filter((inst) => inst.extra?.stateRead || inst.extra?.stateWrite).map((inst) => ({
        row:inst.row,
        op:inst.op,
        publicStateIdentity:inst.extra?.publicStateIdentity ?? null,
        localPhysicalViewProjection:inst.extra?.localPhysicalViewProjection ?? null,
        dst:shape(inst.dst),
        args:(inst.args || []).map((arg) => shape(arg?.value)),
      })),
    }));
  }
  assert.equal(comparisons.length, 1, 'register-held constant threshold must survive explicit v2 projection and flag-consuming branch');
  assert.equal(comparisons[0].row, 1);
  assert.equal(comparisons[0].value, 100n);
  assert.equal(comparisons[0].register, 'x8');
  assert.equal(comparisons[0].engine, 'ir-ssa');
  assert.equal(comparisons[0].propagated, true);
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 register threshold projection: PASS');