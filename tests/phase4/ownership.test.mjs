import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validator = path.join(ROOT, 'tools/validation/phase4-ownership.mjs');
function run(lane, files) {
  return spawnSync(process.execPath, [validator, '--lane', lane, '--files', files.join(',')], { cwd:ROOT, encoding:'utf8' });
}

const allowed = run('p4-1', ['js/core/artifacts/store.js']);
assert.equal(allowed.status, 0, allowed.stderr);
const outside = run('p4-1', ['js/core/scheduler/engine.js']);
assert.notEqual(outside.status, 0, 'a store lane must not edit scheduler files');
const frozen = run('p4-2', ['js/core/scheduler/index.js']);
assert.notEqual(frozen.status, 0, 'component lane must not edit frozen P4-0 contract path');
const semantic = run('p4-7', ['js/semantics/ir/index.js']);
assert.notEqual(semantic.status, 0, 'Phase 4 must not edit Phase 3 semantic truth');

console.log('phase4 ownership gate: PASS');
