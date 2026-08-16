import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { irFor, readModifyWrite, setSemanticMigrationMode, MK } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const lines = [
  'adr x19, #0x100001000',
  'ldr w8, [x19, #0x20]',
  'add w8, w8, #1',
  'str w8, [x19, #0x20]',
  'ret',
];
const rows = lines.map((line, row) => {
  const split = line.indexOf(' ');
  return { row, address:BASE + BigInt(row * 4), mn:split < 0 ? line : line.slice(0, split), ops:split < 0 ? '' : line.slice(split + 1) };
});
const rowOfAddress = (address) => {
  const delta = BigInt(address) - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};
const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const ir = irFor(model, { rowOfAddress, decoderSemanticVersion:'global-rmw-explicit-v2' });
  assert.ok(ir, 'explicit v2 route must build absolute global fixture');
  const rmw = readModifyWrite(ir).find((candidate) => candidate.location?.kind === MK.GLOBAL) ?? null;
  if (!rmw) {
    console.log('V2_GLOBAL_RMW_DIAG ' + JSON.stringify({
      locations:[...(ir.locations || new Map()).entries()].map(([key, loc]) => [key, { kind:loc.kind, address:loc.address == null ? null : String(loc.address), disp:loc.disp == null ? null : String(loc.disp), baseEntityId:loc.baseEntityId ?? null }]),
      memory:(ir.instructions || []).filter((inst) => inst.op === 'load' || inst.op === 'store').map((inst) => ({
        row:inst.row, op:inst.op, loc:inst.loc ? { key:inst.loc.key, kind:inst.loc.kind, address:inst.loc.address == null ? null : String(inst.loc.address), disp:inst.loc.disp == null ? null : String(inst.loc.disp), baseEntityId:inst.loc.baseEntityId ?? null } : null,
        addr:inst.addr ? { disp:inst.addr.disp == null ? null : String(inst.addr.disp), baseReg:inst.addr.baseReg ?? null, baseSemanticValueId:inst.addr.base?.semanticValueId ?? null, precise:inst.addr.precise ?? null } : null,
      })),
      address:(ir.instructions || []).filter((inst) => inst.op === 'addr' || inst.row === 0).map((inst) => ({ row:inst.row, op:inst.op, sub:inst.sub, dst:inst.dst ? { reg:inst.dst.reg, const:inst.dst.const == null ? null : String(inst.dst.const), semanticValueId:inst.dst.semanticValueId ?? null } : null, args:(inst.args || []).map((arg) => ({ reg:arg.value?.reg ?? null, const:arg.value?.const == null ? null : String(arg.value.const), semanticValueId:arg.value?.semanticValueId ?? null })) })),
    }));
  }
  assert.ok(rmw, 'absolute ADR-based RMW must remain a proven GLOBAL location');
  assert.equal(rmw.location.address, 0x100001020n);
  assert.equal(rmw.load.row, 1);
  assert.equal(rmw.store.row, 3);
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 absolute global RMW compatibility projection: PASS');