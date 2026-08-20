import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverPhase8Tests } from '../run.mjs';

const PHASE8_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(PHASE8_ROOT, '../..');

/**
 * Phase 4 shipped owned tests in a nested directory the canonical runner never
 * discovered: they passed by hand and were invisible to CI (EP-005). These
 * sentinels make that failure mode impossible to repeat silently.
 */
const REQUIRED_SUBTREES = Object.freeze([
  'foundation',
  'ownership',
  'substrate',
  'scalar',
  'memory',
  'loops',
  'structuring',
  'aggregates',
  'providers',
  'corpus',
  'verifier',
  'performance',
]);

test('every Phase 8 test subtree is reachable from the canonical runner', () => {
  const discovered = discoverPhase8Tests().map((file) => path.relative(PHASE8_ROOT, file).replaceAll('\\', '/'));
  assert.ok(discovered.length > 0, 'canonical runner must discover Phase 8 tests');
  for (const subtree of REQUIRED_SUBTREES) {
    assert.ok(fs.existsSync(path.join(PHASE8_ROOT, subtree)), `required Phase 8 subtree is missing: ${subtree}`);
    assert.ok(
      discovered.some((file) => file.startsWith(`${subtree}/`)),
      `canonical runner discovered no test in required subtree: ${subtree}`,
    );
  }
});

test('a sentinel placed in any owned subtree is discovered', () => {
  // The stronger form: not "a test exists here today" but "a new test dropped
  // here tomorrow would be found".
  for (const subtree of REQUIRED_SUBTREES) {
    const sentinel = path.join(PHASE8_ROOT, subtree, '.discovery-sentinel.test.mjs');
    fs.writeFileSync(sentinel, 'export default null;\n');
    try {
      assert.ok(discoverPhase8Tests().includes(sentinel), `sentinel in ${subtree} was not discovered by the canonical runner`);
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  }
});

test('no owned Phase 8 test file escapes canonical discovery', () => {
  const discovered = new Set(discoverPhase8Tests());
  const onDisk = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) onDisk.push(absolute);
    }
  };
  visit(PHASE8_ROOT);
  assert.deepEqual(onDisk.filter((file) => !discovered.has(file)), [],
    'these Phase 8 test files exist but are not discovered by the canonical runner');
});

test('the canonical Phase 8 runner is wired into the repository check path', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['phase8:test'], 'node tests/phase8/run.mjs', 'phase8:test must invoke the canonical runner');
  assert.ok(String(packageJson.scripts.check).includes('phase8:test'),
    'npm run check must include phase8:test, otherwise Phase 8 tests never run in the canonical gate');
  assert.ok(packageJson.scripts['phase8:verify'], 'phase8:verify entry point must exist');
  assert.ok(packageJson.scripts['phase8:ownership'], 'phase8:ownership entry point must exist');
  assert.ok(packageJson.scripts['phase8:baseline'], 'phase8:baseline entry point must exist');
});
