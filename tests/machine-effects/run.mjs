import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) throw new Error('machine-effects: no Phase 2 tests discovered');
for (const file of files) {
  process.stdout.write(`[machine-effects] ${file}\n`);
  await import(pathToFileURL(path.join(directory, file)).href);
}
console.log(`machine-effects: PASS (${files.length} files)`);
