import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase11/ownership.json'), 'utf8'));

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function checkPhase11Ownership() {
  const mainRef = git(['rev-parse', '--verify', 'origin/main']) ? 'origin/main' : null;
  if (!mainRef) throw new Error('phase11 ownership: origin/main unavailable');
  const base = git(['merge-base', 'HEAD', mainRef]);
  if (!base) throw new Error('phase11 ownership: merge-base unavailable');
  const names = git(['diff', '--name-only', `${base}..HEAD`]) ?? '';
  const files = names.split('\n').map((value) => value.trim()).filter(Boolean).sort();
  const exact = new Set(manifest.allowedExact || []);
  const prefixes = manifest.allowedPrefixes || [];
  const forbidden = manifest.forbiddenPrefixes || [];
  const violations = [];
  for (const file of files) {
    if (forbidden.some((prefix) => file.startsWith(prefix))) violations.push(`forbidden:${file}`);
    else if (!exact.has(file) && !prefixes.some((prefix) => file.startsWith(prefix))) violations.push(`unowned:${file}`);
  }
  if (violations.length) throw new Error(`phase11 ownership violations: ${violations.join(', ')}`);
  console.log(`phase11 ownership: PASS (${files.length} files, base ${base})`);
  return Object.freeze({ base, files });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { checkPhase11Ownership(); }
  catch (error) { console.error(error); process.exit(1); }
}
