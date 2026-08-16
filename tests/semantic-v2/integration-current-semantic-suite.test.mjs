import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  buildIR,
  getLastSemanticV2Instrumentation,
  setSemanticMigrationMode,
} from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

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
  return { model: buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress }), rowOfAddress };
}

setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
const smoke = modelOf([
  'mov x20, x19',
  'ldr w8, [x20, #0x20]',
  'add w8, w8, #1',
  'str w8, [x19, #0x20]',
  'ret',
]);
try {
  buildIR(smoke.model, { rowOfAddress: smoke.rowOfAddress });
} catch (error) {
  console.error('[phase3-shadow-smoke]', error?.stack ?? String(error));
}

await import('../semantic-core.mjs');
const instrumentation = getLastSemanticV2Instrumentation();
assert.ok(instrumentation?.v2Executed, 'the unchanged current semantic suite must execute the v2 route');
assert.deepEqual(instrumentation.path, ['machine-effects','semantic-ir-v2','scalar-ssa','region-resolver','memoryssa','v1-compat']);
console.log('current semantic suite through explicit Semantic IR v2 compatibility mode: PASS');
