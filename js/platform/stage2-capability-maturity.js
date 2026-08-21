import { architectureMaturity, formatMaturity, managedMaturity, phase12Maturity } from './capability-maturity.js';

function freeze(value) { return Object.freeze(value); }
function supportedProof(proof, statusPrefix) { return typeof proof?.status === 'string' && proof.status.startsWith(statusPrefix); }

export function stage2ArchitectureMaturity(architecture, options = {}) {
  const base = architectureMaturity(architecture, options);
  const runtimeSupported = supportedProof(options.runtimeProof, 'supported-for-exact-provider-profile');
  if (!runtimeSupported) return base;
  return freeze({
    ...base,
    implementedLevel: 'A7',
    level: base.level === 'A6' || base.fullySatisfiedLevel === 'A6' ? 'A7' : base.level,
    fullySatisfiedLevel: base.fullySatisfiedLevel === 'A6' ? 'A7' : base.fullySatisfiedLevel,
    status: base.status === 'supported' && base.fullySatisfiedLevel === 'A6' ? 'supported' : base.status,
    features: freeze({ ...base.features, runtimeDebugPatchValidation: 'supported' }),
    runtimeProfileProof: options.runtimeProof,
  });
}

export function stage2ManagedMaturity(frontend, options = {}) {
  const base = managedMaturity(frontend);
  const runtimeSupported = supportedProof(options.runtimeProof, 'supported-for-exact-provider-profile');
  if (!runtimeSupported) return base;
  return freeze({
    ...base,
    implementedLevel: 'M6',
    level: 'M6',
    fullySatisfiedLevel: 'M6',
    status: 'supported',
    partial: false,
    features: freeze({ ...base.features, runtimeDebug: 'supported' }),
    limitations: freeze((base.limitations || []).filter((item) => item !== 'runtime-debug-provider-phase10-deferred')),
    runtimeProfileProof: options.runtimeProof,
  });
}

export function stage2FormatMaturity(format, options = {}) {
  const base = formatMaturity(format);
  const rebuildSupported = supportedProof(options.rebuildProof, 'supported-for-exact-rebuild-profile');
  if (!rebuildSupported) return base;
  return freeze({
    ...base,
    implementedLevel: 'F6',
    features: freeze({ ...base.features, validatedRebuildPatch: 'supported' }),
    limitations: freeze((base.limitations || []).filter((item) => item !== 'validated-rebuild-patch-unsupported')),
    rebuildProfileProof: options.rebuildProof,
  });
}

export function stage2Phase12Maturity(options = {}) {
  const base = phase12Maturity();
  const knowledge = options.knowledgeProof?.deterministic === true && options.knowledgeProof?.authorityNegativeTests === true;
  const rules = options.rulesProof?.deterministic === true && options.rulesProof?.partialPropagationTests === true;
  const patterns = options.patternProof?.deterministic === true && options.patternProof?.bounded === true && options.patternProof?.noArbitraryJavaScript === true;
  const collaboration = supportedProof(options.remoteCollaborationProof, 'supported-for-exact-security-profile');
  const rebuild = supportedProof(options.rebuildProof, 'supported-for-exact-rebuild-profile');
  return freeze({
    knowledgePackages: knowledge ? freeze({ status: 'supported', authority: 'local-promotion-only', limitations: freeze([]) }) : base.knowledgePackages,
    capabilityRules: rules ? freeze({ status: 'supported', authority: 'deterministic-evidence-only', limitations: freeze([]) }) : base.capabilityRules,
    collaboration: collaboration ? freeze({ status: 'supported', authority: 'remote-authorized-canonical-operations', limitations: freeze([]) }) : base.collaboration,
    patterns: patterns ? freeze({ status: 'supported', authority: 'read-only-bounded', limitations: freeze(['no-loader-semantic-mutation']) }) : base.patterns,
    rebuild: rebuild ? freeze({ status: 'supported', authority: 'validated-atomic-profile', limitations: freeze([]) }) : base.rebuild,
  });
}

export function stage2SupportMatrix(options = {}) {
  const runtimeProofs = options.runtimeProofs || {};
  const managedRuntimeProofs = options.managedRuntimeProofs || {};
  const rebuildProofs = options.rebuildProofs || {};
  return freeze({
    architectures: freeze(['arm64', 'arm64e', 'x86_64', 'riscv64'].map((id) => stage2ArchitectureMaturity(id, { ...(options.architectureOptions?.[id] || {}), runtimeProof: runtimeProofs[id] }))),
    formats: freeze(['macho', 'elf', 'pe'].map((id) => stage2FormatMaturity(id, { rebuildProof: rebuildProofs[id] }))),
    managed: freeze(['wasm', 'dex', 'cil', 'jvm'].map((id) => stage2ManagedMaturity(id, { runtimeProof: managedRuntimeProofs[id] }))),
    phase12: stage2Phase12Maturity(options.phase12 || {}),
  });
}
