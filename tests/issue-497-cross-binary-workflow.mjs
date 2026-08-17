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
]) assert.ok(workflow.includes(variable), `${variable} must participate in the required gate`);

for (const fixture of ['battlecats', 'YWP', 'TsumTsum']) {
  assert.ok(workflow.includes(`fixture: ${fixture}`), `${fixture} must participate in cross-binary accuracy`);
}
assert.match(workflow, /max-parallel:\s*3/, 'the three independent oracles must run concurrently');
assert.match(workflow, /max-parallel:\s*9/, 'measurement must stay well below the Free account concurrency limit');
assert.doesNotMatch(workflow, /max-parallel:\s*(?:20|90)/, 'measurement must not recreate excessive GitHub-job fanout');
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
]) assert.ok(oracleKey.includes(input), `oracle cache key must include ${input}`);
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

const measure = workflow.slice(workflow.indexOf('\n  measure:'), workflow.indexOf('\n  accuracy:'));
for (const partition of ['core', 'pinpoint', 'pseudoc']) {
  assert.ok(measure.includes(`name: ${partition}\n`), `${partition} accuracy partition must exist`);
}
assert.doesNotMatch(measure, /name: pinpoint-partial\n/,
  'pinpoint-partial must share the pinpoint runner instead of consuming another GitHub job');
assert.doesNotMatch(measure, /name: pseudoc-[12]\n/,
  'pseudoc must use one GitHub job per target and runner-local persistent workers');
assert.match(workflow, /LOCAL_PSEUDOC_WORKERS:\s*4/,
  'pseudoc must use the four CPUs inside its runner');
assert.match(workflow, /LOCAL_CORE_WORKERS:\s*4/,
  'the core partition must use runner-local CPU parallelism');
assert.match(measure, /run_parallel pinpoint pinpoint pinpoint-partial/,
  'pinpoint and pinpoint-partial must retain both exact feature runs inside one runner');
assert.match(measure, /node tests\/accuracy-pseudoc-parallel\.mjs/,
  'pseudoc must use persistent dynamic runner-local workers');
assert.match(measure, /--workers="\$LOCAL_PSEUDOC_WORKERS"/,
  'the persistent pseudoc pool size must remain explicitly bounded');
assert.match(measure, /Restore exact accuracy result cache[\s\S]*actions\/cache\/restore@v4/,
  'deterministic partition results should reuse an exact input-keyed cache');
assert.match(measure, /hashFiles\('js\/\*\*', 'tests\/accuracy\*\.mjs'/,
  'accuracy cache keys must include all accuracy runner/helper sources');
assert.match(workflow, /name:\s*Publish oracle for this run[\s\S]*actions\/upload-artifact@v4/,
  'oracle jobs must publish their exact oracle as an intra-run artifact');
assert.match(measure, /name:\s*Download required oracle[\s\S]*actions\/download-artifact@v4/,
  'measurement must consume the oracle artifact produced by this run');
assert.match(measure, /name:\s*cross-binary-oracle-\$\{\{ matrix\.target\.name \}\}/,
  'each measurement target must download only its matching oracle');

const aggregate = workflow.slice(workflow.indexOf('\n  accuracy:'));
assert.doesNotMatch(aggregate, /Reassemble exact pseudoc serial samples/,
  'persistent pseudoc workers already return the exact complete target result');
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
