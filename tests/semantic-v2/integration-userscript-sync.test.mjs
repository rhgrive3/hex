import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENERATED_OUTPUT_MODE,
  generatedOutputMode,
} from '../../tools/validation/generated-output-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template = path.join(root, 'userscript/hex.user.template.js');
const generatedFiles = [
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
  'js/userscript/deployment-identity.generated.js',
].map((file) => path.join(root, file));
const before = new Map(generatedFiles
  .filter((file) => fs.existsSync(file))
  .map((file) => [file, fs.readFileSync(file)]));
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
const previousTemplate = before.get(template).toString('utf8');
if (generated !== previousTemplate) {
  let first = 0;
  const min = Math.min(previousTemplate.length, generated.length);
  while (first < min && previousTemplate[first] === generated[first]) first++;
  let tail = 0;
  while (tail < min - first
    && previousTemplate[previousTemplate.length - 1 - tail] === generated[generated.length - 1 - tail]) tail++;
  const ids = [...generated.matchAll(/[0-9a-f]{24}/ig)].map((match) => match[0]);
  const start = Math.max(0, first - 80);
  const oldEnd = Math.min(previousTemplate.length, previousTemplate.length - tail + 80);
  const newEnd = Math.min(generated.length, generated.length - tail + 80);
  const delta = {
    first,
    tail,
    beforeLength:previousTemplate.length,
    generatedLength:generated.length,
    buildIds:ids,
    beforeSegment:previousTemplate.slice(start, oldEnd),
    generatedSegment:generated.slice(start, newEnd),
  };
  console.log(`::warning title=P3_USER_DIFF::${JSON.stringify(delta).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  for (const [file, bytes] of before) fs.writeFileSync(file, bytes);
  const mode = generatedOutputMode({
    eventName: process.env.GITHUB_EVENT_NAME,
    headRef: process.env.GITHUB_HEAD_REF,
    ref: process.env.GITHUB_REF,
  });
  if (mode === GENERATED_OUTPUT_MODE.EPHEMERAL) {
    console.log(`userscript generated output differs in an ephemeral component lane; integration owns synchronization (${ids[0] ?? 'unknown'})`);
  } else {
    throw new Error(`userscript-generated-template-out-of-sync:${ids[0] ?? 'unknown'}`);
  }
}
for (const [file, bytes] of before) fs.writeFileSync(file, bytes);
console.log('Phase 3 userscript:test and generated template sync policy: PASS');
