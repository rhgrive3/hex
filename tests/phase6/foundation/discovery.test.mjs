import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverPhase6Tests } from '../run.mjs';

const PHASE6_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(PHASE6_ROOT, '../..');

/**
 * Phase 4 shipped owned tests in a nested directory that the canonical runner
 * never discovered. The tests passed when run by hand and were invisible to CI.
 * These sentinels make that failure mode impossible to repeat silently.
 */
const REQUIRED_SUBTREES = Object.freeze([
  'foundation',
  'decoder',
  'registers',
  'effects',
  'abi',
  'elf',
  'generic-core',
  'cross-architecture',
  'browser',
  'vertical',
  'verification',
  'ownership',
]);

test('every Phase 6 test subtree is reachable from the canonical runner', () => {
  const discovered = discoverPhase6Tests().map((file) => path.relative(PHASE6_ROOT, file).replaceAll('\\', '/'));
  assert.ok(discovered.length > 0, 'canonical runner must discover Phase 6 tests');
  for (const subtree of REQUIRED_SUBTREES) {
    const directory = path.join(PHASE6_ROOT, subtree);
    assert.ok(fs.existsSync(directory), `required Phase 6 subtree is missing: ${subtree}`);
    assert.ok(
      discovered.some((file) => file.startsWith(`${subtree}/`)),
      `canonical runner discovered no test in required subtree: ${subtree}`,
    );
  }
});

test('no owned Phase 6 test file escapes canonical discovery', () => {
  const discovered = new Set(discoverPhase6Tests());
  const onDisk = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) onDisk.push(absolute);
    }
  };
  visit(PHASE6_ROOT);
  const missed = onDisk.filter((file) => !discovered.has(file));
  assert.deepEqual(missed, [], 'these Phase 6 test files exist but are not discovered by the canonical runner');
});

test('the canonical Phase 6 runner is wired into the repository check path', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['phase6:test'], 'node tests/phase6/run.mjs', 'phase6:test must invoke the canonical runner');
  assert.ok(
    String(packageJson.scripts.check).includes('phase6:test'),
    'npm run check must include phase6:test, otherwise Phase 6 tests never run in the canonical gate',
  );
  assert.ok(packageJson.scripts['phase6:verify'], 'phase6:verify entry point must exist');
});
