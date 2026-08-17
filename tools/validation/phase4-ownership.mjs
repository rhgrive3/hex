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

function failConfiguration(message) {
  console.error(`phase4 ownership: invalid manifest: ${message}`);
  process.exit(2);
}

if (!manifest.contractWriteOwners || typeof manifest.contractWriteOwners !== 'object' || Array.isArray(manifest.contractWriteOwners)) {
  failConfiguration('contractWriteOwners must be an object');
}

const contractPathSet = new Set(manifest.contractPaths);
for (const contractPath of manifest.contractPaths) {
  if (!Object.hasOwn(manifest.contractWriteOwners, contractPath)) {
    failConfiguration(`contract path has no explicit write-owner entry: ${contractPath}`);
  }
  const owners = manifest.contractWriteOwners[contractPath];
  if (!Array.isArray(owners) || owners.length === 0) {
    failConfiguration(`contract path has no explicit write owner: ${contractPath}`);
  }
  for (const owner of owners) {
    if (!manifest.lanes[owner]) failConfiguration(`unknown contract write owner ${owner} for ${contractPath}`);
  }
}
for (const contractPath of Object.keys(manifest.contractWriteOwners)) {
  if (!contractPathSet.has(contractPath)) {
    failConfiguration(`contractWriteOwners contains non-contract path: ${contractPath}`);
  }
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

// Existing generated-path behavior remains intact for canonical Phase 4 lanes.
// The repair lane is intentionally narrower: it owns only its four manifest paths.
const allowed = lane === 'p4-r'
  ? [...manifest.lanes[lane]]
  : [...manifest.lanes[lane], ...manifest.generatedPaths];
const forbidden = changed.filter((file) => matches(file, manifest.forbiddenPaths));
const outside = changed.filter((file) => !matches(file, allowed));
if (forbidden.length || outside.length) {
  if (forbidden.length) console.error(`phase4 ownership: forbidden path(s): ${forbidden.join(', ')}`);
  if (outside.length) console.error(`phase4 ownership: ${lane} owns no path matching: ${outside.join(', ')}`);
  process.exit(1);
}

// Frozen contract paths have explicit write owners. Broad directory ownership is
// never sufficient by itself. This keeps contracts.js P4-0-only while allowing
// designated integration entrypoints and the P4-3 ArtifactIndex implementation.
const unauthorizedContractEdits = [];
for (const file of changed) {
  if (!contractPathSet.has(file)) continue;
  const owners = manifest.contractWriteOwners[file];
  if (!owners.includes(lane)) unauthorizedContractEdits.push(file);
}
if (unauthorizedContractEdits.length) {
  console.error(`phase4 ownership: frozen contract path(s) are not writable by ${lane}: ${unauthorizedContractEdits.join(', ')}`);
  process.exit(1);
}

console.log(JSON.stringify({ phase:4, manifestVersion:manifest.version, lane, changedFiles:changed.length, violations:0 }));
