import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode } from '../../js/ir.js';
import { recoverInductionVariables } from '../../js/decompiler/semantic.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const lines = [
  'mov w8, #0',
  'cmp w8, w1',
  'b.ge #0x100000014',
  'add w8, w8, #1',
  'b #0x100000004',
  'ret',
];
const rows = lines.map((text, row) => {
  const split = text.indexOf(' ');
  return {
    row,
    address: BASE + BigInt(row * 4),
    mn: split < 0 ? text : text.slice(0, split),
    ops: split < 0 ? '' : text.slice(split + 1),
  };
});
const rowOfAddress = (address) => {
  const delta = BigInt(address) - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};
const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const ir = buildIR(model, { rowOfAddress });
  assert.equal(ir?.compat?.projection, 'semantic-ir-v2-to-v1');
  const induction = recoverInductionVariables(ir);
  if (!induction.length) {
    console.warn('P3_INDUCTION_IR', JSON.stringify((ir?.instructions || []).map((inst) => ({
      op:inst.op, sub:inst.sub ?? null, row:inst.row, block:inst.block,
      dst:inst.dst ? { id:inst.dst.id, kind:inst.dst.kind, reg:inst.dst.reg, bits:inst.dst.bits, const:inst.dst.const == null ? null : String(inst.dst.const) } : null,
      args:(inst.args || []).map((arg) => {
        const value = arg?.value;
        return value ? { id:value.id, kind:value.kind, reg:value.reg, bits:value.bits, const:value.const == null ? null : String(value.const), def:value.def ? { op:value.def.op, sub:value.def.sub ?? null, row:value.def.row, block:value.def.block } : null } : null;
      }),
      incoming:(inst.incoming || []).map((edge) => ({ from:edge.from, value:edge.value ? { id:edge.value.id, kind:edge.value.kind, reg:edge.value.reg, bits:edge.value.bits, const:edge.value.const == null ? null : String(edge.value.const), def:edge.value.def ? { op:edge.value.def.op, sub:edge.value.def.sub ?? null, row:edge.value.def.row, block:edge.value.def.block } : null } : null })),
      cond:inst.cond ?? null,
      target:inst.extra?.target == null ? null : String(inst.extra.target),
    }))));
  }
  assert.ok(induction.length >= 1, 'explicit-v2 compatibility IR must preserve SSA PHI induction recovery');
  assert.equal(induction[0].step, 1n);
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 decompiler induction compatibility: PASS');
