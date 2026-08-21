import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const MANIFEST_PATH = path.join(ROOT, 'tools/validation/phase12/ownership.json');

export function loadManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function shouldSkipPhase12Ownership({
  eventName = process.env.GITHUB_EVENT_NAME,
  headRef = process.env.GITHUB_HEAD_REF,
} = {}) {
  return String(eventName || '') === 'pull_request'
    && String(headRef || '').startsWith('dev-agent-hardening/');
}

function normalize(value) { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function matches(file, pattern) {
  const value = normalize(file);
  const rule = normalize(pattern);
  if (rule.endsWith('/**')) return value === rule.slice(0, -3) || value.startsWith(rule.slice(0, -2));
  if (rule.endsWith('**')) return value.startsWith(rule.slice(0, -2));
  if (rule.includes('*')) {
    const escaped = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '.*').replaceAll('*', '[^/]*');
    return new RegExp(`^${escaped}$`).test(value);
  }
  return value === rule;
}

export function validateManifest(manifest = loadManifest()) {
  const errors = [];
  if (manifest.schemaVersion !== 'phase12-ownership/v1') errors.push('schemaVersion must be phase12-ownership/v1');
  const lanes = manifest.lanes && typeof manifest.lanes === 'object' ? manifest.lanes : {};
  const expected = ['p12-k', 'p12-c', 'p12-p', 'p12-r', 'p12-reviewer', 'p12-integration'];
  if (JSON.stringify(Object.keys(lanes).sort()) !== JSON.stringify(expected.slice().sort())) errors.push(`lanes must be exactly: ${expected.join(', ')}`);
  for (const [lane, patterns] of Object.entries(lanes)) {
    if (!Array.isArray(patterns) || patterns.length === 0) errors.push(`${lane} must have a non-empty path inventory`);
    for (const pattern of patterns || []) if (typeof pattern !== 'string' || !pattern) errors.push(`${lane} contains an invalid path pattern`);
  }
  for (const field of ['contractPaths', 'sharedIntegrationPaths', 'generatedPaths', 'releaseOnlyPaths', 'forbiddenPaths']) {
    if (!Array.isArray(manifest[field])) errors.push(`${field} must be an array`);
  }
  for (const field of ['generatedWriteOwners', 'releaseWriteOwners']) {
    const values = manifest[field];
    if (!Array.isArray(values) || values.length !== 1 || !expected.includes(values[0])) errors.push(`${field} must name exactly one known lane`);
  }
  for (const field of ['generatedPaths', 'releaseOnlyPaths']) {
    for (const pattern of manifest[field] || []) {
      const owners = Object.entries(lanes).filter(([, patterns]) => patterns.some((candidate) => matches(pattern, candidate) || matches(candidate, pattern))).map(([lane]) => lane);
      const ownerField = field === 'generatedPaths' ? manifest.generatedWriteOwners : manifest.releaseWriteOwners;
      if (!ownerField?.some((lane) => owners.includes(lane))) errors.push(`${field} declares a path no declared writer owns: ${pattern}`);
    }
  }
  const component = new Set(manifest.componentLanes || []);
  for (const lane of component) if (!expected.includes(lane) || lane === 'p12-integration') errors.push(`invalid component lane: ${lane}`);
  return errors;
}

export function validateFiles(files, lane, manifest = loadManifest()) {
  const errors = validateManifest(manifest);
  const patterns = manifest.lanes?.[lane];
  if (!patterns) return { ok: false, lane, files: [...files], violations: [...errors, `unknown lane: ${lane}`] };
  const violations = [];
  for (const file of [...new Set([...files].map(normalize).filter(Boolean))].sort()) {
    const forbidden = (manifest.forbiddenPaths || []).some((pattern) => matches(file, pattern));
    const generated = (manifest.generatedPaths || []).some((pattern) => matches(file, pattern));
    const releaseOnly = (manifest.releaseOnlyPaths || []).some((pattern) => matches(file, pattern));
    if (forbidden) violations.push({ file, category: 'forbidden', detail: 'path is globally forbidden to Phase 12 lanes' });
    else if (generated && !manifest.generatedWriteOwners.includes(lane)) violations.push({ file, category: 'generated', detail: `${lane} may not publish generated output` });
    else if (releaseOnly && !manifest.releaseWriteOwners.includes(lane)) violations.push({ file, category: 'release', detail: `${lane} may not publish release evidence` });
    else if (!patterns.some((pattern) => matches(file, pattern))) violations.push({ file, category: 'unowned', detail: `${lane} does not own this path` });
  }
  return { ok: errors.length === 0 && violations.length === 0, lane, files: [...files].map(normalize).filter(Boolean).sort(), violations, manifestErrors: errors };
}

function declaredOwners(file, manifest) {
  return Object.entries(manifest.lanes || {})
    .filter(([, patterns]) => patterns.some((pattern) => matches(file, pattern)))
    .map(([lane]) => lane);
}

export function validateAggregateFiles(files, manifest = loadManifest()) {
  const errors = validateManifest(manifest);
  const violations = [];
  const normalizedFiles = [...new Set([...files].map(normalize).filter(Boolean))].sort();
  for (const file of normalizedFiles) {
    const forbidden = (manifest.forbiddenPaths || []).some((pattern) => matches(file, pattern));
    const generated = (manifest.generatedPaths || []).some((pattern) => matches(file, pattern));
    const releaseOnly = (manifest.releaseOnlyPaths || []).some((pattern) => matches(file, pattern));
    const owners = declaredOwners(file, manifest);
    if (forbidden) {
      violations.push({ file, category: 'forbidden', detail: 'path is globally forbidden to Phase 12 lanes' });
    } else if (generated && !manifest.generatedWriteOwners.some((lane) => owners.includes(lane))) {
      violations.push({ file, category: 'generated', detail: 'no declared generated-output owner covers this path' });
    } else if (releaseOnly && !manifest.releaseWriteOwners.some((lane) => owners.includes(lane))) {
      violations.push({ file, category: 'release', detail: 'no declared release-evidence owner covers this path' });
    } else if (owners.length === 0) {
      violations.push({ file, category: 'unowned', detail: 'no declared Phase 12 lane owns this path' });
    }
  }
  return { ok: errors.length === 0 && violations.length === 0, lane: 'aggregate', files: normalizedFiles, violations, manifestErrors: errors };
}

function git(args, root = ROOT) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function exactSha(value, label) {
  if (!/^[0-9a-f]{40}$/i.test(String(value || ''))) throw new TypeError(`${label} must be an exact commit SHA`);
  const resolved = git(['rev-parse', `${value}^{commit}`]);
  if (resolved.toLowerCase() !== String(value).toLowerCase()) throw new TypeError(`${label} did not resolve exactly: ${value}`);
  return resolved;
}

export function inventoryFromGit(baseSha, headSha, root = ROOT) {
  const base = exactSha(baseSha, 'baseSha');
  const head = exactSha(headSha, 'headSha');
  const output = git(['diff', '--name-only', `${base}..${head}`], root);
  return output ? output.split('\n').map(normalize).filter(Boolean).sort() : [];
}

export function inventoryDigest(files) {
  const crypto = awaitImportCrypto();
  return crypto.createHash('sha256').update([...new Set(files.map(normalize).filter(Boolean))].sort().join('\n')).digest('hex');
}

function awaitImportCrypto() {
  // crypto is imported lazily so this validator remains usable in small test
  // harnesses that only need manifest validation.
  return requireCrypto;
}

import crypto from 'node:crypto';
const requireCrypto = crypto;

export function runOwnership({ baseSha, headSha, lane, root = ROOT, manifest = loadManifest() }) {
  const files = inventoryFromGit(baseSha, headSha, root);
  const result = validateFiles(files, lane, manifest);
  if (!result.ok) {
    const error = new Error(`phase12 ownership violations: ${result.violations.map((item) => `${item.category}:${item.file}`).join(', ') || result.manifestErrors.join('; ')}`);
    error.ownershipViolation = true;
    error.result = result;
    throw error;
  }
  return Object.freeze({ ...result, baseSha, headSha, inventoryDigest: inventoryDigest(files) });
}

export function runAggregateOwnership({ baseSha, headSha, root = ROOT, manifest = loadManifest() }) {
  const files = inventoryFromGit(baseSha, headSha, root);
  const result = validateAggregateFiles(files, manifest);
  if (!result.ok) {
    const error = new Error(`phase12 aggregate ownership violations: ${result.violations.map((item) => `${item.category}:${item.file}`).join(', ') || result.manifestErrors.join('; ')}`);
    error.ownershipViolation = true;
    error.result = result;
    throw error;
  }
  return Object.freeze({ ...result, baseSha, headSha, inventoryDigest: inventoryDigest(files) });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (shouldSkipPhase12Ownership()) {
    console.log('phase12 ownership: SKIP (Dev Agent hardening has a separate ownership spine)');
    process.exit(0);
  }
  const mode = process.argv[2];
  const baseSha = process.argv[3];
  const headSha = process.argv[4];
  try {
    if (!mode || !baseSha || !headSha) throw new TypeError('usage: node ownership.mjs <lane|aggregate> <base-sha> <head-sha>');
    const result = mode === 'aggregate'
      ? runAggregateOwnership({ baseSha, headSha })
      : runOwnership({ lane: mode, baseSha, headSha });
    console.log(`phase12 ownership${mode === 'aggregate' ? ' aggregate' : ''}: PASS (${result.files.length} files, base ${result.baseSha}, head ${result.headSha})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
