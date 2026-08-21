import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const self = path.basename(fileURLToPath(import.meta.url));
function discover(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? discover(path.join(dir, entry.name))
      : entry.name.endsWith('.test.mjs') && entry.name !== self ? [path.join(dir, entry.name)] : [])
    .sort();
}
const files = discover(root);
if (!files.length) throw new Error('stage2-test-discovery-empty');
for (const file of files) await import(pathToFileURL(file).href);
console.log(`stage2 tests: PASS (${files.length} files)`);
