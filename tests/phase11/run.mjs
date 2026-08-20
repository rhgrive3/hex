import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findTests(dir) {
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

const testFiles = findTests(__dirname).sort();
console.log(`\n========================================`);
console.log(`Phase 11 Managed Frontends Test Suite`);
console.log(`Discovered ${testFiles.length} test files`);
console.log(`========================================\n`);

let passed = 0;
let failed = 0;
const failures = [];

for (const file of testFiles) {
  const relPath = file.replace(__dirname, 'tests/phase11');
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
  process.exit(1);
}
