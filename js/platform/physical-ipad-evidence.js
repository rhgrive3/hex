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

function evidencePayload(record) {
  return {
    schemaVersion: record.schemaVersion,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
    buildIdentity: record.buildIdentity,
    runtimeIdentity: record.runtimeIdentity,
    deviceModel: record.deviceModel,
    iPadOSVersion: record.iPadOSVersion,
    webKitVersion: record.webKitVersion,
    testedAt: record.testedAt,
    attestedBy: record.attestedBy,
    fixtureIdentity: record.fixtureIdentity,
    checks: record.checks,
    runtimeProfilesExercised: record.runtimeProfilesExercised,
    rebuildProfilesExercised: record.rebuildProfilesExercised,
    notesDigest: record.notesDigest,
  };
}

function evidenceIdentity(record) {
  return `physical-ipad:${stableDigest(evidencePayload(record))}`;
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
    runtimeProfilesExercised: Object.freeze([...(input.runtimeProfilesExercised || [])].map(String).filter(Boolean).sort()),
    rebuildProfilesExercised: Object.freeze([...(input.rebuildProfilesExercised || [])].map(String).filter(Boolean).sort()),
    notesDigest: input.notesDigest == null ? null : String(input.notesDigest),
  };
  return deepFreeze({ ...record, evidenceId: evidenceIdentity(record) });
}

export function validatePhysicalIPadEvidence(record, expected = {}) {
  if (!record || record.schemaVersion !== PHYSICAL_IPAD_EVIDENCE_SCHEMA) return { ok: false, reason: 'ipad-evidence-schema-invalid' };
  const stringFields = ['commitSha','treeSha','buildIdentity','runtimeIdentity','deviceModel','iPadOSVersion','webKitVersion','testedAt','attestedBy','fixtureIdentity','evidenceId'];
  for (const key of stringFields) if (typeof record[key] !== 'string' || !record[key].trim()) return { ok: false, reason: `ipad-evidence-${key}-invalid` };
  if (!/^[0-9a-f]{40}$/.test(record.commitSha)) return { ok: false, reason: 'ipad-evidence-commit-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.treeSha)) return { ok: false, reason: 'ipad-evidence-tree-invalid' };
  const timestamp = Date.parse(record.testedAt);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(record.testedAt)) return { ok: false, reason: 'ipad-evidence-tested-at-invalid' };
  const expectedEvidenceId = evidenceIdentity(record);
  if (record.evidenceId !== expectedEvidenceId) return { ok: false, reason: 'ipad-evidence-tampered', expectedEvidenceId, observedEvidenceId: record.evidenceId };
  if (expected.commitSha && record.commitSha !== String(expected.commitSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-commit' };
  if (expected.treeSha && record.treeSha !== String(expected.treeSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-tree' };
  if (expected.buildIdentity && record.buildIdentity !== expected.buildIdentity) return { ok: false, reason: 'ipad-evidence-build-mismatch' };
  const missingChecks = REQUIRED_IPAD_CHECKS.filter((key) => record.checks?.[key] !== true);
  if (missingChecks.length) return { ok: false, reason: 'ipad-evidence-required-check-missing', missingChecks };
  if (!record.deviceModel.toLowerCase().includes('ipad')) return { ok: false, reason: 'ipad-evidence-device-not-ipad' };
  return { ok: true, evidenceId: record.evidenceId };
}
