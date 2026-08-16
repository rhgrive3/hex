import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template = path.join(root, 'userscript/hex.user.template.js');
const before = fs.readFileSync(template, 'utf8');
const child = spawnSync('npm', ['run', 'userscript:test'], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 180_000,
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
assert.equal(child.status, 0, `npm run userscript:test failed${child.signal ? ` (${child.signal})` : ''}`);

const generated = fs.readFileSync(template, 'utf8');
if (generated !== before) {
  let first = 0;
  const min = Math.min(before.length, generated.length);
  while (first < min && before[first] === generated[first]) first++;
  let tail = 0;
  while (tail < min - first && before[before.length - 1 - tail] === generated[generated.length - 1 - tail]) tail++;
  const ids = [...generated.matchAll(/[0-9a-f]{24}/ig)].map((match) => match[0]);
  const start = Math.max(0, first - 80);
  const oldEnd = Math.min(before.length, before.length - tail + 80);
  const newEnd = Math.min(generated.length, generated.length - tail + 80);
  const delta = {
    first,
    tail,
    beforeLength:before.length,
    generatedLength:generated.length,
    buildIds:ids,
    beforeSegment:before.slice(start, oldEnd),
    generatedSegment:generated.slice(start, newEnd),
  };
  console.log(`::warning title=P3_USER_DIFF::${JSON.stringify(delta).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  fs.writeFileSync(template, before);
  throw new Error(`userscript-generated-template-out-of-sync:${ids[0] ?? 'unknown'}`);
}
console.log('Phase 3 userscript:test and committed generated template sync: PASS');