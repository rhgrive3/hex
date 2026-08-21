import assert from 'node:assert/strict';
import { STAGE2_PROFILE_EVIDENCE_IDS, createStage2ProfileEvidence, validateStage2ProfileEvidence } from '../../js/platform/stage2-profile-evidence.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const profiles = {
  'S1-A2-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-A7-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-M6-WASM': ['managed:wasm:m6'],
  'S2-M6-DEX': ['managed:dex:m6'],
  'S2-M6-CIL': ['managed:cil:m6'],
  'S2-M6-JVM': ['managed:jvm:m6'],
  'S2-F6-MACHO': ['macho:64'],
  'S2-F6-ELF': ['elf:64'],
  'S2-F6-PE': ['pe:pe32', 'pe:pe32+'],
  'S2-P12-COLLAB-REMOTE': ['collaboration:remote-security-v1'],
};
const items = {};
for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
  items[id] = {
    profileIds: profiles[id],
    denominatorComplete: true,
    exactHead: true,
    realFixture: true,
    independentOracle: id.startsWith('S2-F6-'),
    capabilityOrValidatorCoverageComplete: true,
    negativeTests: true,
    evidenceIdentities: [`evidence:${id}`],
    providerProfileIds: id === 'S2-A7-NATIVE' || id.startsWith('S2-M6-') ? [`provider:${id}`] : [],
  };
}
const record = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items });
assert.equal(validateStage2ProfileEvidence(record, { commitSha, treeSha }).ok, true);
const incomplete = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items: { ...items, 'S2-F6-PE': { ...items['S2-F6-PE'], profileIds: ['pe:pe32'] } } });
assert.equal(validateStage2ProfileEvidence(incomplete, { commitSha, treeSha }).reason, 'stage2-profile-evidence-incomplete');
const tampered = JSON.parse(JSON.stringify(record));
tampered.items['S2-M6-JVM'].denominatorComplete = false;
assert.equal(validateStage2ProfileEvidence(tampered, { commitSha, treeSha }).reason, 'stage2-profile-evidence-tampered');
assert.equal(validateStage2ProfileEvidence(record, { commitSha: 'c'.repeat(40) }).reason, 'stage2-profile-evidence-stale-commit');
console.log('[stage2] per-profile evidence contract tests passed');
