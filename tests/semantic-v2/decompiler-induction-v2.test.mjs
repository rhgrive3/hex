import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode } from '../../js/ir.js';
import { decompileSemantic, recoverInductionVariables } from '../../js/decompiler/semantic.js';
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
  assert.ok(induction.length >= 1, 'explicit-v2 compatibility IR must preserve SSA PHI induction recovery');
  assert.equal(induction[0].step, 1n);
  const decompiled = decompileSemantic(model, { rowOfAddress, name:'loop' });
  if (!/\b(?:for|while)\s*\(/.test(decompiled?.pseudocode || '')) {
    console.warn('P3_LOOP_STRUCTURE', JSON.stringify({
      coverage:decompiled?.coverage,
      inductions:(decompiled?.ctx?.inductions || []).map((item) => ({ header:item.loop?.header, step:item.step == null ? null : String(item.step) })),
      loops:(decompiled?.ir?.loops || []).map((loop) => ({ header:loop.header, nodes:[...loop.nodes], exits:[...loop.exits] })),
      blocks:(decompiled?.ir?.blocks || []).map((block) => ({ index:block.index, startRow:block.startRow, endRow:block.endRow, succ:block.succ, pred:block.pred })),
      pseudocode:decompiled?.pseudocode,
    }));
  }
  assert.ok(/\b(?:for|while)\s*\(/.test(decompiled?.pseudocode || ''), decompiled?.pseudocode || 'missing decompilation');
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 decompiler induction compatibility: PASS');
