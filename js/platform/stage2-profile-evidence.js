import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const STAGE2_PROFILE_EVIDENCE_SCHEMA = 'hex-stage2-profile-evidence/v1';
export const STAGE2_PROFILE_EVIDENCE_IDS = Object.freeze([
  'S1-A2-NATIVE',
  'S2-A7-NATIVE',
  'S2-M6-WASM', 'S2-M6-DEX', 'S2-M6-CIL', 'S2-M6-JVM',
  'S2-F6-MACHO', 'S2-F6-ELF', 'S2-F6-PE',
  'S2-P12-KNOWLEDGE', 'S2-P12-RULES', 'S2-P12-PATTERNS', 'S2-P12-COLLAB-REMOTE',
]);

const EXPECTED_PROFILES = Object.freeze({
  'S1-A2-NATIVE': Object.freeze(['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']),
  'S2-A7-NATIVE': Object.freeze(['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']),
  'S2-M6-WASM': Object.freeze(['managed:wasm:m6']),
  'S2-M6-DEX': Object.freeze(['managed:dex:m6']),
  'S2-M6-CIL': Object.freeze(['managed:cil:m6']),
  'S2-M6-JVM': Object.freeze(['managed:jvm:m6']),
  'S2-F6-MACHO': Object.freeze(['macho:64']),
  'S2-F6-ELF': Object.freeze(['elf:64']),
  'S2-F6-PE': Object.freeze(['pe:pe32', 'pe:pe32+']),
  'S2-P12-KNOWLEDGE': Object.freeze(['knowledge-packages:v1']),
  'S2-P12-RULES': Object.freeze(['capability-rules:v1']),
  'S2-P12-PATTERNS': Object.freeze(['patterns:read-only-v1']),
  'S2-P12-COLLAB-REMOTE': Object.freeze(['collaboration:remote-security-v1']),
});

function sorted(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function includesAll(values, expected) { const set = new Set(values); return expected.every((item) => set.has(item)); }
function payload(record) {
  return {
    schemaVersion: record.schemaVersion,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
    generatedAt: record.generatedAt,
    items: record.items,
  };
}
function identity(record) { return `stage2-profile-evidence:${stableDigest(payload(record))}`; }

export function createStage2ProfileEvidence(input = {}) {
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const source = input.items?.[id] || {};
    items[id] = deepFreeze({
      profileIds: Object.freeze(sorted(source.profileIds)),
      denominatorComplete: source.denominatorComplete === true,
      exactHead: source.exactHead === true,
      realFixture: source.realFixture === true,
      independentOracle: source.independentOracle === true,
      capabilityOrValidatorCoverageComplete: source.capabilityOrValidatorCoverageComplete === true,
      negativeTests: source.negativeTests === true,
      evidenceIdentities: Object.freeze(sorted(source.evidenceIdentities)),
      providerProfileIds: Object.freeze(sorted(source.providerProfileIds)),
    });
  }
  const record = {
    schemaVersion: STAGE2_PROFILE_EVIDENCE_SCHEMA,
    commitSha: String(input.commitSha || '').toLowerCase(),
    treeSha: String(input.treeSha || '').toLowerCase(),
    generatedAt: String(input.generatedAt || ''),
    items: deepFreeze(items),
  };
  return deepFreeze({ ...record, evidenceId: identity(record) });
}

export function validateStage2ProfileEvidence(record, expected = {}) {
  if (!record || record.schemaVersion !== STAGE2_PROFILE_EVIDENCE_SCHEMA) return { ok: false, reason: 'stage2-profile-evidence-schema-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.commitSha || '')) return { ok: false, reason: 'stage2-profile-evidence-commit-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.treeSha || '')) return { ok: false, reason: 'stage2-profile-evidence-tree-invalid' };
  if (!Number.isFinite(Date.parse(record.generatedAt || ''))) return { ok: false, reason: 'stage2-profile-evidence-time-invalid' };
  if (record.evidenceId !== identity(record)) return { ok: false, reason: 'stage2-profile-evidence-tampered' };
  if (expected.commitSha && record.commitSha !== String(expected.commitSha).toLowerCase()) return { ok: false, reason: 'stage2-profile-evidence-stale-commit' };
  if (expected.treeSha && record.treeSha !== String(expected.treeSha).toLowerCase()) return { ok: false, reason: 'stage2-profile-evidence-stale-tree' };
  const failures = [];
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const item = record.items?.[id];
    const expectedProfiles = EXPECTED_PROFILES[id];
    if (!item) { failures.push(`${id}:missing`); continue; }
    const profiles = sorted(item.profileIds);
    if (!includesAll(profiles, expectedProfiles)) failures.push(`${id}:profile-denominator-incomplete`);
    if (item.denominatorComplete !== true) failures.push(`${id}:denominator-not-complete`);
    if (item.exactHead !== true) failures.push(`${id}:not-exact-head`);
    if (item.realFixture !== true) failures.push(`${id}:real-fixture-missing`);
    if (item.capabilityOrValidatorCoverageComplete !== true) failures.push(`${id}:coverage-incomplete`);
    if (item.negativeTests !== true) failures.push(`${id}:negative-tests-missing`);
    if (!Array.isArray(item.evidenceIdentities) || item.evidenceIdentities.length === 0) failures.push(`${id}:evidence-identity-missing`);
    if (id.startsWith('S2-F6-') && item.independentOracle !== true) failures.push(`${id}:independent-oracle-missing`);
    if ((id === 'S2-A7-NATIVE' || id.startsWith('S2-M6-')) && (!Array.isArray(item.providerProfileIds) || item.providerProfileIds.length === 0)) failures.push(`${id}:provider-profile-missing`);
  }
  return { ok: failures.length === 0, reason: failures.length ? 'stage2-profile-evidence-incomplete' : null, failures, evidenceId: record.evidenceId };
}
