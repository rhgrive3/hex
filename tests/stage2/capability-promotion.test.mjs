import assert from 'node:assert/strict';
import {
  stage2ArchitectureMaturity,
  stage2FormatMaturity,
  stage2ManagedMaturity,
  stage2Phase12Maturity,
} from '../../js/platform/stage2-capability-maturity.js';

const stage1Proof = { status: 'stage1-proven' };
const runtimeProof = { status: 'supported-for-exact-provider-profile' };
const rebuildProof = { status: 'supported-for-exact-rebuild-profile' };

const arm64 = stage2ArchitectureMaturity('arm64', { stage1Proof, runtimeProof });
assert.equal(arm64.level, 'A7');
assert.equal(arm64.status, 'supported');
assert.equal(arm64.features.runtimeDebugPatchValidation, 'supported');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof }).level, 'A7');

const jvm = stage2ManagedMaturity('jvm', { runtimeProof });
assert.equal(jvm.level, 'M6');
assert.equal(jvm.status, 'supported');
assert.notEqual(stage2ManagedMaturity('jvm').level, 'M6');

const macho = stage2FormatMaturity('macho', { stage1Proof, rebuildProof });
assert.equal(macho.level, 'F6');
assert.equal(macho.features.validatedRebuildPatch, 'supported');
assert.notEqual(stage2FormatMaturity('macho', { stage1Proof }).level, 'F6');

const phase12 = stage2Phase12Maturity({
  knowledgeProof: { deterministic: true, authorityNegativeTests: true },
  rulesProof: { deterministic: true, partialPropagationTests: true },
  patternProof: { deterministic: true, bounded: true, noArbitraryJavaScript: true },
  remoteCollaborationProof: { status: 'supported-for-exact-security-profile' },
  rebuildProof,
});
assert.equal(phase12.knowledgePackages.status, 'supported');
assert.equal(phase12.capabilityRules.status, 'supported');
assert.equal(phase12.patterns.status, 'supported');
assert.equal(phase12.collaboration.status, 'supported');
assert.equal(phase12.rebuild.status, 'supported');
console.log('[stage2] proof-backed capability promotion tests passed');
