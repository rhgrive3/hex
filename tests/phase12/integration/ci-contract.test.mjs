import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/phase12-release-validation.yml'), 'utf8');
assert.equal(packageJson.scripts['phase12:verify'], 'node tools/validation/phase12/verify.mjs');
assert.match(workflow, /phase12:verify/);
assert.match(workflow, /--expect-sha/);
assert.match(workflow, /workflow_dispatch/);
assert.doesNotMatch(workflow, /git push\s+origin\s+main/);
assert.match(workflow, /actions\/checkout@v4/);
console.log('[phase12] permanent exact-SHA workflow contract passed');
