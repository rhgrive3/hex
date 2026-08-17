import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const requirements = fs.readFileSync('tests/oracle-requirements.txt', 'utf8');
const detect = workflow.indexOf('name: Detect real fixture configuration');
const requireAll = workflow.indexOf('name: Require all real fixture URLs');

assert.ok(detect >= 0, 'fixture detection step must exist');
assert.ok(requireAll > detect, 'fail-closed requirement must run after detection');

const failClosedGate = workflow.slice(requireAll, workflow.indexOf('\n\n  preflight-tests:', requireAll));
assert.match(failClosedGate, /if:\s*steps\.fixtures\.outputs\.enabled\s*!=\s*'true'/);
assert.match(failClosedGate, /exit 1/);
assert.doesNotMatch(failClosedGate, /continue-on-error:\s*true/);

for (const variable of [
  'HEX_FIXTURE_BATTLECATS_URL',
  'HEX_FIXTURE_TSUMTSUM_URL',
  'HEX_FIXTURE_YWP_URL',
]) {
  assert.ok(workflow.includes(variable), `${variable} must participate in the required gate`);
}

for (const fixture of ['battlecats', 'YWP', 'TsumTsum']) {
  assert.ok(workflow.includes(`fixture: ${fixture}`), `${fixture} must participate in cross-binary accuracy`);
}
assert.match(workflow, /max-parallel:\s*3/, 'the three independent oracles must run concurrently');
assert.match(workflow, /max-parallel:\s*20/, 'target/feature shards must be allowed to run concurrently');
assert.match(workflow, /fail-fast:\s*false/g, 'parallel jobs must keep collecting diagnostics after one failure');

assert.match(requirements, /^lief==1\.0\.0$/m, 'LIEF oracle version must remain pinned');
assert.match(requirements, /^capstone==5\.0\.9$/m, 'Capstone oracle version must remain pinned');
assert.match(workflow, /ORACLE_PYTHON_VERSION:\s*'3\.12\.13'/,
  'Python oracle runtime must be exact, not a floating minor version');

const oracleKey = workflow.slice(
  workflow.indexOf('name: Build exact oracle cache key'),
  workflow.indexOf('name: Restore exact oracle cache'),
);
for (const input of [
  'tests/fixtures/real-binaries.json',
  'tests/oracle.py',
  'tests/oracle-cfg-normalize.py',
  'tests/oracle-requirements.txt',
]) {
  assert.ok(oracleKey.includes(input), `oracle cache key must include ${input}`);
}
assert.match(oracleKey, /runner\.os/);
assert.match(oracleKey, /runner\.arch/);
assert.match(oracleKey, /ORACLE_PYTHON_VERSION/);

const restore = workflow.slice(
  workflow.indexOf('name: Restore exact oracle cache'),
  workflow.indexOf('name: Validate cached oracle'),
);
assert.match(restore, /actions\/cache\/restore@v4/);
assert.match(restore, /steps\.oracle-key\.outputs\.key/);

const generate = workflow.slice(
  workflow.indexOf('name: Generate oracle on cache miss'),
  workflow.indexOf('name: Save exact oracle cache'),
);
assert.match(generate, /if:\s*steps\.oracle-cache\.outputs\.cache-hit\s*!=\s*'true'/,
  'oracle generation must run only on an exact cache miss');
assert.match(generate, /python tests\/oracle\.py/);
assert.match(generate, /python tests\/oracle-cfg-normalize\.py/);

const save = workflow.slice(
  workflow.indexOf('name: Save exact oracle cache'),
  workflow.indexOf('\n\n  measure:'),
);
assert.match(save, /actions\/cache\/save@v4/);
assert.match(save, /steps\.oracle-key\.outputs\.key/);

const measure = workflow.slice(workflow.indexOf('\n  measure:'), workflow.indexOf('\n  accuracy:'));
for (const partition of ['core', 'pinpoint', 'pinpoint-partial', 'pseudoc-1', 'pseudoc-2', 'pseudoc-3', 'pseudoc-4']) {
  assert.ok(measure.includes(`name: ${partition}`), `${partition} accuracy partition must exist`);
}
assert.match(measure, /--only="\$\{\{ matrix\.partition\.only \}\}"/,
  'partitioning must use accuracy.mjs built-in --only semantics');
assert.match(measure, /accuracy-pseudoc-shard-oracle\.mjs/,
  'pseudoc shards must derive from the exact serial sample set');
assert.match(measure, /Restore exact accuracy result cache[\s\S]*actions\/cache\/restore@v4/,
  'deterministic partition results should reuse an exact input-keyed cache');
assert.match(workflow, /name:\s*Publish oracle for this run[\s\S]*actions\/upload-artifact@v4/,
  'oracle jobs must publish their exact oracle as an intra-run artifact');
assert.match(measure, /name:\s*Download required oracle[\s\S]*actions\/download-artifact@v4/,
  'measurement must consume the oracle artifact produced by this run');
assert.match(measure, /name:\s*cross-binary-oracle-\$\{\{ matrix\.target\.name \}\}/,
  'each measurement target must download only its matching oracle');

const aggregate = workflow.slice(workflow.indexOf('\n  accuracy:'));
assert.match(aggregate, /accuracy-pseudoc-shard-merge\.mjs accuracy-part-BattleCats-pseudoc\.json/,
  'pseudoc shards must be exactly reassembled before normal accuracy merging');
assert.match(aggregate, /node tests\/accuracy-merge\.mjs accuracy-BattleCats\.json/);
assert.match(aggregate, /node tests\/accuracy-merge\.mjs accuracy-YWP\.json/);
assert.match(aggregate, /node tests\/accuracy-merge\.mjs accuracy-TsumTsum\.json/);
assert.match(aggregate, /node tests\/accuracy-gate\.mjs/,
  'the existing cross-binary score floors must remain the final accuracy gate');
assert.match(aggregate, /name:\s*accuracy\s*\n\s*if:\s*always\(\)/,
  'the final required accuracy job must remain a fail-closed aggregate');

assert.match(workflow, /push:\s*\n\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\]/,
  'main must seed exact oracle caches for later pull requests');
assert.match(workflow, /cancel-in-progress:\s*true/,
  'stale accuracy runs should be cancelled when a newer revision supersedes them');

console.log('issue #497 cross-binary workflow gate regression passed');
