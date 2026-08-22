import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/stage1-release-validation.yml');

const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');

const requiredTriggers = [
  'js/targets/architecture/**',
  'js/analysis/alias/**',
  'js/semantics/**',
  'tests/stage1/**',
  'tools/validation/stage1/**',
  'tools/validation/competitive/**',
  'tests/phase7/**',
  'tools/validation/phase7/**',
  'tests/phase8/**',
  'tools/validation/phase8/**',
  'tests/phase9/**',
  'tools/validation/phase9/**',
  'tests/phase11/**',
  'tools/validation/phase11/**',
  'tests/machine-effects/**',
  '.github/workflows/stage1-release-validation.yml',
  'tools/validation/stage2/completion-scope.lock.json',
  'tools/validation/stage2/closure-ledger.json',
];

for (const trigger of requiredTriggers) {
  assert.ok(content.includes(trigger), `Workflow missing path trigger: ${trigger}`);
}

assert.ok(content.includes('candidate-merge-tree:'), 'Workflow missing candidate-merge-tree job');
assert.ok(content.includes('head:'), 'Workflow missing head job');

console.log('stage1 workflow trigger coverage: PASS');
