import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../../.github/workflows/ai-eval-contract.yml', import.meta.url), 'utf8');

function pathsFor(section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${section}:`);
  assert.notEqual(start, -1, `missing ${section} trigger`);
  const paths = [];
  let inPaths = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  [A-Za-z_]/.test(line) && !line.startsWith('    ')) break;
    if (line === '    paths:') { inPaths = true; continue; }
    if (!inPaths) continue;
    const m = line.match(/^      - ['"]?(.+?)['"]?$/);
    if (m) paths.push(m[1]);
    else if (line.trim() && !line.startsWith('      ')) break;
  }
  return new Set(paths);
}

const required = [
  'js/ai/**',
  'js/agent/**',
  'js/query/**',
  'js/gemini.js',
  'js/goalc.js',
  'js/semantic-evidence.js',
  'worker.js',
];

for (const section of ['pull_request', 'push']) {
  const paths = pathsFor(section);
  for (const path of required) assert.ok(paths.has(path), `${section}.paths must include ${path}`);
}

console.log('AI evaluation workflow trigger coverage PASS');
