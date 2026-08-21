import assert from 'node:assert/strict';
import {
  stage2ArchitectureMaturity,
  stage2FormatMaturity,
  stage2ManagedMaturity,
  stage2Phase12Maturity,
} from '../../js/platform/stage2-capability-maturity.js';

const arm64Stage1 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'] };
const arm64Runtime = { status: 'supported-for-exact-provider-profile', targetProfileId: 'arm64:a64' };
const arm64 = stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: arm64Runtime });
assert.equal(arm64.level, 'A7');
assert.equal(arm64.status, 'supported');
assert.equal(arm64.features.runtimeDebugPatchValidation, 'supported');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: { verdict: 'READY' }, runtimeProof: arm64Runtime }).level, 'A7', 'generic Stage1 READY must not promote a target profile');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: { ...arm64Runtime, targetProfileId: 'x86_64:long-64' } }).level, 'A7', 'runtime proof from another architecture must not promote A7');

const jvmRuntime = { status: 'supported-for-exact-provider-profile', frontendId: 'jvm', targetProfileId: 'managed:jvm:m6' };
const jvm = stage2ManagedMaturity('jvm', { runtimeProof: jvmRuntime });
assert.equal(jvm.level, 'M6');
assert.equal(jvm.status, 'supported');
assert.notEqual(stage2ManagedMaturity('jvm', { runtimeProof: { ...jvmRuntime, frontendId: 'dex', targetProfileId: 'managed:dex:m6' } }).level, 'M6');

const machoStage1 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F5', profileIds: ['macho:64'] };
const machoRebuild = { status: 'supported-for-exact-rebuild-profile', format: 'macho', formatCoverageComplete: true, formatProfileIds: ['macho:64'] };
const macho = stage2FormatMaturity('macho', { stage1Proof: machoStage1, rebuildProof: machoRebuild });
assert.equal(macho.level, 'F6');
assert.equal(macho.status, 'supported');
assert.equal(macho.features.validatedRebuildPatch, 'supported');
assert.notEqual(stage2FormatMaturity('macho', { stage1Proof: { verdict: 'READY' }, rebuildProof: machoRebuild }).level, 'F6');
assert.notEqual(stage2FormatMaturity('macho', { stage1Proof: machoStage1, rebuildProof: { ...machoRebuild, formatCoverageComplete: false } }).level, 'F6');

const peStage1 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F4', profileIds: ['pe:pe32', 'pe:pe32+'] };
const peRebuild = { status: 'supported-for-exact-rebuild-profile', format: 'pe', formatCoverageComplete: true, formatProfileIds: ['pe:pe32', 'pe:pe32+'] };
const pe = stage2FormatMaturity('pe', { stage1Proof: peStage1, rebuildProof: peRebuild });
assert.equal(pe.features.validatedRebuildPatch, 'supported');
assert.equal(pe.fullySatisfiedLevel, 'F4', 'PE cannot claim cumulative F6 while F5 remains unsupported');
assert.equal(pe.status, 'partial');

const phase12 = stage2Phase12Maturity({
  knowledgeProof: { deterministic: true, authorityNegativeTests: true, dependencyIdentityTests: true, invalidationTests: true, providerBoundaryTests: true },
  rulesProof: { deterministic: true, partialPropagationTests: true, dependencyTests: true, requiredFeatureTests: true, resourceBudgetTests: true },
  patternProof: { deterministic: true, bounded: true, noArbitraryJavaScript: true, truncationTests: true },
  remoteCollaborationProof: { status: 'supported-for-exact-security-profile' },
  rebuildProof: machoRebuild,
});
assert.equal(phase12.knowledgePackages.status, 'supported');
assert.equal(phase12.capabilityRules.status, 'supported');
assert.equal(phase12.patterns.status, 'supported');
assert.equal(phase12.collaboration.status, 'supported');
assert.equal(phase12.rebuild.status, 'supported');
assert.equal(stage2Phase12Maturity({ rulesProof: { deterministic: true, partialPropagationTests: true } }).capabilityRules.status, 'partial');
console.log('[stage2] profile-bound capability promotion tests passed');
