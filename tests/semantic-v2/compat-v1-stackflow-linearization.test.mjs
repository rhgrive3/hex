import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(
  path.join(root, 'js/semantics/compat/semantic-ir-v2-to-v1-finalize.js'),
  'utf8',
);

assert.match(source, /function stackDependentValueIds\(projected, roots\)/);
assert.match(source, /const dependentsByValueId = new Map\(\)/);
assert.match(source, /const queue = \[\.\.\.roots\]/);
assert.match(source, /stackDependent\.has\(arg\.value\.id\)/);

// Regression guard: the old per-call recursive walk cloned the visited set on
// every SSA edge, causing shared dependency DAGs to explode exponentially on
// real binaries. Stack escape reachability must remain a single indexed walk.
assert.doesNotMatch(source, /function valueDependsOnRoots\(/);
assert.doesNotMatch(source, /new Set\(seen\)/);

console.log('semantic-v2 stack escape traversal linearization: PASS');
