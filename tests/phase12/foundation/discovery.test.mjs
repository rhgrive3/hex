import assert from 'node:assert/strict';
import { findTests, ROOT } from '../run.mjs';

const files = findTests(ROOT);
assert.ok(files.some((file) => file.endsWith('/foundation/manifest.test.mjs')));
assert.ok(files.some((file) => file.endsWith('/foundation/discovery.test.mjs')));
assert.equal(files.length, new Set(files).size);
assert.ok(files.every((file) => file.endsWith('.test.mjs')));
console.log(`[phase12] canonical discovery found ${files.length} nested tests`);
