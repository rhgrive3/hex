import assert from 'node:assert/strict';
import {
  getLastSemanticV2Instrumentation,
  setSemanticMigrationMode,
} from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
await import('../semantic-core.mjs');
const instrumentation = getLastSemanticV2Instrumentation();
assert.ok(instrumentation?.v2Executed, 'the unchanged current semantic suite must execute the v2 route');
assert.deepEqual(instrumentation.path, ['machine-effects','semantic-ir-v2','scalar-ssa','region-resolver','memoryssa','v1-compat']);
console.log('current semantic suite through explicit Semantic IR v2 compatibility mode: PASS');
