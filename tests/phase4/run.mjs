import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runVerificationOracles } from './verification/oracles.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));

function discoverTests(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes:true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...discoverTests(absolute));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(absolute);
  }
  return out;
}

const files = discoverTests(directory).sort((a, b) => a.localeCompare(b));
if (!files.length) throw new Error('phase4: no contract tests discovered');
for (const file of files) {
  const relative = path.relative(directory, file).replaceAll('\\', '/');
  process.stdout.write(`[phase4] ${relative}\n`);
  await import(pathToFileURL(file).href);
}

const verification = await runVerificationOracles();
console.log('PHASE4_VERIFICATION_ORACLES ' + JSON.stringify(verification));
const failedCases = verification.verificationCases.filter((item) => item.status !== 'pass');
const rawFailures = Object.entries(verification.rawFailures).filter(([, value]) => Number(value) !== 0);
if (failedCases.length || rawFailures.length) {
  throw new Error(`phase4 independent verification failed: cases=${failedCases.length} raw=${JSON.stringify(Object.fromEntries(rawFailures))}`);
}

console.log(`phase4: PASS (${files.length} test files + independent verification)`);
