import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const PHYSICAL_IPAD_EVIDENCE_SCHEMA = 'hex-physical-ipad-evidence/v1';
export const REQUIRED_IPAD_CHECKS = Object.freeze([
  'runtimeActivationIdentity',
  'openNontrivialBinary',
  'demandDrivenNavigation',
  'cancellation',
  'workerLifecycleRecovery',
  'indexedDbProjectRoundTrip',
  'variableLengthViewer',
  'semanticDecompilerWorkflow',
  'memoryBudget',
  'phase12UiPath',
]);

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

export function createPhysicalIPadEvidence(input = {}) {
  const checks = {};
  for (const key of REQUIRED_IPAD_CHECKS) checks[key] = input.checks?.[key] === true;
  const record = {
    schemaVersion: PHYSICAL_IPAD_EVIDENCE_SCHEMA,
    commitSha: required(input.commitSha, 'ipad-evidence-commit-required').toLowerCase(),
    treeSha: required(input.treeSha, 'ipad-evidence-tree-required').toLowerCase(),
    buildIdentity: required(input.buildIdentity, 'ipad-evidence-build-required'),
    runtimeIdentity: required(input.runtimeIdentity, 'ipad-evidence-runtime-required'),
    deviceModel: required(input.deviceModel, 'ipad-evidence-device-required'),
    iPadOSVersion: required(input.iPadOSVersion, 'ipad-evidence-ipados-required'),
    webKitVersion: required(input.webKitVersion, 'ipad-evidence-webkit-required'),
    testedAt: required(input.testedAt, 'ipad-evidence-tested-at-required'),
    attestedBy: required(input.attestedBy, 'ipad-evidence-attestor-required'),
    fixtureIdentity: required(input.fixtureIdentity, 'ipad-evidence-fixture-required'),
    checks: deepFreeze(checks),
    runtimeProfilesExercised: Object.freeze([...(input.runtimeProfilesExercised || [])].map(String).sort()),
    rebuildProfilesExercised: Object.freeze([...(input.rebuildProfilesExercised || [])].map(String).sort()),
    notesDigest: input.notesDigest == null ? null : String(input.notesDigest),
  };
  return deepFreeze({ ...record, evidenceId: `physical-ipad:${stableDigest(record)}` });
}

export function validatePhysicalIPadEvidence(record, expected = {}) {
  if (!record || record.schemaVersion !== PHYSICAL_IPAD_EVIDENCE_SCHEMA) return { ok: false, reason: 'ipad-evidence-schema-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.commitSha)) return { ok: false, reason: 'ipad-evidence-commit-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.treeSha)) return { ok: false, reason: 'ipad-evidence-tree-invalid' };
  if (expected.commitSha && record.commitSha !== String(expected.commitSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-commit' };
  if (expected.treeSha && record.treeSha !== String(expected.treeSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-tree' };
  if (expected.buildIdentity && record.buildIdentity !== expected.buildIdentity) return { ok: false, reason: 'ipad-evidence-build-mismatch' };
  const missingChecks = REQUIRED_IPAD_CHECKS.filter((key) => record.checks?.[key] !== true);
  if (missingChecks.length) return { ok: false, reason: 'ipad-evidence-required-check-missing', missingChecks };
  if (!record.deviceModel.toLowerCase().includes('ipad')) return { ok: false, reason: 'ipad-evidence-device-not-ipad' };
  return { ok: true, evidenceId: record.evidenceId };
}
