import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/ghidra-differential.yml', 'utf8');
for (const path of [
  "'js/ir.js'",
  "'js/ir-core.js'",
  "'js/dataflow.js'",
  "'js/dataflow-*.js'",
  "'js/blocks.js'",
]) {
  assert.ok(workflow.includes(path), `Ghidra differential trigger must include ${path}`);
}
assert.ok(workflow.includes('node tests/issue-458-ghidra-trigger.mjs'));
console.log('issue #458 Ghidra trigger regression passed');
