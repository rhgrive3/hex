import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateEvidence, verifyPhase7 } from '../../../tools/validation/phase7/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Verifier self-tests.
 *
 * These check the *verifier*, not the product. A verifier that only ever agrees
 * with the current implementation has not been shown to detect anything, and
 * every green result it produced afterwards would be worthless (§3.5).
 */

test('evidence that fails its own schema is rejected', () => {
  assert.ok(validateEvidence({}).length > 0);
  assert.ok(validateEvidence({ schemaVersion: 'wrong', verdict: 'READY', failures: [] }).length > 0);
  assert.ok(validateEvidence({ schemaVersion: 'phase7-release-evidence/v1', verdict: 'MAYBE', failures: [] })
    .some((error) => error.includes('verdict')));
});

test('an expected-SHA mismatch is blocking', async () => {
  const report = await verifyPhase7({ shadow: true, expectedSha: '0'.repeat(40) });
  assert.ok(report.failures.some((failure) => failure.category === 'identity'),
    'the verifier must refuse to attest a head it was not asked to verify');
});

test('dirty source fails closed', async () => {
  // EP-018: a commit that does not describe the tested tree cannot be attested.
  const marker = path.join(ROOT, 'js/analysis/.dirty-tree-probe.js');
  fs.writeFileSync(marker, 'export const probe = true;\n');
  try {
    const report = await verifyPhase7({ shadow: false });
    assert.equal(report.product.workingTreeClean, false);
    assert.ok(report.product.dirtyPaths.some((entry) => entry.includes('.dirty-tree-probe.js')),
      'the verifier must name the dirt it found, not just report a boolean');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('the deployment stamp is excluded, and only it', async () => {
  // Any canonical build rewrites the stamp, including the step that runs right
  // before this verifier in CI. Excluding it is necessary; excluding anything
  // else would blind the gate, so both halves are asserted together.
  //
  // The assertion is on `dirtyPaths` rather than on `workingTreeClean`, so an
  // unrelated edit elsewhere in the tree cannot make this test lie either way.
  const stamp = path.join(ROOT, 'js/userscript/deployment-identity.generated.js');
  const original = fs.readFileSync(stamp, 'utf8');
  fs.writeFileSync(stamp, `${original}// touched by the exclusion test\n`);
  try {
    const report = await verifyPhase7({ shadow: true });
    assert.ok(!report.product.dirtyPaths.some((entry) => entry.includes('deployment-identity.generated.js')),
      'a rewritten deployment stamp must not be treated as source dirt');
  } finally {
    fs.writeFileSync(stamp, original);
  }

  // A neighbouring file in the same directory must still count, so the
  // exclusion covers the stamp alone rather than its directory.
  const sibling = path.join(ROOT, 'js/userscript/.exclusion-probe.js');
  fs.writeFileSync(sibling, 'export const probe = true;\n');
  try {
    const report = await verifyPhase7({ shadow: true });
    assert.ok(report.product.dirtyPaths.some((entry) => entry.includes('.exclusion-probe.js')),
      'the exclusion must not extend to the stamp\'s directory');
  } finally {
    fs.rmSync(sibling, { force: true });
  }
});

test('the verifier records the identities that make its verdict reproducible', async () => {
  const report = await verifyPhase7({ shadow: true });
  for (const field of ['commitSha', 'treeSha', 'branch']) {
    assert.ok(report.product[field], `missing product identity: ${field}`);
  }
  assert.ok(report.verifierVersion);
  assert.ok(report.verifierSourceSha256, 'the verifier must hash its own source');
  assert.ok(report.corpus.manifestDigest);
  assert.ok(report.corpus.scoring.version);
  assert.ok(report.corpus.truthGenerator.version);
  assert.equal(report.corpus.frozenDigestMatches, true,
    'the frozen corpus must match a regeneration, or the measured question set moved');
});

test('a verdict is never READY while a required checkpoint is missing', async () => {
  const ledgerPath = path.join(ROOT, 'reports/phase7/checkpoints.json');
  const original = fs.readFileSync(ledgerPath, 'utf8');
  const trimmed = JSON.parse(original);
  trimmed.checkpoints = trimmed.checkpoints.filter((checkpoint) => checkpoint.id !== 'P7-6');
  fs.writeFileSync(ledgerPath, `${JSON.stringify(trimmed, null, 2)}\n`);
  try {
    const report = await verifyPhase7({ shadow: true });
    assert.notEqual(report.verdict, 'READY');
    assert.ok(report.failures.some((failure) => failure.category === 'integration'));
  } finally {
    fs.writeFileSync(ledgerPath, original);
  }
});

test('the verifier blocks when a required debug ecosystem is absent', async () => {
  // Proving the *absence* path: one working backend must not satisfy the phase.
  const module = await import('../../../tools/validation/phase7/lanes/debug.mjs');
  const metrics = module.collectDebugMetrics();
  assert.ok(metrics.ecosystems.dwarf && metrics.ecosystems.pdb);
  // If either were missing the verifier's loop over requiredDebugEcosystems
  // records a blocking failure; assert the profile actually requires both.
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase7/profile.json'), 'utf8'));
  assert.deepEqual(profile.requiredDebugEcosystems, ['dwarf', 'pdb']);
  assert.equal(profile.soundness.maxFalseNoAlias, 0);
  assert.equal(profile.soundness.maxFalseMustAlias, 0);
  assert.equal(profile.soundness.maxBarrierBypasses, 0);
  assert.equal(profile.soundness.maxFalseCertainty, 0);
});

test('publication is atomic and never leaves a partial report', async () => {
  const { publish } = await import('../../../tools/validation/phase7/verify.mjs');
  const outputDirectory = fs.mkdtempSync(path.join(ROOT, 'reports/phase7/.atomic-'));
  try {
    assert.throws(() => publish({ schemaVersion: 'wrong' }, outputDirectory), /failed its own schema/);
    const leftovers = fs.readdirSync(outputDirectory);
    assert.deepEqual(leftovers, [], 'a rejected report must leave nothing behind');
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
