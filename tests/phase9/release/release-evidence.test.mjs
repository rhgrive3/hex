import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicPayload,
  filterDirtyFiles,
  isVerifierOwnedPath,
  SCHEMA_VERSION,
  VERIFIER_ID,
  VERIFIER_VERSION,
} from '../../../tools/validation/phase9/verify.mjs';

test('release verifier excludes only its exact canonical evidence files', () => {
  assert.equal(isVerifierOwnedPath('reports/phase9/phase9-release-evidence.json'), true);
  assert.equal(isVerifierOwnedPath('reports/phase9/checkpoints.json'), true);
  assert.equal(isVerifierOwnedPath('reports/phase9/preflight.json'), false);
  assert.equal(isVerifierOwnedPath('reports/phase9/other.json'), false);
  assert.deepEqual(
    filterDirtyFiles([
      ' M reports/phase9/phase9-release-evidence.json',
      ' M reports/phase9/checkpoints.json',
      ' M reports/phase9/preflight.json',
      ' M js/source.js',
      '?? js/new-source.js',
    ].join('\n')),
    ['reports/phase9/preflight.json', 'js/source.js', 'js/new-source.js']
  );
});

test('release evidence deterministic payload is stable and binds exact authority identity', () => {
  const args = {
    product: {
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      clean: true,
      dirtyFiles: [],
    },
    backend: {
      id: 'hex-exhaustive-bv',
      version: '1.0.0',
      proofAuthority: 'exact',
      capabilityFingerprint: 'cap-v1',
    },
    testExecution: { selected: 29, total: 29, allPassed: true },
    capabilities: { realSolver: 'verified' },
    gates: [{ id: 'GATE', description: 'test', status: 'PASSED', ok: true, reason: null }],
  };
  const first = buildDeterministicPayload(args);
  const second = buildDeterministicPayload({ ...args, gates: [...args.gates] });
  assert.equal(first.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(first, second);
  assert.equal(first.verifier.id, VERIFIER_ID);
  assert.equal(first.verifier.version, VERIFIER_VERSION);
  assert.equal(first.backend.proofAuthority, 'exact');
  assert.equal(first.backend.capabilityFingerprint, 'cap-v1');
});
