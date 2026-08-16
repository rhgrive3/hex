import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const lines = ['ubfx w0, w0, #8, #8', 'ret'];
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
  const bfx = ir.instructions.find((inst) => inst.op === OP.BFX);
  assert.ok(bfx, 'exact bitfield extract must project as legacy BFX rather than CLOBBER');
  assert.equal(bfx.row, 0);
  assert.equal(bfx.extra?.lsb, 8);
  assert.equal(bfx.extra?.width, 8);
  assert.equal(bfx.extra?.signed, false);
  assert.equal(bfx.extra?.bitfieldKind, 'ubfx');
  const clobberAtRow = ir.instructions.find((inst) => inst.row === 0 && inst.op === OP.CLOBBER && inst.dst === bfx.dst);
  assert.equal(clobberAtRow, undefined, 'exact extract value must not be degraded to a clobber');
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 exact bitfield projection: PASS');
