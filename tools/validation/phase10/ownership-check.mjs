import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase10/ownership.json'), 'utf8'));

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function phase10OwnershipViolation(file, input = manifest) {
  const exact = new Set(input.allowedExact || []);
  const prefixes = input.allowedPrefixes || [];
  const forbidden = input.forbiddenPrefixes || [];
  if (exact.has(file)) return null;
  if (forbidden.some((prefix) => file.startsWith(prefix))) return `forbidden:${file}`;
  if (!prefixes.some((prefix) => file.startsWith(prefix))) return `unowned:${file}`;
  return null;
}

export function checkPhase10Ownership() {
  const mainRef = git(['rev-parse', '--verify', 'origin/main']) ? 'origin/main' : null;
  if (!mainRef) throw new Error('phase10 ownership: origin/main unavailable');
  const base = git(['merge-base', 'HEAD', mainRef]);
  if (!base) throw new Error('phase10 ownership: merge-base unavailable');
  const names = git(['diff', '--name-only', `${base}..HEAD`]) ?? '';
  const files = names.split('\n').map((value) => value.trim()).filter(Boolean).sort();
  const violations = files.map((file) => phase10OwnershipViolation(file)).filter(Boolean);
  if (violations.length) throw new Error(`phase10 ownership violations: ${violations.join(', ')}`);
  console.log(`phase10 ownership: PASS (${files.length} files, base ${base})`);
  return Object.freeze({ base, files });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { checkPhase10Ownership(); }
  catch (error) { console.error(error); process.exit(1); }
}
