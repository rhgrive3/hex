import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverPhase7Tests } from '../run.mjs';

const PHASE7_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(PHASE7_ROOT, '../..');

/**
 * Phase 4 shipped owned tests in a nested directory the canonical runner never
 * discovered: they passed by hand and were invisible to CI (EP-005). These
 * sentinels make that failure mode impossible to repeat silently.
 */
const REQUIRED_SUBTREES = Object.freeze([
  'foundation',
  'negative',
  'alias',
  'pointsto',
  'summary',
  'types',
  'debug',
  'discovery',
  'crossarch',
  'performance',
  'verifier',
  'ownership',
]);

test('every Phase 7 test subtree is reachable from the canonical runner', () => {
  const discovered = discoverPhase7Tests().map((file) => path.relative(PHASE7_ROOT, file).replaceAll('\\', '/'));
  assert.ok(discovered.length > 0, 'canonical runner must discover Phase 7 tests');
  for (const subtree of REQUIRED_SUBTREES) {
    const directory = path.join(PHASE7_ROOT, subtree);
    assert.ok(fs.existsSync(directory), `required Phase 7 subtree is missing: ${subtree}`);
    assert.ok(
      discovered.some((file) => file.startsWith(`${subtree}/`)),
      `canonical runner discovered no test in required subtree: ${subtree}`,
    );
  }
});

test('a sentinel placed in any owned subtree is discovered', () => {
  // The stronger form of the check above: not "a test exists here today" but
  // "a new test dropped here tomorrow would be found".
  for (const subtree of REQUIRED_SUBTREES) {
    const sentinel = path.join(PHASE7_ROOT, subtree, '.discovery-sentinel.test.mjs');
    fs.writeFileSync(sentinel, 'export default null;\n');
    try {
      const discovered = discoverPhase7Tests();
      assert.ok(discovered.includes(sentinel), `sentinel in ${subtree} was not discovered by the canonical runner`);
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  }
});

test('no owned Phase 7 test file escapes canonical discovery', () => {
  const discovered = new Set(discoverPhase7Tests());
  const onDisk = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) onDisk.push(absolute);
    }
  };
  visit(PHASE7_ROOT);
  const missed = onDisk.filter((file) => !discovered.has(file));
  assert.deepEqual(missed, [], 'these Phase 7 test files exist but are not discovered by the canonical runner');
});

test('the canonical Phase 7 runner is wired into the repository check path', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['phase7:test'], 'node tests/phase7/run.mjs', 'phase7:test must invoke the canonical runner');
  assert.ok(
    String(packageJson.scripts.check).includes('phase7:test'),
    'npm run check must include phase7:test, otherwise Phase 7 tests never run in the canonical gate',
  );
  assert.ok(packageJson.scripts['phase7:verify'], 'phase7:verify entry point must exist');
});
