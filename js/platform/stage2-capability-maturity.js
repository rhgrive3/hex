import { architectureMaturity, formatMaturity, managedMaturity, phase12Maturity } from './capability-maturity.js';

const ARCH_PROFILE = Object.freeze({
  arm64: 'arm64:a64',
  arm64e: 'arm64e:a64+pac',
  x86_64: 'x86_64:long-64',
  riscv64: 'riscv64:rv64imc',
});
const FORMAT_PROFILES = Object.freeze({
  macho: Object.freeze(['macho:64']),
  elf: Object.freeze(['elf:64']),
  pe: Object.freeze(['pe:pe32', 'pe:pe32+']),
});
const FORMAT_STATIC_LEVEL = Object.freeze({ macho: 'F5', elf: 'F4', pe: 'F4' });

function freeze(value) { return Object.freeze(value); }
function supportedProof(proof, statusPrefix) { return typeof proof?.status === 'string' && proof.status.startsWith(statusPrefix); }
function includesAll(values, expected) {
  const set = new Set(Array.isArray(values) ? values.map(String) : values == null ? [] : [String(values)]);
  return expected.every((item) => set.has(item));
}
function exactStage1ProfileProof(proof, expectedProfiles, level) {
  return proof?.status === 'stage1-proven'
    && proof?.exactHead === true
    && proof?.fullySatisfiedLevel === level
    && includesAll(proof?.profileIds, expectedProfiles);
}

function stage1ArchitectureBase(architecture, options = {}) {
  const base = architectureMaturity(architecture, options);
  const profileId = ARCH_PROFILE[base.id];
  if (!profileId || !exactStage1ProfileProof(options.stage1Proof, [profileId], 'A6')) return base;
  const limitations = (base.limitations || []).filter((item) => ![
    'exact-machine-effects-partial-coverage',
    'arm64e-pointer-authentication-semantics-partial',
    'x86-64-types-interprocedural-partial',
    'riscv64-exact-effects-limited-to-rv64imc-profile',
    'riscv64-types-interprocedural-partial',
  ].includes(item));
  return freeze({
    ...base,
    implementedLevel: 'A6',
    level: 'A6',
    fullySatisfiedLevel: 'A6',
    status: 'partial',
    partial: true,
    features: freeze({
      ...base.features,
      lowLevelEffects: 'supported',
      cfgSemanticIR: 'supported',
      ssaMemoryDataflow: 'supported',
      typesInterprocedural: 'supported',
      decompiler: 'supported',
    }),
    limitations: freeze(limitations),
    stage1ProfileId: profileId,
    stage1Proof: options.stage1Proof,
  });
}

export function stage2ArchitectureMaturity(architecture, options = {}) {
  const base = stage1ArchitectureBase(architecture, options);
  const profileId = ARCH_PROFILE[base.id];
  const runtimeSupported = supportedProof(options.runtimeProof, 'supported-for-exact-provider-profile')
    && options.runtimeProof?.targetProfileId === profileId;
  if (!runtimeSupported || base.fullySatisfiedLevel !== 'A6') return base;
  const limitations = (base.limitations || []).filter((item) => item !== 'runtime-debug-patch-validation-incomplete');
  return freeze({
    ...base,
    implementedLevel: 'A7',
    level: 'A7',
    fullySatisfiedLevel: 'A7',
    status: 'supported',
    partial: false,
    features: freeze({ ...base.features, runtimeDebugPatchValidation: 'supported' }),
    limitations: freeze(limitations),
    runtimeProfileProof: options.runtimeProof,
  });
}

export function stage2ManagedMaturity(frontend, options = {}) {
  const base = managedMaturity(frontend);
  const expectedTarget = `managed:${base.id}:m6`;
  const runtimeSupported = supportedProof(options.runtimeProof, 'supported-for-exact-provider-profile')
    && options.runtimeProof?.frontendId === base.id
    && options.runtimeProof?.targetProfileId === expectedTarget;
  if (!runtimeSupported) return base;
  return freeze({
    ...base,
    implementedLevel: 'M6',
    level: 'M6',
    fullySatisfiedLevel: 'M6',
    status: 'supported',
    partial: false,
    features: freeze({ ...base.features, runtimeDebug: 'supported' }),
    limitations: freeze((base.limitations || []).filter((item) => !['runtime-debug-provider-phase10-deferred', 'solver-backed-verification-phase9-deferred'].includes(item))),
    runtimeProfileProof: options.runtimeProof,
  });
}

function stage1FormatBase(format, options = {}) {
  const base = formatMaturity(format);
  const profiles = FORMAT_PROFILES[base.id];
  const targetLevel = FORMAT_STATIC_LEVEL[base.id];
  if (!profiles || !targetLevel || !exactStage1ProfileProof(options.stage1Proof, profiles, targetLevel)) return base;
  const features = { ...base.features, importsExportsRelocations: 'supported', functionDebugUnwind: 'supported' };
  if (base.id === 'macho') features.runtimeLanguageMetadata = 'supported';
  const limitations = (base.limitations || []).filter((item) => ![
    'link-metadata-partial',
    'function-debug-unwind-partial',
    ...(base.id === 'macho' ? ['macho-runtime-language-metadata-partial'] : []),
  ].includes(item));
  return freeze({
    ...base,
    implementedLevel: targetLevel,
    level: targetLevel,
    fullySatisfiedLevel: targetLevel,
    status: 'partial',
    partial: true,
    features: freeze(features),
    limitations: freeze(limitations),
    stage1ProfileIds: freeze([...profiles]),
    stage1Proof: options.stage1Proof,
  });
}

export function stage2FormatMaturity(format, options = {}) {
  const base = stage1FormatBase(format, options);
  const profiles = FORMAT_PROFILES[base.id] || [];
  const rebuildSupported = supportedProof(options.rebuildProof, 'supported-for-exact-rebuild-profile')
    && options.rebuildProof?.format === base.id
    && options.rebuildProof?.formatCoverageComplete === true
    && includesAll(options.rebuildProof?.formatProfileIds, profiles);
  if (!rebuildSupported) return base;
  const features = freeze({ ...base.features, validatedRebuildPatch: 'supported' });
  const limitations = freeze((base.limitations || []).filter((item) => item !== 'validated-rebuild-patch-unsupported'));
  if (base.fullySatisfiedLevel !== 'F5') {
    return freeze({ ...base, implementedLevel: 'F6', features, limitations, rebuildProfileProof: options.rebuildProof });
  }
  return freeze({
    ...base,
    implementedLevel: 'F6',
    level: 'F6',
    fullySatisfiedLevel: 'F6',
    status: 'supported',
    partial: false,
    features,
    limitations,
    rebuildProfileProof: options.rebuildProof,
  });
}

export function stage2Phase12Maturity(options = {}) {
  const base = phase12Maturity();
  const knowledge = options.knowledgeProof?.deterministic === true
    && options.knowledgeProof?.authorityNegativeTests === true
    && options.knowledgeProof?.dependencyIdentityTests === true
    && options.knowledgeProof?.invalidationTests === true
    && options.knowledgeProof?.providerBoundaryTests === true;
  const rules = options.rulesProof?.deterministic === true
    && options.rulesProof?.partialPropagationTests === true
    && options.rulesProof?.dependencyTests === true
    && options.rulesProof?.requiredFeatureTests === true
    && options.rulesProof?.resourceBudgetTests === true;
  const patterns = options.patternProof?.deterministic === true
    && options.patternProof?.bounded === true
    && options.patternProof?.noArbitraryJavaScript === true
    && options.patternProof?.truncationTests === true;
  const collaboration = supportedProof(options.remoteCollaborationProof, 'supported-for-exact-security-profile');
  const rebuild = supportedProof(options.rebuildProof, 'supported-for-exact-rebuild-profile') && options.rebuildProof?.formatCoverageComplete === true;
  return freeze({
    knowledgePackages: knowledge ? freeze({ status: 'supported', authority: 'local-promotion-only', limitations: freeze([]) }) : base.knowledgePackages,
    capabilityRules: rules ? freeze({ status: 'supported', authority: 'deterministic-evidence-only', limitations: freeze([]) }) : base.capabilityRules,
    collaboration: collaboration ? freeze({ status: 'supported', authority: 'remote-authorized-canonical-operations', limitations: freeze([]) }) : base.collaboration,
    patterns: patterns ? freeze({ status: 'supported', authority: 'read-only-bounded', limitations: freeze(['no-loader-semantic-mutation']) }) : base.patterns,
    rebuild: rebuild ? freeze({ status: 'supported', authority: 'validated-atomic-profile', limitations: freeze([]) }) : base.rebuild,
  });
}

export function stage2SupportMatrix(options = {}) {
  const stage1ArchitectureProofs = options.stage1ArchitectureProofs || {};
  const stage1FormatProofs = options.stage1FormatProofs || {};
  const runtimeProofs = options.runtimeProofs || {};
  const managedRuntimeProofs = options.managedRuntimeProofs || {};
  const rebuildProofs = options.rebuildProofs || {};
  return freeze({
    architectures: freeze(['arm64', 'arm64e', 'x86_64', 'riscv64'].map((id) => stage2ArchitectureMaturity(id, { ...(options.architectureOptions?.[id] || {}), stage1Proof: stage1ArchitectureProofs[id], runtimeProof: runtimeProofs[id] }))),
    formats: freeze(['macho', 'elf', 'pe'].map((id) => stage2FormatMaturity(id, { stage1Proof: stage1FormatProofs[id], rebuildProof: rebuildProofs[id] }))),
    managed: freeze(['wasm', 'dex', 'cil', 'jvm'].map((id) => stage2ManagedMaturity(id, { runtimeProof: managedRuntimeProofs[id] }))),
    phase12: stage2Phase12Maturity(options.phase12 || {}),
  });
}
