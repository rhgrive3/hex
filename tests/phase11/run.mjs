import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function findTests(dir) {
  let results = [];
  const list = readdirSync(dir);
  for (const file of list) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(findTests(fullPath));
    } else if (file.endsWith('.test.mjs')) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function runPhase11Tests(argv = [], { root = __dirname } = {}) {
  const testFiles = findTests(root).sort();
  console.log(`\n========================================`);
  console.log(`Phase 11 Managed Frontends Test Suite`);
  console.log(`Discovered ${testFiles.length} test files`);
  console.log(`========================================\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of testFiles) {
    const relPath = file.replace(root, 'tests/phase11');
    try {
      await import(pathToFileURL(file).href);
      passed++;
    } catch (err) {
      failed++;
      failures.push({ file: relPath, error: err });
      console.error(`FAIL: ${relPath}`);
      console.error(err);
    }
  }

  console.log(`\n========================================`);
  console.log(`Phase 11 Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    throw new Error(`phase11: ${failed} tests failed`);
  }
  return { passed, failed, total: testFiles.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    await runPhase11Tests();
  } catch {
    process.exit(1);
  }
}
