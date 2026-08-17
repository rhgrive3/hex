import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shouldRun = !process.env.GITHUB_ACTIONS || process.env.GITHUB_WORKFLOW === 'Semantic IR v2 contracts';

if (!shouldRun) {
  console.log(`Phase 3 mandatory existing regression commands: delegated to Semantic IR v2 contracts workflow (current=${process.env.GITHUB_WORKFLOW ?? 'unknown'})`);
} else {
  const scripts = [
    'effects:test',
    'core:test',
    'invariants:test',
    'migration:test',
    'semantic:test',
    'decompiler:test',
    'compiler-truth',
    'platform:test',
    'runtime:test',
    'ui:test',
    'benchmark:baseline',
  ];
  const results = [];
  for (const script of scripts) {
    const child = spawnSync('npm', ['run', script], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 240_000,
    });
    process.stdout.write(`\n[phase3-required] npm run ${script}\n`);
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    results.push({ script, status: child.status, signal: child.signal ?? null, passed: child.status === 0 });
  }
  globalThis.__HEX_PHASE3_REQUIRED_REGRESSION_GATES__ = Object.freeze(results);
  const failures = results.filter((result) => !result.passed);
  assert.deepEqual(failures, [], `mandatory existing regression commands failed: ${JSON.stringify(failures)}`);
  console.log('Phase 3 mandatory existing regression commands: PASS');
}
