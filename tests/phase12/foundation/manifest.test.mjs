import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, validateAggregateFiles, validateFiles, validateManifest } from '../../../tools/validation/phase12/ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = loadManifest();
const phaseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase12/manifest.json'), 'utf8'));

assert.deepEqual(validateManifest(manifest), []);
assert.match(phaseManifest.foundation.commitSha, /^[0-9a-f]{40}$/);
assert.match(phaseManifest.foundation.treeSha, /^[0-9a-f]{40}$/);
assert.equal(phaseManifest.foundation.phase11Evidence.commitSha, phaseManifest.foundation.commitSha);
assert.equal(phaseManifest.permanentVerifier.id, 'phase12.verifier');
assert.equal(phaseManifest.permanentVerifier.version, '1.0.0');
assert.ok(fs.existsSync(path.join(ROOT, 'tools/validation/phase12/release-evidence.schema.json')));

const componentViolation = validateFiles(['js/collaboration/operation.js'], 'p12-k', manifest);
assert.equal(componentViolation.ok, false);
assert.ok(componentViolation.violations.some((item) => item.category === 'unowned'));
const integrationPass = validateFiles(['tools/validation/phase12/verify.mjs', 'package.json'], 'p12-integration', manifest);
assert.equal(integrationPass.ok, true);
const generatedViolation = validateFiles(['reports/phase12/phase12-release-evidence.json'], 'p12-c', manifest);
assert.equal(generatedViolation.ok, false);
assert.ok(generatedViolation.violations.some((item) => item.category === 'generated' || item.category === 'release'));
const userscriptGeneratedViolation = validateFiles(['userscript/hex.user.template.js'], 'p12-c', manifest);
assert.equal(userscriptGeneratedViolation.ok, false);
assert.ok(userscriptGeneratedViolation.violations.some((item) => item.category === 'generated'));
const aggregatePass = validateAggregateFiles([
  'js/collaboration/index.js',
  'js/knowledge/phase12-rules.js',
  'tests/phase12/adversarial/trust-boundaries.test.mjs',
  'tools/validation/phase12/verify.mjs',
  'userscript/hex.user.template.js',
], manifest);
assert.equal(aggregatePass.ok, true);
const aggregateViolation = validateAggregateFiles(['js/unknown-phase12-file.js'], manifest);
assert.equal(aggregateViolation.ok, false);
assert.ok(aggregateViolation.violations.some((item) => item.category === 'unowned'));

console.log('[phase12] foundation manifest and ownership tests passed');
