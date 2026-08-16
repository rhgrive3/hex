import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  buildIR,
  setSemanticMigrationMode,
  OP,
} from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const lines = [
  'str w1, [sp, #0x18]',
  'add x0, sp, #0x18',
  'bl #0x100001000',
  'ldr w2, [sp, #0x18]',
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
  assert.ok(ir, 'explicit v2 compatibility IR must build');
  const call = ir.instructions.find((instruction) => instruction.op === OP.CALL);
  assert.ok(call, 'call must project');
  assert.equal(call.extra?.abiAdapterStatus, 'used', 'AAPCS64 compatibility adapter must reach the call projector');
  assert.ok(call.callArguments?.some((argument) => argument?.reg === 'x0'),
    `ABI call arguments must include x0: ${JSON.stringify(call.callArguments ?? null)}`);
  const candidates = ir.values
    .filter((value) => value.reg === 'x0')
    .map((value) => ({ id:value.id, kind:value.kind, bits:value.bits, version:value.version, defRow:value.def?.row ?? null }));
  assert.ok(candidates.some((value) => value.defRow != null && value.defRow <= call.row),
    `a reaching projected x0 state value must exist before the call: ${JSON.stringify(candidates)}`);
  assert.ok(call.args?.some((argument) => argument.value?.reg === 'x0'),
    `ABI physical argument must bind to the reaching projected state value: ${JSON.stringify({ callArguments:call.callArguments, args:(call.args ?? []).map((a) => ({ reg:a.value?.reg ?? null, bits:a.value?.bits ?? null, defRow:a.value?.def?.row ?? null })), candidates })}`);
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 ABI call-site state compatibility projection: PASS');
