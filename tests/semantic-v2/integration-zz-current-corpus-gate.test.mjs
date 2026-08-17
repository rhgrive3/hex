import assert from 'node:assert/strict';

const report = globalThis.__HEX_PHASE3_CURRENT_CORPUS__;
assert.ok(report, 'current semantic/decompiler v2 corpus report must exist');
assert.equal(report.migrationMode, 'semantic-v2-compat');
assert.deepEqual(report.path, ['machine-effects','semantic-ir-v2','scalar-ssa','region-resolver','memoryssa','v1-compat']);
assert.equal(report.semantic.failed, 0,
  `Phase 3 semantic compatibility corpus has ${report.semantic.failed} failing command(s)`);
assert.equal(report.decompiler.failed, 0,
  `Phase 3 decompiler compatibility corpus has ${report.decompiler.failed} failing command(s)`);
console.log('current semantic/decompiler corpus through explicit Semantic IR v2 compatibility mode: PASS');
