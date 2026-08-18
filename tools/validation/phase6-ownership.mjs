import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryDigest, inventoryFromGit, regexFor } from './phase5-ownership.mjs';

/**
 * Phase 6 ownership gate.
 *
 * Phase 6 has one owner and one branch, so there is no lane race to police.
 * The manifest still earns its place: it makes "may this change touch that
 * file" a checkable property, and it is what stops a RISC-V integration from
 * quietly editing ARM64 semantics or another phase's frozen evidence to make
 * itself pass.
 *
 * The glob and git-inventory helpers are imported from the Phase 5 gate rather
 * than reimplemented, so both phases agree on what a path pattern means.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'tools/validation/phase-ownership/phase6.json');
const EXPECTED_LANES = Object.freeze(['p6']);

export { inventoryDigest, inventoryFromGit, regexFor };

function matches(file, patterns) {
  return patterns.some((pattern) => regexFor(pattern).test(file));
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be an object'];
  if (manifest.phase !== 6) errors.push('phase must be 6');
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) errors.push('version must be a positive integer');
  if (manifest.singleOwnerLane !== 'p6') errors.push('singleOwnerLane must be p6');
  if (!manifest.lanes || typeof manifest.lanes !== 'object' || Array.isArray(manifest.lanes)) {
    errors.push('lanes must be an object');
  } else if (!sameMembers(Object.keys(manifest.lanes), EXPECTED_LANES)) {
    errors.push(`lanes must be exactly: ${EXPECTED_LANES.join(', ')}`);
  } else if (!Array.isArray(manifest.lanes.p6) || manifest.lanes.p6.length === 0) {
    errors.push('p6 must own at least one path');
  }
  for (const field of ['contractPaths', 'sharedIntegrationPaths', 'generatedPaths', 'releaseOnlyPaths', 'forbiddenPaths']) {
    if (!Array.isArray(manifest[field]) || manifest[field].length === 0) errors.push(`${field} must be a non-empty array`);
  }
  // A forbidden path that the lane also owns would be silently contradictory.
  for (const forbidden of manifest.forbiddenPaths ?? []) {
    if ((manifest.lanes?.p6 ?? []).includes(forbidden)) errors.push(`path is both owned and forbidden: ${forbidden}`);
  }
  return errors;
}

export function loadManifest(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = validateManifest(manifest);
  if (errors.length) throw new TypeError(`invalid Phase 6 ownership manifest: ${errors.join('; ')}`);
  return manifest;
}

function validateRepositoryPath(file) {
  if (typeof file !== 'string' || file.length === 0) return 'path must be a non-empty string';
  if (file.includes('\0')) return 'path must not contain NUL';
  if (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return 'path must be repository-relative';
  const segments = file.split('/');
  if (segments.includes('..') || segments.includes('.')) return 'path must not contain traversal segments';
  return null;
}

export function validateFiles(manifest, files, { allowEmpty = false } = {}) {
  if (!Array.isArray(files)) throw new TypeError('changed-file inventory must be an array');
  if (!allowEmpty && files.length === 0) throw new TypeError('changed-file inventory must not be empty');
  const unique = Array.from(new Set(files)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const violations = [];
  for (const file of unique) {
    const invalid = validateRepositoryPath(file);
    if (invalid) { violations.push({ file, category: 'invalid-path', detail: invalid }); continue; }
    if (matches(file, manifest.forbiddenPaths)) {
      const rationale = Object.entries(manifest.forbiddenRationale ?? {})
        .find(([pattern]) => regexFor(pattern).test(file))?.[1] ?? 'path is forbidden to Phase 6';
      violations.push({ file, category: 'forbidden', detail: rationale });
    }
    if (!matches(file, manifest.lanes.p6)) {
      violations.push({ file, category: 'outside-lane', detail: 'p6 owns no matching path' });
    }
  }
  return Object.freeze({ lane: 'p6', files: Object.freeze(unique), violations: Object.freeze(violations), valid: violations.length === 0 });
}

function parseArguments(argv) {
  const allowed = new Set(['--files-json', '--base-sha', '--head-sha', '--check-manifest']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!allowed.has(token)) throw new TypeError(`unknown argument: ${token}`);
    if (values.has(token)) throw new TypeError(`duplicate argument: ${token}`);
    if (token === '--check-manifest') values.set(token, true);
    else {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) throw new TypeError(`missing value for ${token}`);
      values.set(token, value);
      index += 1;
    }
  }
  return values;
}

export function runCli(argv = process.argv.slice(2), { root = ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArguments(argv);
    const manifest = loadManifest();
    if (args.has('--check-manifest')) {
      if (args.size !== 1) throw new TypeError('--check-manifest cannot be combined with inventory arguments');
      stdout.write(`${JSON.stringify({ phase: 6, manifestVersion: manifest.version, lanes: EXPECTED_LANES, valid: true })}\n`);
      return 0;
    }
    const usesJson = args.has('--files-json');
    const usesGit = args.has('--base-sha') || args.has('--head-sha');
    if (usesJson === usesGit) throw new TypeError('choose exactly one inventory source: --files-json or --base-sha with --head-sha');
    let files;
    let baseSha = null;
    let headSha = null;
    if (usesJson) {
      const parsed = JSON.parse(args.get('--files-json'));
      if (!Array.isArray(parsed)) throw new TypeError('--files-json must encode an array');
      files = parsed;
    } else {
      if (!args.has('--base-sha') || !args.has('--head-sha')) throw new TypeError('--base-sha and --head-sha are both required');
      const inventory = inventoryFromGit(root, args.get('--base-sha'), args.get('--head-sha'));
      ({ files, baseSha, headSha } = inventory);
    }
    const validation = validateFiles(manifest, files);
    if (!validation.valid) {
      for (const item of validation.violations) stderr.write(`phase6 ownership: ${item.category}: ${JSON.stringify(item.file)}: ${item.detail}\n`);
      return 1;
    }
    stdout.write(`${JSON.stringify({ phase: 6, manifestVersion: manifest.version, lane: 'p6', baseSha, headSha, changedFiles: validation.files.length, inventoryDigest: inventoryDigest(validation.files), violations: 0 })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`phase6 ownership: ${error.message}\n`);
    return 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
