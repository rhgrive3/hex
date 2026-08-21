import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));

export function findTests(dir = ROOT) {
  const results = [];
  for (const file of readdirSync(dir).sort()) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) results.push(...findTests(fullPath));
    else if (file.endsWith('.test.mjs')) results.push(fullPath);
  }
  return results.sort();
}

export async function runPhase12Tests(argv = [], { root = ROOT } = {}) {
  if (argv.length) throw new TypeError(`phase12: unknown test argument: ${argv[0]}`);
  const testFiles = findTests(root);
  console.log(`Phase 12 tests: discovered ${testFiles.length} files`);
  let passed = 0;
  const failures = [];
  for (const file of testFiles) {
    try {
      await import(pathToFileURL(file).href);
      passed++;
    } catch (error) {
      failures.push({ file: relative(root, file), error });
      console.error(`FAIL: ${relative(root, file)}`);
      console.error(error);
    }
  }
  console.log(`Phase 12 results: ${passed} passed, ${failures.length} failed`);
  if (failures.length) throw new Error(`phase12: ${failures.length} tests failed`);
  return Object.freeze({ passed, failed: failures.length, total: testFiles.length, files: testFiles });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runPhase12Tests(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
