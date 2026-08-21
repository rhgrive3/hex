import assert from 'node:assert/strict';
import { createPhysicalIPadEvidence, validatePhysicalIPadEvidence } from '../../js/platform/physical-ipad-evidence.js';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);
const checks = {
  runtimeActivationIdentity: true,
  openNontrivialBinary: true,
  demandDrivenNavigation: true,
  cancellation: true,
  workerLifecycleRecovery: true,
  indexedDbProjectRoundTrip: true,
  variableLengthViewer: true,
  semanticDecompilerWorkflow: true,
  memoryBudget: true,
  phase12UiPath: true,
};
const record = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: 'build:test',
  runtimeIdentity: 'runtime:test',
  deviceModel: 'iPad mini 6',
  iPadOSVersion: 'test',
  webKitVersion: 'test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'test-harness-human-attestation-shape',
  fixtureIdentity: 'fixture:test',
  checks,
});
assert.equal(validatePhysicalIPadEvidence(record, { commitSha, treeSha, buildIdentity: 'build:test' }).ok, true);
assert.equal(validatePhysicalIPadEvidence(record, { commitSha: '3'.repeat(40) }).reason, 'ipad-evidence-stale-commit');
const missing = createPhysicalIPadEvidence({ ...record, checks: { ...checks, cancellation: false } });
assert.equal(validatePhysicalIPadEvidence(missing, { commitSha, treeSha }).reason, 'ipad-evidence-required-check-missing');
console.log('[stage2] physical iPad evidence contract tests passed');
