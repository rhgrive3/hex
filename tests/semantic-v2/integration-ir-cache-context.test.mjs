import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  irFor,
  setSemanticMigrationMode,
} from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const rows = ['mov x0, x1', 'ret'].map((line, row) => {
  const split = line.indexOf(' ');
  return {
    row,
    address: BASE + BigInt(row * 4),
    mn: split < 0 ? line : line.slice(0, split),
    ops: split < 0 ? '' : line.slice(split + 1),
  };
});
const rowOfAddress = (address) => {
  const delta = BigInt(address) - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};
const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  const legacy = irFor(model);
  assert.ok(legacy, 'legacy route must build');
  assert.notEqual(legacy.compat?.projection, 'semantic-ir-v2-to-v1');

  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const explicit = irFor(model);
  assert.ok(explicit, 'explicit v2 route must build for the same model');
  assert.equal(explicit.compat?.projection, 'semantic-ir-v2-to-v1',
    'irFor must not reuse a legacy cache entry after the semantic route changes');
  assert.notStrictEqual(explicit, legacy, 'different semantic routes must have distinct cached projections');

  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  assert.strictEqual(irFor(model), legacy,
    'returning to the same route may reuse only that route-specific cache entry');

  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const explicitCustom = irFor(model, { decoderSemanticVersion:'cache-context-explicit-custom' });
  assert.equal(explicitCustom.compat?.projection, 'semantic-ir-v2-to-v1');
  assert.notStrictEqual(explicitCustom, explicit,
    'non-empty analysis options must not reuse the default cached projection');
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 irFor cache context: PASS');
