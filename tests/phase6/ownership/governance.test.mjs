import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadManifest, validateFiles, validateManifest } from '../../../tools/validation/phase6-ownership.mjs';
import { renderMarkdown, validateEvidence } from '../../../tools/validation/phase6/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase6/profile.json'), 'utf8'));

test('the Phase 6 ownership manifest is well formed and self-consistent', () => {
  const manifest = loadManifest();
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.phase, 6);
  assert.equal(manifest.singleOwnerLane, 'p6');
});

test('the manifest cannot declare generated or release output the lane may not write', () => {
  const manifest = loadManifest();
  // Phase 4 shipped ownership rules that contradicted their own lane
  // assignments, and Phase 6 briefly repeated it: the canonical userscript was
  // declared generated output while the only lane there is did not own it, so
  // the lane could not complete its own generated-output transaction.
  for (const field of ['generatedPaths', 'releaseOnlyPaths']) {
    for (const declared of manifest[field]) {
      assert.ok(manifest.lanes.p6.includes(declared),
        `${field} declares ${declared}, which lane p6 does not own`);
    }
  }
  assert.deepEqual(manifest.generatedWriteOwners, ['p6']);
  assert.deepEqual(manifest.releaseWriteOwners, ['p6']);

  const contradictory = {
    ...manifest,
    generatedPaths: [...manifest.generatedPaths, 'userscript/not-owned.js'],
  };
  assert.ok(
    validateManifest(contradictory).some((error) => error.includes('userscript/not-owned.js')),
    'a generated path the lane does not own must be rejected by manifest validation',
  );
  assert.ok(
    validateManifest({ ...manifest, generatedWriteOwners: ['p9'] }).some((error) => error.includes('p9')),
    'an unknown generated write owner must be rejected',
  );
});

test('Phase 6 may not edit another architecture, another phase, or its own contract document', () => {
  const manifest = loadManifest();
  const forbidden = [
    'js/targets/architecture/arm64/effects/integer.js',
    'js/targets/abi/aapcs64.js',
    'js/targets/architecture/x86_64/effects/integer.js',
    'js/core/identity/index.js',
    'tests/phase5/verification/compiler-corpus-pipeline.test.mjs',
    'docs/HEX_MASTER_ARCHITECTURE.md',
  ];
  for (const file of forbidden) {
    const result = validateFiles(manifest, [file]);
    assert.equal(result.valid, false, `${file} must be rejected`);
    assert.ok(result.violations.some((violation) => violation.category === 'forbidden'), `${file} must be rejected as forbidden`);
  }
});

test('the files Phase 6 does own are accepted', () => {
  const manifest = loadManifest();
  const owned = [
    'js/targets/architecture/riscv64/effects/integer.js',
    'js/targets/abi/riscv-lp64.js',
    'js/analysis/semantic-function.js',
    'tests/phase6/verification/compiler-corpus-pipeline.test.mjs',
    'tools/validation/phase6/verify.mjs',
    'docs/PHASE6_CHECKPOINT.md',
  ];
  const result = validateFiles(manifest, owned);
  assert.deepEqual(result.violations, []);
  assert.equal(result.valid, true);
});

test('paths outside the lane are rejected rather than silently allowed', () => {
  const manifest = loadManifest();
  for (const file of ['js/app.js', 'js/ui/panels.js', 'README.md']) {
    const result = validateFiles(manifest, [file]);
    assert.equal(result.valid, false, `${file} is outside the Phase 6 lane`);
    assert.ok(result.violations.some((violation) => violation.category === 'outside-lane'));
  }
  // Traversal and absolute paths must never be treated as repository paths.
  assert.equal(validateFiles(manifest, ['../escape.js']).valid, false);
  assert.equal(validateFiles(manifest, ['/etc/passwd']).valid, false);
});

test('the frozen profile declares every identity the verifier binds evidence to', () => {
  assert.equal(PROFILE.schemaVersion, 'phase6-riscv64-profile/v1');
  for (const field of ['profileVersion', 'verifierVersion', 'isaProfile', 'abiProfiles', 'toolchain', 'decoder', 'semanticVersions', 'corpus', 'crossArchitecture', 'capabilityClaim']) {
    assert.ok(PROFILE[field], `frozen profile must declare ${field}`);
  }
  assert.equal(PROFILE.physicalState.flagsRegister, null, 'the profile must record that RV64 has no flags register');
  assert.equal(PROFILE.abiProfiles.syscallAbi, null, 'a syscall ABI must not be invented from the psABI');
  // Nothing may be claimed that the profile does not actually freeze.
  for (const notClaimed of PROFILE.isaProfile.notClaimed) {
    assert.equal(PROFILE.isaProfile.id, 'rv64imc');
    assert.notEqual(PROFILE.isaProfile.id, notClaimed);
  }
});

test('malformed evidence is rejected, and READY cannot be reported by absence', () => {
  const base = {
    schemaVersion: 'phase6-release-evidence/v1',
    verifierVersion: PROFILE.verifierVersion,
    verdict: 'READY',
    generatedAt: '1970-01-01T00:00:00.000Z',
    product: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), workingTreeClean: true, branch: 'test' },
    identities: {
      profileVersion: PROFILE.profileVersion,
      isaProfile: 'rv64imc',
      abiProfiles: ['lp64'],
      toolchain: {},
      decoderArtifacts: [{ path: 'capstone.wasm', sha256: 'c'.repeat(64), matchesFrozenProfile: true }],
      architectureSemanticVersion: '1.0.0-phase6-rv64imc',
      abiSemanticVersion: '1',
      corpusId: PROFILE.corpus.id,
      corpusDigest: 'd'.repeat(64),
    },
    counts: {
      mandatoryCorpusCases: 264, instantiatedCases: 264, missingCases: 0,
      exactEffects: 1, partialEffects: 0, unsupportedEffects: 0,
      semanticMismatches: 0, decoderMismatches: 0, abiMismatches: 0, elfMismatches: 0,
      provenanceLosses: 0, hiddenFallbacks: 0,
      unknownStoreSafetyFailures: 0, unknownCallSafetyFailures: 0,
      architectureNeutralityViolations: 0, staleArtifactFailures: 0,
      crossArchitectureMismatches: 0, firstDivergenceCount: 0,
    },
    gates: [{ id: 'phase6-mandatory-corpus', status: 'PASS', detail: 'ok' }],
    failures: [],
  };
  assert.deepEqual(validateEvidence(base), [], 'a complete report must validate');

  const rejects = [
    ['a missing corpus digest', { ...base, identities: { ...base.identities, corpusDigest: '' } }],
    ['a non-exact product SHA', { ...base, product: { ...base.product, commitSha: 'abc' } }],
    ['an empty gate list', { ...base, gates: [] }],
    ['a dirty working tree', { ...base, product: { ...base.product, workingTreeClean: false } }],
    ['a hidden fallback', { ...base, counts: { ...base.counts, hiddenFallbacks: 1 } }],
    ['a provenance loss', { ...base, counts: { ...base.counts, provenanceLosses: 1 } }],
    ['missing mandatory coverage', { ...base, counts: { ...base.counts, missingCases: 4 } }],
    ['a neutrality violation', { ...base, counts: { ...base.counts, architectureNeutralityViolations: 1 } }],
    ['a decoder that does not match the frozen profile', { ...base, identities: { ...base.identities, decoderArtifacts: [{ path: 'capstone.wasm', sha256: 'c'.repeat(64), matchesFrozenProfile: false }] } }],
    ['an unrecorded divergence', { ...base, counts: { ...base.counts, firstDivergenceCount: 1 } }],
  ];
  for (const [description, report] of rejects) {
    assert.ok(validateEvidence(report).length > 0, `READY must be rejected with ${description}`);
  }

  // A human-readable rendering must accompany the machine-readable verdict.
  const markdown = renderMarkdown(base);
  assert.match(markdown, /Verdict: READY/);
  assert.match(markdown, /phase6-mandatory-corpus/);
});
