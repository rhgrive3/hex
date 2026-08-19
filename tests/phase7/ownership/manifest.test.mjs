import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadManifest, validateFiles, validateManifest } from '../../../tools/validation/phase7-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('the Phase 7 ownership manifest is internally consistent', () => {
  assert.deepEqual(validateManifest(loadManifest()), []);
});

test('a path cannot be both owned and forbidden', () => {
  // Phase 4 shipped exactly this contradiction (EP-004), so it is checked
  // rather than trusted.
  const manifest = JSON.parse(JSON.stringify(loadManifest()));
  manifest.forbiddenPaths.push(manifest.lanes.p7[0]);
  assert.ok(validateManifest(manifest).some((error) => error.includes('both owned and forbidden')));
});

test('a generated or release path the lane cannot write is rejected', () => {
  const manifest = JSON.parse(JSON.stringify(loadManifest()));
  manifest.generatedPaths.push('reports/somebody-elses/output.json');
  assert.ok(validateManifest(manifest).some((error) => error.includes('generatedPaths declares a path the lane does not own')));
});

test('real Phase 7 changed files pass ownership', () => {
  const manifest = loadManifest();
  const inventory = [
    'js/analysis/status.js',
    'js/analysis/alias/solver.js',
    'js/analysis/pointsto/local.js',
    'tests/phase7/run.mjs',
    'tools/validation/phase7/verify.mjs',
    'tools/validation/phase-ownership/phase7.json',
    'reports/phase7/baseline-metrics.json',
    'package.json',
  ];
  assert.deepEqual(validateFiles(manifest, inventory).violations, []);
});

test('edits to another phase or to a frozen contract are blocked', () => {
  const manifest = loadManifest();
  const forbidden = [
    'js/semantics/ir/nodes.js',
    'js/semantics/memoryssa/build.js',
    'js/targets/architecture/arm64/semantic-function.js',
    'js/core/identity/index.js',
    'js/platform/capability-maturity.js',
    'docs/HEX_MASTER_ARCHITECTURE.md',
    'docs/ENGINEERING_PROCESS_GUARDRAILS.md',
    'tests/phase6/run.mjs',
  ];
  for (const file of forbidden) {
    const result = validateFiles(manifest, [file]);
    assert.ok(result.violations.length > 0, `Phase 7 must not be allowed to change: ${file}`);
  }
});

test('every forbidden pattern that names a real risk carries a rationale', () => {
  const manifest = loadManifest();
  const rationale = Object.keys(manifest.forbiddenRationale ?? {});
  assert.ok(rationale.length >= 5, 'forbidden paths must explain themselves, not just exist');
  for (const pattern of rationale) {
    assert.ok(manifest.forbiddenPaths.includes(pattern), `rationale for a pattern that is not forbidden: ${pattern}`);
  }
});

test('Phase 7 owns the generated userscript output it invalidates', () => {
  // Phase 7 edits js/analysis/** and js/semantics/compat/index.js, which are
  // inside the protected userscript runtime, so every accepted checkpoint
  // changes the canonical build output. A lane that changes protected runtime
  // source but cannot commit the rebuild is the EP-003/EP-008 contradiction:
  // CI demands synchronisation the lane is forbidden from performing.
  const manifest = loadManifest();
  for (const generated of ['userscript/hex.user.template.js', 'userscript/release-version.json']) {
    assert.ok(manifest.lanes.p7.includes(generated), `Phase 7 must own the generated output it invalidates: ${generated}`);
    assert.ok(manifest.generatedPaths.includes(generated), `${generated} must be declared generated, not ordinary source`);
    assert.ok(manifest.ownedWithConstraint[generated], `${generated} must carry its canonical-builder constraint`);
  }
  assert.deepEqual(manifest.generatedWriteOwners, ['p7']);

  // The deployment stamp records which commit a deployment was built from, so
  // it differs between a local build and a CI checkout by design. Claiming it
  // as owned committed output would create a gate no commit could satisfy.
  const stamp = 'js/userscript/deployment-identity.generated.js';
  assert.ok(!manifest.lanes.p7.includes(stamp), 'the deployment stamp is not Phase 7 output');
  assert.ok(!manifest.generatedPaths.includes(stamp));
});

test('the Phase 7 sync check matches the canonical generated-sync check', () => {
  // Two workflows enforcing different sets is how a lane ends up blocked by a
  // rule the rest of the repository does not apply (EP-008).
  const canonical = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-sync.yml'), 'utf8');
  const phase7 = fs.readFileSync(path.join(ROOT, '.github/workflows/phase7-release-validation.yml'), 'utf8');
  for (const artifact of ['userscript/hex.user.template.js', 'userscript/release-version.json']) {
    assert.ok(canonical.includes(artifact), `canonical workflow must check ${artifact}`);
    assert.ok(phase7.includes(artifact), `Phase 7 workflow must check ${artifact}`);
  }
  const stamp = 'deployment-identity.generated.js';
  assert.ok(!canonical.includes(stamp), 'the canonical workflow excludes the deployment stamp');
  assert.ok(!phase7.split('Generated-output synchronization')[1].split('- name:')[0].includes(`-- ${stamp}`),
    'the Phase 7 workflow must not require the deployment stamp to match');
});

test('the ownership gate is reachable as a script', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(packageJson.scripts['phase7:ownership'], 'phase7:ownership entry point must exist');
});
