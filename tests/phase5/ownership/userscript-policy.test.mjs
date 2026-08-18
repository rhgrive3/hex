import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../../tools/validation/phase5-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/phase2-effects-integration.yml'), 'utf8');
const MANIFEST = loadManifest();
const COMPONENT_BRANCHES = [
  'hex/p5-1-x86-int-control',
  'hex/p5-2-x86-memory-atomic',
  'hex/p5-3-x86-fp-simd-system',
  'hex/p5-4-x86-abis',
  'hex/p5-5-variable-viewer',
  'hex/p5-6-x86-verification',
];

test('component lanes build generated userscript ephemerally while integration owns commits', () => {
  assert.deepEqual(MANIFEST.generatedWriteOwners, ['p5-0', 'p5-i']);
  assert.match(WORKFLOW, /Build and test protected userscript runtime[\s\S]*npm run userscript:test/);
  assert.match(WORKFLOW, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(WORKFLOW, /HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(WORKFLOW, /if test "\$BASE_REF" = hex\/p5-x86-integration/);
  for (const branch of COMPONENT_BRANCHES) assert.equal(WORKFLOW.includes(branch), true, branch);
  assert.match(WORKFLOW, /echo "ephemeral=\$ephemeral" >> "\$GITHUB_OUTPUT"/);
  assert.match(WORKFLOW, /if: steps\.phase5-component\.outputs\.ephemeral != 'true'/);
  assert.match(WORKFLOW, /git diff --exit-code -- userscript\/hex\.user\.template\.js/);
});
