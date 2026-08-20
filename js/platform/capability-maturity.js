const SUPPORTED = 'supported';
const PARTIAL = 'partial';
const UNSUPPORTED = 'unsupported';
const UNAVAILABLE = 'unavailable';

export const CAPABILITY_STATUS = Object.freeze({ SUPPORTED, PARTIAL, UNSUPPORTED, UNAVAILABLE });

function level(code, index) { return Object.freeze({ code, index }); }

export const ARCHITECTURE_LEVELS = Object.freeze({
  A0: level('A0', 0),
  A1: level('A1', 1),
  A2: level('A2', 2),
  A3: level('A3', 3),
  A4: level('A4', 4),
  A5: level('A5', 5),
  A6: level('A6', 6),
  A7: level('A7', 7),
});

export const FORMAT_LEVELS = Object.freeze({
  F0: level('F0', 0),
  F1: level('F1', 1),
  F2: level('F2', 2),
  F3: level('F3', 3),
  F4: level('F4', 4),
  F5: level('F5', 5),
  F6: level('F6', 6),
});

export const MANAGED_LEVELS = Object.freeze({
  M0: level('M0', 0),
  M1: level('M1', 1),
  M2: level('M2', 2),
  M3: level('M3', 3),
  M4: level('M4', 4),
  M5: level('M5', 5),
  M6: level('M6', 6),
});

export const ARCHITECTURE_FEATURE_LEVEL = Object.freeze({
  detect: 'A0',
  decode: 'A1',
  lowLevelEffects: 'A2',
  cfgSemanticIR: 'A3',
  ssaMemoryDataflow: 'A4',
  typesInterprocedural: 'A5',
  decompiler: 'A6',
  runtimeDebugPatchValidation: 'A7',
});

export const FORMAT_FEATURE_LEVEL = Object.freeze({
  detect: 'F0',
  parseStructures: 'F1',
  correctMapping: 'F2',
  importsExportsRelocations: 'F3',
  functionDebugUnwind: 'F4',
  runtimeLanguageMetadata: 'F5',
  validatedRebuildPatch: 'F6',
});

export const MANAGED_FEATURE_LEVEL = Object.freeze({
  detectContainer: 'M0',
  metadata: 'M1',
  vmEffects: 'M2',
  cfgSsa: 'M3',
  typesInterprocedural: 'M4',
  decompiler: 'M5',
  runtimeDebug: 'M6',
});

function freezeFeatures(features) { return Object.freeze({ ...features }); }
function freezeCodes(codes) { return Object.freeze([...new Set(codes)]); }

// A2 is the Master Architecture exact MachineEffects contract. Phase 2 now
// provides explicit effects for a measured ARM64 subset, but incomplete
// coverage deliberately remains PARTIAL and therefore does not fully satisfy A2.
const ARCHITECTURE_PROFILES = Object.freeze({
  arm64: Object.freeze({
    implementedLevel: 'A6',
    fullySatisfiedLevel: 'A1',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      decode: SUPPORTED,
      lowLevelEffects: PARTIAL,
      cfgSemanticIR: SUPPORTED,
      ssaMemoryDataflow: SUPPORTED,
      typesInterprocedural: SUPPORTED,
      decompiler: SUPPORTED,
      runtimeDebugPatchValidation: PARTIAL,
    }),
    limitations: freezeCodes([
      'exact-machine-effects-partial-coverage',
      'runtime-debug-patch-validation-incomplete',
    ]),
  }),
  arm64e: Object.freeze({
    implementedLevel: 'A6',
    fullySatisfiedLevel: 'A1',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      decode: SUPPORTED,
      lowLevelEffects: PARTIAL,
      cfgSemanticIR: PARTIAL,
      ssaMemoryDataflow: PARTIAL,
      typesInterprocedural: PARTIAL,
      decompiler: PARTIAL,
      runtimeDebugPatchValidation: PARTIAL,
    }),
    limitations: freezeCodes([
      'exact-machine-effects-partial-coverage',
      'arm64e-pointer-authentication-semantics-partial',
      'runtime-debug-patch-validation-incomplete',
    ]),
  }),
  // Phase 5 release-truth repair. The declarations below were written before
  // P5-6 landed and still said x86-64 was decode-only. The merged Phase 5
  // product proves otherwise: tests/phase5/verification/compiler-corpus-pipeline
  // instantiates all 144 mandatory corpus tuples and takes each one through
  // exact MachineEffects, Semantic IR, CFG, SSA, MemorySSA and the shared
  // decompiler against an independent LLVM oracle.
  //
  // The promotion is deliberately limited to what that evidence proves.
  // `implementedLevel` moves to A6 because the whole vertical is implemented and
  // exercised; A2 stays PARTIAL because exact effects are proven for the
  // mandatory corpus, not for the entire x86-64 instruction set; and because a
  // target never gains a level by skipping an incomplete prerequisite, the
  // cumulative `fullySatisfiedLevel` stays A1 -- exactly the shape arm64 has.
  x86_64: Object.freeze({
    implementedLevel: 'A6',
    fullySatisfiedLevel: 'A1',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      decode: SUPPORTED,
      lowLevelEffects: PARTIAL,
      cfgSemanticIR: SUPPORTED,
      ssaMemoryDataflow: SUPPORTED,
      typesInterprocedural: PARTIAL,
      decompiler: SUPPORTED,
      runtimeDebugPatchValidation: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'exact-machine-effects-partial-coverage',
      'x86-64-types-interprocedural-partial',
      'runtime-debug-patch-validation-incomplete',
    ]),
  }),
  // Phase 6. The mandatory RISC-V corpus proves an A6-depth vertical for the
  // frozen RV64IMC / LP64 profile: 264 tuples across two ELF targets and six
  // optimization levels, all-exact effects, through the same generic middle-end
  // as arm64 and x86-64. Exactness is proven for that profile, not for every
  // RISC-V extension -- A/F/D/Q/V/Zicsr and the privileged architecture are
  // explicitly outside it -- so A2 is PARTIAL and cumulative maturity is A1.
  riscv64: Object.freeze({
    implementedLevel: 'A6',
    fullySatisfiedLevel: 'A1',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      decode: SUPPORTED,
      lowLevelEffects: PARTIAL,
      cfgSemanticIR: SUPPORTED,
      ssaMemoryDataflow: SUPPORTED,
      typesInterprocedural: PARTIAL,
      decompiler: SUPPORTED,
      runtimeDebugPatchValidation: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'riscv64-exact-effects-limited-to-rv64imc-profile',
      'riscv64-atomic-float-vector-extensions-unsupported',
      'riscv64-types-interprocedural-partial',
      'runtime-debug-patch-validation-incomplete',
    ]),
  }),
});

// F3 requires the imports/exports/relocations contract as a whole. Current
// parsers expose substantial coverage plus explicit incomplete/unsupported cases.
const FORMAT_PROFILES = Object.freeze({
  macho: Object.freeze({
    implementedLevel: 'F5',
    fullySatisfiedLevel: 'F2',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      parseStructures: SUPPORTED,
      correctMapping: SUPPORTED,
      importsExportsRelocations: PARTIAL,
      functionDebugUnwind: PARTIAL,
      runtimeLanguageMetadata: PARTIAL,
      validatedRebuildPatch: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'link-metadata-partial',
      'function-debug-unwind-partial',
      'macho-runtime-language-metadata-partial',
      'validated-rebuild-patch-unsupported',
    ]),
  }),
  elf: Object.freeze({
    implementedLevel: 'F4',
    fullySatisfiedLevel: 'F2',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      parseStructures: SUPPORTED,
      correctMapping: SUPPORTED,
      importsExportsRelocations: PARTIAL,
      functionDebugUnwind: PARTIAL,
      runtimeLanguageMetadata: UNSUPPORTED,
      validatedRebuildPatch: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'link-metadata-partial',
      'function-debug-unwind-partial',
      'validated-rebuild-patch-unsupported',
    ]),
  }),
  pe: Object.freeze({
    implementedLevel: 'F4',
    fullySatisfiedLevel: 'F2',
    status: PARTIAL,
    features: freezeFeatures({
      detect: SUPPORTED,
      parseStructures: SUPPORTED,
      correctMapping: SUPPORTED,
      importsExportsRelocations: PARTIAL,
      functionDebugUnwind: PARTIAL,
      runtimeLanguageMetadata: UNSUPPORTED,
      validatedRebuildPatch: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'link-metadata-partial',
      'function-debug-unwind-partial',
      'validated-rebuild-patch-unsupported',
    ]),
  }),
});

const ARCHITECTURE_LEVEL_DISPLAY = Object.freeze({
  A0: 'Detect', A1: 'Decode', A2: 'Exact low-level effects', A3: 'CFG + Semantic IR',
  A4: 'SSA + MemorySSA + dataflow', A5: 'Types + interprocedural', A6: 'Decompiler',
  A7: 'Runtime/debug/patch validation',
});
const FORMAT_LEVEL_DISPLAY = Object.freeze({
  F0: 'Detect', F1: 'Parse structures', F2: 'Correct mapping', F3: 'Imports/exports/relocations',
  F4: 'Function/debug/unwind', F5: 'Runtime/language metadata', F6: 'Validated rebuild/patch',
});
const MANAGED_LEVEL_DISPLAY = Object.freeze({
  M0: 'Detect/container', M1: 'Metadata', M2: 'Exact VMEffects', M3: 'CFG/SSA',
  M4: 'Types/interprocedural', M5: 'Decompiler', M6: 'Runtime/debug',
});
const STATUS_DISPLAY = Object.freeze({
  [SUPPORTED]: 'Supported', [PARTIAL]: 'Partial', [UNSUPPORTED]: 'Unsupported', [UNAVAILABLE]: 'Unavailable',
});
const LIMITATION_DISPLAY = Object.freeze({
  'exact-machine-effects-partial-coverage': 'MachineEffects are implemented for a measured instruction subset; remaining partial or unsupported instructions keep A2 from being fully satisfied.',
  'x86-64-types-interprocedural-partial': 'x86-64 reaches the shared type and interprocedural analysis, but that stage is not independently proven for x86-64 by the mandatory corpus.',
  'riscv64-exact-effects-limited-to-rv64imc-profile': 'RISC-V exact MachineEffects are proven for the frozen RV64IMC profile only; other encodings remain explicitly partial or unsupported.',
  'riscv64-atomic-float-vector-extensions-unsupported': 'The RISC-V A, F, D, Q and V extensions, Zicsr, and the privileged architecture are outside the frozen Phase 6 profile and are not supported.',
  'riscv64-types-interprocedural-partial': 'RISC-V reaches the shared type and interprocedural analysis, but that stage is not independently proven for RISC-V by the mandatory corpus.',
  'runtime-debug-patch-validation-incomplete': 'Runtime/debug/patch validation does not meet A7.',
  'arm64e-pointer-authentication-semantics-partial': 'arm64e pointer-authentication data semantics are partial.',
  // Retained so historical reports still render. No current profile emits it:
  // Phase 5 proved the x86-64 semantic vertical on its mandatory corpus.
  'x86-64-semantic-analysis-unsupported': 'x86-64 is decode-only; semantic lifting, CFG/SSA analysis, and decompilation are not supported.',
  'decoder-unavailable': 'The decoder is unavailable in the current runtime.',
  'unknown-architecture': 'The architecture is not recognized by the current capability registry.',
  'link-metadata-partial': 'Imports/exports/relocations are implemented only partially; known incomplete or unsupported cases remain.',
  'function-debug-unwind-partial': 'Function/debug/unwind evidence is implemented only partially for this format.',
  'macho-runtime-language-metadata-partial': 'Mach-O runtime/language metadata coverage is partial.',
  'validated-rebuild-patch-unsupported': 'Validated format rebuild/patch support is not implemented.',
  'unknown-format': 'The executable format is not recognized by the current capability registry.',
  'managed-frontend-unsupported': 'No managed/VM frontend is currently implemented at this maturity level.',
  'runtime-debug-provider-phase10-deferred': 'Runtime debugging and live provider integration is deferred pending Phase 10 provider contracts.',
  'solver-backed-verification-phase9-deferred': 'Solver-backed symbolic verification is deferred pending Phase 9 SolverBackend contracts.',
  'managed-types-interprocedural-partial': 'Managed type constraint and interprocedural analysis is partial.',
});

const MANAGED_PROFILES = Object.freeze({
  wasm: Object.freeze({
    implementedLevel: 'M5',
    fullySatisfiedLevel: 'M5',
    status: PARTIAL,
    features: freezeFeatures({
      detectContainer: SUPPORTED,
      metadata: SUPPORTED,
      vmEffects: SUPPORTED,
      cfgSsa: SUPPORTED,
      typesInterprocedural: SUPPORTED,
      decompiler: SUPPORTED,
      runtimeDebug: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'runtime-debug-provider-phase10-deferred',
      'solver-backed-verification-phase9-deferred',
    ]),
  }),
  dex: Object.freeze({
    implementedLevel: 'M5',
    fullySatisfiedLevel: 'M5',
    status: PARTIAL,
    features: freezeFeatures({
      detectContainer: SUPPORTED,
      metadata: SUPPORTED,
      vmEffects: SUPPORTED,
      cfgSsa: SUPPORTED,
      typesInterprocedural: SUPPORTED,
      decompiler: SUPPORTED,
      runtimeDebug: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'runtime-debug-provider-phase10-deferred',
      'solver-backed-verification-phase9-deferred',
    ]),
  }),
  cil: Object.freeze({
    implementedLevel: 'M5',
    fullySatisfiedLevel: 'M5',
    status: PARTIAL,
    features: freezeFeatures({
      detectContainer: SUPPORTED,
      metadata: SUPPORTED,
      vmEffects: SUPPORTED,
      cfgSsa: SUPPORTED,
      typesInterprocedural: SUPPORTED,
      decompiler: SUPPORTED,
      runtimeDebug: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'runtime-debug-provider-phase10-deferred',
      'solver-backed-verification-phase9-deferred',
    ]),
  }),
  jvm: Object.freeze({
    implementedLevel: 'M5',
    fullySatisfiedLevel: 'M5',
    status: PARTIAL,
    features: freezeFeatures({
      detectContainer: SUPPORTED,
      metadata: SUPPORTED,
      vmEffects: SUPPORTED,
      cfgSsa: SUPPORTED,
      typesInterprocedural: SUPPORTED,
      decompiler: SUPPORTED,
      runtimeDebug: UNSUPPORTED,
    }),
    limitations: freezeCodes([
      'runtime-debug-provider-phase10-deferred',
      'solver-backed-verification-phase9-deferred',
    ]),
  }),
});

export function normalizeArchitectureCapabilityId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'aarch64') return 'arm64';
  if (id === 'amd64' || id === 'x64') return 'x86_64';
  // `riscv64` is canonical. A bare `riscv` is deliberately NOT aliased: it does
  // not say whether the target is RV32 or RV64, and inventing a width here
  // would create a second architecture identity for the same profile.
  if (id === 'rv64' || id === 'riscv64gc') return 'riscv64';
  return id || 'unknown';
}

export function normalizeFormatCapabilityId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'mach-o' || id === 'mach_o') return 'macho';
  if (id === 'pe32' || id === 'pe32+') return 'pe';
  return id || 'unknown';
}

function materialize(kind, id, profile, limitations = profile?.limitations || []) {
  if (!profile) {
    return Object.freeze({
      kind, id, implementedLevel: null, level: null, fullySatisfiedLevel: null,
      status: UNSUPPORTED, partial: false, features: Object.freeze({}),
      limitations: freezeCodes(limitations),
    });
  }
  return Object.freeze({
    kind,
    id,
    implementedLevel: profile.implementedLevel,
    level: profile.fullySatisfiedLevel,
    fullySatisfiedLevel: profile.fullySatisfiedLevel,
    status: profile.status,
    partial: profile.status === PARTIAL,
    features: profile.features,
    limitations: freezeCodes(limitations),
  });
}

function downgradeForMissingDecoder(model) {
  if (model.status === UNSUPPORTED || model.features.detect !== SUPPORTED) return model;
  const features = { ...model.features, decode: UNAVAILABLE };
  for (const feature of Object.keys(ARCHITECTURE_FEATURE_LEVEL)) {
    const levelCode = ARCHITECTURE_FEATURE_LEVEL[feature];
    if (ARCHITECTURE_LEVELS[levelCode].index >= ARCHITECTURE_LEVELS.A2.index && features[feature] !== UNSUPPORTED) {
      features[feature] = UNAVAILABLE;
    }
  }
  return Object.freeze({
    ...model,
    level: 'A0',
    fullySatisfiedLevel: 'A0',
    status: PARTIAL,
    partial: true,
    features: freezeFeatures(features),
    limitations: freezeCodes([...model.limitations, 'decoder-unavailable']),
  });
}

export function architectureMaturity(architecture, options = {}) {
  const id = normalizeArchitectureCapabilityId(architecture);
  const profile = ARCHITECTURE_PROFILES[id];
  const base = materialize('architecture', id, profile, profile?.limitations || ['unknown-architecture']);
  return options.decoderAvailable === false ? downgradeForMissingDecoder(base) : base;
}

export function formatMaturity(format) {
  const id = normalizeFormatCapabilityId(format);
  const profile = FORMAT_PROFILES[id];
  return materialize('format', id, profile, profile?.limitations || ['unknown-format']);
}

export function normalizeManagedCapabilityId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'webassembly' || id === 'wat') return 'wasm';
  if (id === 'dalvik' || id === 'apk') return 'dex';
  if (id === 'clr' || id === 'dotnet' || id === '.net') return 'cil';
  if (id === 'java' || id === 'class' || id === 'jar') return 'jvm';
  return id || 'unknown';
}

export function managedMaturity(frontend) {
  const id = normalizeManagedCapabilityId(frontend);
  const profile = MANAGED_PROFILES[id];
  return materialize('managed', id, profile, profile?.limitations || ['managed-frontend-unsupported']);
}

export function featureAvailable(maturity, feature) {
  const state = maturity?.features?.[feature];
  return state === SUPPORTED || state === PARTIAL;
}

export function capabilityDisplay(maturity) {
  const labels = maturity?.kind === 'architecture' ? ARCHITECTURE_LEVEL_DISPLAY
    : maturity?.kind === 'format' ? FORMAT_LEVEL_DISPLAY : MANAGED_LEVEL_DISPLAY;
  const levelCode = maturity?.level || null;
  const implementedLevelCode = maturity?.implementedLevel || null;
  const levelLabel = levelCode ? labels[levelCode] || levelCode : null;
  const implementedLevelLabel = implementedLevelCode ? labels[implementedLevelCode] || implementedLevelCode : null;
  const statusLabel = STATUS_DISPLAY[maturity?.status] || STATUS_DISPLAY[UNSUPPORTED];
  const partialTail = levelCode && implementedLevelCode && levelCode !== implementedLevelCode
    ? ` (partial/legacy implementation through ${implementedLevelCode} ${implementedLevelLabel})`
    : '';
  return Object.freeze({
    levelCode,
    levelLabel,
    implementedLevelCode,
    implementedLevelLabel,
    statusLabel,
    summary: levelCode ? `${levelCode} ${levelLabel} — ${statusLabel}${partialTail}` : statusLabel,
    limitations: Object.freeze((maturity?.limitations || []).map((code) => LIMITATION_DISPLAY[code] || code)),
  });
}

export function currentSupportMatrix(options = {}) {
  const decoderSupport = options.decoderSupport || { arm64: true, x86_64: true };
  const decoderFor = (id) => id === 'arm64e'
    ? decoderSupport.arm64e !== false && decoderSupport.arm64 !== false
    : decoderSupport[id] !== false;
  return Object.freeze({
    architectures: Object.freeze(['arm64', 'arm64e', 'x86_64', 'riscv64'].map((id) => architectureMaturity(id, { decoderAvailable: decoderFor(id) }))),
    formats: Object.freeze(['macho', 'elf', 'pe'].map((id) => formatMaturity(id))),
    managed: Object.freeze(['wasm', 'dex', 'cil', 'jvm'].map((id) => managedMaturity(id))),
  });
}
