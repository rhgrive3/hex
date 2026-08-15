import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const detect = workflow.indexOf('name: Detect real fixture configuration');
const requireAll = workflow.indexOf('name: Require all real fixture URLs');
const fetch = workflow.indexOf('name: Fetch and verify pinned real fixtures');

assert.ok(detect >= 0, 'fixture detection step must exist');
assert.ok(requireAll > detect, 'fail-closed requirement must run after detection');
assert.ok(fetch > requireAll, 'fixture fetching must only follow the fail-closed gate');

const gate = workflow.slice(requireAll, fetch);
assert.match(gate, /if:\s*steps\.fixtures\.outputs\.enabled\s*!=\s*'true'/);
assert.match(gate, /exit 1/);
assert.doesNotMatch(gate, /continue-on-error:\s*true/);

for (const variable of [
  'HEX_FIXTURE_BATTLECATS_URL',
  'HEX_FIXTURE_TSUMTSUM_URL',
  'HEX_FIXTURE_YWP_URL',
]) {
  assert.ok(workflow.includes(variable), `${variable} must participate in the required gate`);
}

console.log('issue #497 cross-binary workflow gate regression passed');
