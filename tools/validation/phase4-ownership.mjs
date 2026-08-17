import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'tools/validation/phase-ownership/phase4.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

function regexFor(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { out += '.*'; i++; continue; }
    if (ch === '*') { out += '[^/]*'; continue; }
    out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
function matches(file, patterns) { return patterns.some((pattern) => regexFor(pattern).test(file)); }

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const lane = arg('lane', process.env.PHASE4_LANE || null);
if (!lane || !manifest.lanes[lane]) {
  console.error(`phase4 ownership: declare --lane ${Object.keys(manifest.lanes).join('|')}`);
  process.exit(2);
}

let changed;
const filesArg = arg('files');
if (filesArg) changed = filesArg.split(',').map((x) => x.trim()).filter(Boolean);
else {
  const base = arg('base', process.env.PHASE4_BASE || 'origin/main');
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd:ROOT, encoding:'utf8' })
      .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch (error) {
    console.error(`phase4 ownership: unable to diff base ${base}: ${error.message}`);
    process.exit(2);
  }
}

const allowed = [...manifest.lanes[lane], ...manifest.generatedPaths];
const forbidden = changed.filter((file) => matches(file, manifest.forbiddenPaths));
const outside = changed.filter((file) => !matches(file, allowed));
if (forbidden.length || outside.length) {
  if (forbidden.length) console.error(`phase4 ownership: forbidden path(s): ${forbidden.join(', ')}`);
  if (outside.length) console.error(`phase4 ownership: ${lane} owns no path matching: ${outside.join(', ')}`);
  process.exit(1);
}

// Contracts are frozen after P4-0. A component lane cannot edit them even if a
// broad lane glob would otherwise match (notably scheduler/budget directories).
if (lane !== 'p4-0' && lane !== 'p4-7') {
  const contractEdits = changed.filter((file) => matches(file, manifest.contractPaths));
  if (contractEdits.length) {
    console.error(`phase4 ownership: frozen contract path(s) are read-only in ${lane}: ${contractEdits.join(', ')}`);
    process.exit(1);
  }
}

console.log(JSON.stringify({ phase:4, manifestVersion:manifest.version, lane, changedFiles:changed.length, violations:0 }));
