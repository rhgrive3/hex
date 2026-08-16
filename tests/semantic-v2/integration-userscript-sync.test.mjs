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
  fs.writeFileSync(template, before);
  const buildId = generated.match(/buildId:_|_="([0-9a-f]{24})"/i)?.[1]
    ?? generated.match(/_="([0-9a-f]{24})"/)?.[1]
    ?? 'unknown';
  throw new Error(`userscript-generated-template-out-of-sync:${buildId}`);
}
console.log('Phase 3 userscript:test and committed generated template sync: PASS');
