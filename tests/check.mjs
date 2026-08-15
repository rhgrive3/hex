/* Dependency-free syntax lint for every authored JavaScript module. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const dir of ['js', 'tests', 'tools/validation']) {
  const full = path.join(root, dir);
  if (fs.existsSync(full)) walk(full);
}

let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr || result.stdout || (file + ': syntax check failed\n'));
  }
}
if (failed) process.exit(1);
process.stdout.write(`syntax lint: ${files.length} files ok\n`);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(m?js)$/.test(entry.name)) files.push(file);
  }
}
