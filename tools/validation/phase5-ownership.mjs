import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'tools/validation/phase-ownership/phase5.json');
const EXPECTED_LANES = Object.freeze(['p5-0', 'p5-1', 'p5-2', 'p5-3', 'p5-4', 'p5-5', 'p5-6', 'p5-i']);
const EXPECTED_COMPONENT_LANES = Object.freeze(['p5-1', 'p5-2', 'p5-3', 'p5-4', 'p5-5', 'p5-6']);

export function regexFor(glob) {
  let out = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      // Git permits newlines in path names. Do not use `.`, which excludes them
      // and would make the ownership result depend on an unsafe line split.
      out += '[\\s\\S]*';
      index += 1;
    } else if (character === '*') {
      out += '[^/]*';
    } else {
      out += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function matches(file, patterns) {
  return patterns.some((pattern) => regexFor(pattern).test(file));
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

function validateOwnerMap(manifest, pathField, ownerField, errors) {
  const patterns = manifest[pathField];
  const owners = manifest[ownerField];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    errors.push(`${pathField} must be a non-empty array`);
    return;
  }
  if (!owners || typeof owners !== 'object' || Array.isArray(owners)) {
    errors.push(`${ownerField} must be an object`);
    return;
  }
  if (!sameMembers(Object.keys(owners), patterns)) {
    errors.push(`${ownerField} must have exactly one entry for every ${pathField} pattern`);
  }
  for (const [pattern, laneIds] of Object.entries(owners)) {
    if (!patterns.includes(pattern)) errors.push(`${ownerField} contains undeclared pattern: ${pattern}`);
    if (!Array.isArray(laneIds) || laneIds.length === 0) {
      errors.push(`${ownerField}.${pattern} must have at least one owner`);
      continue;
    }
    for (const lane of laneIds) if (!manifest.lanes?.[lane]) errors.push(`${ownerField}.${pattern} names unknown lane: ${lane}`);
  }
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be an object'];
  if (manifest.phase !== 5) errors.push('phase must be 5');
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) errors.push('version must be a positive integer');
  if (!manifest.lanes || typeof manifest.lanes !== 'object' || Array.isArray(manifest.lanes)) {
    errors.push('lanes must be an object');
  } else {
    const laneIds = Object.keys(manifest.lanes);
    if (!sameMembers(laneIds, EXPECTED_LANES)) errors.push(`lanes must be exactly: ${EXPECTED_LANES.join(', ')}`);
    for (const [lane, patterns] of Object.entries(manifest.lanes)) {
      if (!Array.isArray(patterns) || patterns.length === 0) errors.push(`${lane} must own at least one path`);
      else if (patterns.some((pattern) => typeof pattern !== 'string' || pattern.length === 0)) errors.push(`${lane} has an invalid path pattern`);
    }
  }
  if (manifest.integrationLane !== 'p5-i') errors.push('integrationLane must be p5-i');
  if (!Array.isArray(manifest.componentLanes) || !sameMembers(manifest.componentLanes, EXPECTED_COMPONENT_LANES)) {
    errors.push(`componentLanes must be exactly: ${EXPECTED_COMPONENT_LANES.join(', ')}`);
  }
  validateOwnerMap(manifest, 'contractPaths', 'contractWriteOwners', errors);
  validateOwnerMap(manifest, 'sharedIntegrationPaths', 'sharedIntegrationWriteOwners', errors);
  for (const field of ['generatedPaths', 'releaseOnlyPaths', 'forbiddenPaths']) {
    if (!Array.isArray(manifest[field]) || manifest[field].length === 0) errors.push(`${field} must be a non-empty array`);
  }
  for (const [field, expectedPaths] of [['generatedWriteOwners', manifest.generatedPaths], ['releaseWriteOwners', manifest.releaseOnlyPaths]]) {
    const owners = manifest[field];
    if (!Array.isArray(owners) || owners.length === 0) errors.push(`${field} must contain at least one lane`);
    else for (const lane of owners) if (!manifest.lanes?.[lane]) errors.push(`${field} names unknown lane: ${lane}`);
    if (!Array.isArray(expectedPaths)) errors.push(`${field} has no corresponding path list`);
  }
  return errors;
}

export function loadManifest(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = validateManifest(manifest);
  if (errors.length) throw new TypeError(`invalid Phase 5 ownership manifest: ${errors.join('; ')}`);
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

function unauthorizedPatterns(file, patterns, ownerMap, lane) {
  return patterns.filter((pattern) => regexFor(pattern).test(file) && !ownerMap[pattern].includes(lane));
}

export function validateFiles(manifest, lane, files, { allowEmpty = false } = {}) {
  if (!manifest.lanes[lane]) throw new TypeError(`unknown Phase 5 lane: ${lane}`);
  if (!Array.isArray(files)) throw new TypeError('changed-file inventory must be an array');
  if (!allowEmpty && files.length === 0) throw new TypeError('changed-file inventory must not be empty');

  const unique = Array.from(new Set(files)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const violations = [];
  for (const file of unique) {
    const invalid = validateRepositoryPath(file);
    if (invalid) {
      violations.push({ file, category: 'invalid-path', detail: invalid });
      continue;
    }
    if (matches(file, manifest.forbiddenPaths)) {
      violations.push({ file, category: 'forbidden', detail: 'path is forbidden to every Phase 5 lane' });
    }
    if (!matches(file, manifest.lanes[lane])) {
      violations.push({ file, category: 'outside-lane', detail: `${lane} owns no matching path` });
    }
    for (const pattern of unauthorizedPatterns(file, manifest.contractPaths, manifest.contractWriteOwners, lane)) {
      violations.push({ file, category: 'frozen-contract', detail: `${lane} is not a contract write owner for ${pattern}` });
    }
    for (const pattern of unauthorizedPatterns(file, manifest.sharedIntegrationPaths, manifest.sharedIntegrationWriteOwners, lane)) {
      violations.push({ file, category: 'shared-integration', detail: `${lane} is not a shared write owner for ${pattern}` });
    }
    if (matches(file, manifest.generatedPaths) && !manifest.generatedWriteOwners.includes(lane)) {
      violations.push({ file, category: 'generated', detail: `${lane} may not publish generated outputs` });
    }
    if (matches(file, manifest.releaseOnlyPaths) && !manifest.releaseWriteOwners.includes(lane)) {
      violations.push({ file, category: 'release-only', detail: `${lane} may not edit release-only paths` });
    }
  }
  return Object.freeze({ lane, files: Object.freeze(unique), violations: Object.freeze(violations), valid: violations.length === 0 });
}

function exactCommit(root, sha, label) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || ''))) throw new TypeError(`${label} must be an exact 40-character commit SHA`);
  const result = spawnSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new TypeError(`${label} is not an available commit: ${sha}`);
  const resolved = String(result.stdout || '').trim();
  if (resolved.toLowerCase() !== String(sha).toLowerCase()) throw new TypeError(`${label} did not resolve exactly: ${sha}`);
  return resolved;
}

export function inventoryFromGit(root, baseSha, headSha) {
  const base = exactCommit(root, baseSha, 'baseSha');
  const head = exactCommit(root, headSha, 'headSha');
  const mergeBase = spawnSync('git', ['merge-base', base, head], { cwd: root, encoding: 'utf8' });
  if (mergeBase.status !== 0 || !String(mergeBase.stdout || '').trim()) throw new TypeError(`baseSha and headSha have no merge base: ${base} ${head}`);
  const result = spawnSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new TypeError(`unable to obtain changed-file inventory for ${base}...${head}`);
  const bytes = result.stdout || Buffer.alloc(0);
  const files = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) files.push(bytes.subarray(start, index).toString('utf8'));
    start = index + 1;
  }
  if (start !== bytes.length) throw new TypeError('git changed-file inventory was not NUL-terminated');
  return Object.freeze({ baseSha: base, headSha: head, files: Object.freeze(files) });
}

export function inventoryDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of Array.from(new Set(files)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
    const encoded = Buffer.from(file);
    hash.update(String(encoded.length));
    hash.update(':');
    hash.update(encoded);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

export function validateUnionLedger(manifest, ledger, { root = ROOT, inventoryResolver = inventoryFromGit } = {}) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new TypeError('union manifest must be an object');
  const allowedKeys = new Set(['version', 'foundationSha', 'components']);
  for (const key of Object.keys(ledger)) if (!allowedKeys.has(key)) throw new TypeError(`union manifest has unexpected field: ${key}`);
  if (ledger.version !== 1) throw new TypeError('union manifest version must be 1');
  if (!/^[0-9a-f]{40}$/i.test(String(ledger.foundationSha || ''))) throw new TypeError('union foundationSha must be an exact 40-character commit SHA');
  if (!Array.isArray(ledger.components)) throw new TypeError('union components must be an array');
  const lanes = ledger.components.map((item) => item?.lane);
  if (!sameMembers(lanes, manifest.componentLanes) || new Set(lanes).size !== manifest.componentLanes.length) {
    throw new TypeError(`union components must contain each component lane exactly once: ${manifest.componentLanes.join(', ')}`);
  }

  const union = [];
  const components = [];
  for (const lane of manifest.componentLanes) {
    const component = ledger.components.find((item) => item?.lane === lane);
    const keys = Object.keys(component || {});
    if (!sameMembers(keys, ['lane', 'baseSha', 'headSha'])) throw new TypeError(`${lane} union entry must contain only lane, baseSha, and headSha`);
    if (String(component.baseSha).toLowerCase() !== String(ledger.foundationSha).toLowerCase()) {
      throw new TypeError(`${lane} baseSha does not equal the frozen foundationSha`);
    }
    const inventory = inventoryResolver(root, component.baseSha, component.headSha);
    const validation = validateFiles(manifest, lane, inventory.files);
    if (!validation.valid) {
      const error = new Error(`${lane} actual inventory violates Phase 5 ownership`);
      error.ownershipViolation = true;
      error.violations = validation.violations;
      throw error;
    }
    union.push(...validation.files);
    components.push(Object.freeze({ lane, baseSha: inventory.baseSha, headSha: inventory.headSha, changedFiles: validation.files.length, inventoryDigest: inventoryDigest(validation.files) }));
  }
  const integrationValidation = validateFiles(manifest, manifest.integrationLane, union);
  if (!integrationValidation.valid) {
    const error = new Error('actual component union is not representable by p5-i');
    error.ownershipViolation = true;
    error.violations = integrationValidation.violations;
    throw error;
  }
  return Object.freeze({
    phase: 5,
    manifestVersion: manifest.version,
    foundationSha: ledger.foundationSha.toLowerCase(),
    components: Object.freeze(components),
    integrationLane: manifest.integrationLane,
    unionFileCount: integrationValidation.files.length,
    unionDigest: inventoryDigest(integrationValidation.files),
    violations: 0,
  });
}

function parseArguments(argv) {
  const allowed = new Set(['--lane', '--files-json', '--base-sha', '--head-sha', '--union-manifest', '--check-manifest']);
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
      stdout.write(`${JSON.stringify({ phase: 5, manifestVersion: manifest.version, lanes: EXPECTED_LANES, valid: true })}\n`);
      return 0;
    }
    if (args.has('--union-manifest')) {
      if (args.size !== 1) throw new TypeError('--union-manifest cannot be combined with lane inventory arguments');
      const ledger = JSON.parse(fs.readFileSync(path.resolve(root, args.get('--union-manifest')), 'utf8'));
      stdout.write(`${JSON.stringify(validateUnionLedger(manifest, ledger, { root }))}\n`);
      return 0;
    }

    const lane = args.get('--lane');
    if (!lane) throw new TypeError(`declare --lane ${EXPECTED_LANES.join('|')}`);
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
    const validation = validateFiles(manifest, lane, files);
    if (!validation.valid) {
      for (const item of validation.violations) stderr.write(`phase5 ownership: ${item.category}: ${JSON.stringify(item.file)}: ${item.detail}\n`);
      return 1;
    }
    stdout.write(`${JSON.stringify({ phase: 5, manifestVersion: manifest.version, lane, baseSha, headSha, changedFiles: validation.files.length, inventoryDigest: inventoryDigest(validation.files), violations: 0 })}\n`);
    return 0;
  } catch (error) {
    const prefix = error.ownershipViolation ? 'ownership violation' : 'invalid invocation or configuration';
    stderr.write(`phase5 ownership: ${prefix}: ${error.message}\n`);
    if (Array.isArray(error.violations)) {
      for (const item of error.violations) stderr.write(`phase5 ownership: ${item.category}: ${JSON.stringify(item.file)}: ${item.detail}\n`);
    }
    return error.ownershipViolation ? 1 : 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
