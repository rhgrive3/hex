import assert from 'node:assert/strict';
import { architectureCapability } from '../js/architecture/index.js';
import {
  ARCHITECTURE_LEVELS,
  FORMAT_LEVELS,
  MANAGED_LEVELS,
  CAPABILITY_STATUS,
  architectureMaturity,
  formatMaturity,
  managedMaturity,
  capabilityDisplay,
  currentSupportMatrix,
} from '../js/platform/capability-maturity.js';
import { supportDisplayForTruth, supportTruthForImage } from '../js/platform/support-capability.js';

assert.deepEqual(Object.keys(ARCHITECTURE_LEVELS), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
assert.deepEqual(Object.keys(FORMAT_LEVELS), ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
assert.deepEqual(Object.keys(MANAGED_LEVELS), ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']);

// Legacy ARM64 analysis is real, but it must not mint A2 before exact MachineEffects exist.
const arm64 = architectureMaturity('arm64');
assert.equal(arm64.level, 'A1');
assert.equal(arm64.implementedLevel, 'A6');
assert.equal(arm64.fullySatisfiedLevel, 'A1');
assert.equal(arm64.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(arm64.features.decode, 'supported');
assert.equal(arm64.features.lowLevelEffects, 'partial');
assert.equal(arm64.features.cfgSemanticIR, 'supported');
assert.equal(arm64.features.ssaMemoryDataflow, 'supported');
assert.equal(arm64.features.typesInterprocedural, 'supported');
assert.equal(arm64.features.decompiler, 'supported');
assert.equal(arm64.features.runtimeDebugPatchValidation, 'partial');
assert.ok(arm64.limitations.includes('exact-machine-effects-partial-coverage'));

const arm64e = architectureMaturity('arm64e');
assert.equal(arm64e.level, 'A1');
assert.equal(arm64e.implementedLevel, 'A6');
assert.equal(arm64e.fullySatisfiedLevel, 'A1');
assert.equal(arm64e.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(arm64e.features.decode, 'supported');
assert.equal(arm64e.features.lowLevelEffects, 'partial');
assert.equal(arm64e.features.cfgSemanticIR, 'partial');
assert.equal(arm64e.features.decompiler, 'partial');
assert.ok(arm64e.limitations.includes('exact-machine-effects-partial-coverage'));
assert.ok(arm64e.limitations.includes('arm64e-pointer-authentication-semantics-partial'));

// Phase 5 proved the x86-64 semantic vertical on its full mandatory corpus, so
// the implemented depth is A6. Exact effects are proven for that corpus rather
// than for the whole instruction set, so A2 stays partial and -- because a
// target never gains a level by skipping an incomplete prerequisite -- the
// cumulative level stays A1.
const x86 = architectureMaturity('x86_64');
assert.equal(x86.level, 'A1');
assert.equal(x86.implementedLevel, 'A6');
assert.equal(x86.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(x86.features.decode, 'supported');
assert.equal(x86.features.lowLevelEffects, 'partial');
assert.equal(x86.features.cfgSemanticIR, 'supported');
assert.equal(x86.features.ssaMemoryDataflow, 'supported');
assert.equal(x86.features.decompiler, 'supported');
assert.equal(x86.features.runtimeDebugPatchValidation, 'unsupported');

// Phase 6: RISC-V64 reaches the same depth for the frozen RV64IMC/LP64 profile.
const riscv64 = architectureMaturity('riscv64');
assert.equal(riscv64.level, 'A1');
assert.equal(riscv64.implementedLevel, 'A6');
assert.equal(riscv64.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(riscv64.features.decode, 'supported');
assert.equal(riscv64.features.lowLevelEffects, 'partial');
assert.equal(riscv64.features.cfgSemanticIR, 'supported');
assert.equal(riscv64.features.ssaMemoryDataflow, 'supported');
assert.equal(riscv64.features.decompiler, 'supported');
assert.ok(riscv64.limitations.includes('riscv64-exact-effects-limited-to-rv64imc-profile'));
assert.ok(riscv64.limitations.includes('riscv64-atomic-float-vector-extensions-unsupported'));

// A bare `riscv` does not say RV32 or RV64 and must not resolve to a profile.
assert.equal(architectureMaturity('riscv').status, CAPABILITY_STATUS.UNSUPPORTED);

const unknown = architectureMaturity('made-up-cpu');
assert.equal(unknown.level, null);
assert.equal(unknown.implementedLevel, null);
assert.equal(unknown.status, CAPABILITY_STATUS.UNSUPPORTED);
assert.ok(unknown.limitations.includes('unknown-architecture'));

const noDecoder = architectureMaturity('arm64', { decoderAvailable: false });
assert.equal(noDecoder.implementedLevel, 'A6');
assert.equal(noDecoder.level, 'A0');
assert.equal(noDecoder.features.decode, 'unavailable');
assert.equal(noDecoder.features.lowLevelEffects, 'unavailable');
assert.equal(noDecoder.features.cfgSemanticIR, 'unavailable');
assert.equal(noDecoder.features.decompiler, 'unavailable');
assert.ok(noDecoder.limitations.includes('decoder-unavailable'));

const x86Truth = supportTruthForImage(
  { arch: 'x86_64', format: 'elf' },
  { engine: { x86_64: true, verified: true } },
);
assert.equal(x86Truth.architecture.level, 'A1');
assert.equal(x86Truth.architecture.implementedLevel, 'A6');
assert.equal(x86Truth.architecture.features.lowLevelEffects, 'partial');
assert.equal(x86Truth.architecture.features.decompiler, 'supported');
assert.equal(x86Truth.format.level, 'F2');
assert.equal(x86Truth.format.implementedLevel, 'F4');
assert.equal(x86Truth.format.features.importsExportsRelocations, 'partial');

const arm64Truth = supportTruthForImage(
  { arch: 'arm64', format: 'macho' },
  { engine: { arm64: true, verified: true } },
);
assert.equal(arm64Truth.architecture.level, 'A1');
assert.equal(arm64Truth.architecture.implementedLevel, 'A6');
assert.equal(arm64Truth.architecture.features.lowLevelEffects, 'partial');
assert.equal(arm64Truth.architecture.features.decompiler, 'supported');
assert.equal(arm64Truth.format.level, 'F2');
assert.equal(arm64Truth.format.features.importsExportsRelocations, 'partial');

const unavailableTruth = supportTruthForImage(
  { arch: 'arm64', format: 'macho' },
  { engine: { arm64: false, verified: true } },
);
assert.equal(unavailableTruth.architecture.level, 'A0');
assert.equal(unavailableTruth.architecture.features.decode, 'unavailable');
assert.equal(unavailableTruth.architecture.features.decompiler, 'unavailable');

// Legacy boolean API remains compatible while canonical maturity stays conservative.
const x86Capability = architectureCapability({ arch: 'x86_64', format: 'elf', endian: 'little', bits: 64 }, { x86_64: true, verified: true });
assert.equal(x86Capability.canDisassemble, true);
assert.equal(x86Capability.canAnalyzeDataflow, false);
const arm64Capability = architectureCapability({ arch: 'arm64', format: 'macho', endian: 'little', bits: 64 }, { arm64: true, verified: true });
assert.equal(arm64Capability.canDisassemble, true);
assert.equal(arm64Capability.canAnalyzeDataflow, true);

// F3 is cumulative too: partial link metadata keeps maturity at F2.
const macho = formatMaturity('macho');
assert.equal(macho.level, 'F2');
assert.equal(macho.implementedLevel, 'F5');
assert.equal(macho.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(macho.features.parseStructures, 'supported');
assert.equal(macho.features.correctMapping, 'supported');
assert.equal(macho.features.importsExportsRelocations, 'partial');
assert.equal(macho.features.functionDebugUnwind, 'partial');
assert.equal(macho.features.runtimeLanguageMetadata, 'partial');
assert.equal(macho.features.validatedRebuildPatch, 'unsupported');
assert.ok(macho.limitations.includes('link-metadata-partial'));

for (const format of ['elf', 'pe']) {
  const maturity = formatMaturity(format);
  assert.equal(maturity.level, 'F2');
  assert.equal(maturity.implementedLevel, 'F4');
  assert.equal(maturity.features.parseStructures, 'supported');
  assert.equal(maturity.features.correctMapping, 'supported');
  assert.equal(maturity.features.importsExportsRelocations, 'partial');
  assert.equal(maturity.features.functionDebugUnwind, 'partial');
  assert.equal(maturity.features.validatedRebuildPatch, 'unsupported');
  assert.ok(maturity.limitations.includes('link-metadata-partial'));
}

const managed = managedMaturity('dex');
assert.equal(managed.level, 'M5');
assert.equal(managed.implementedLevel, 'M5');
assert.equal(managed.fullySatisfiedLevel, 'M5');
assert.equal(managed.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(managed.features.detectContainer, 'supported');
assert.equal(managed.features.metadata, 'supported');
assert.equal(managed.features.vmEffects, 'supported');
assert.equal(managed.features.cfgSsa, 'supported');
assert.equal(managed.features.typesInterprocedural, 'supported');
assert.equal(managed.features.decompiler, 'supported');
assert.equal(managed.features.runtimeDebug, 'unsupported');

assert.equal(arm64.display, undefined);
const arm64Display = capabilityDisplay(arm64);
assert.equal(arm64Display.levelCode, 'A1');
assert.equal(arm64Display.implementedLevelCode, 'A6');
assert.equal(arm64Display.statusLabel, 'Partial');
assert.match(arm64Display.summary, /partial\/legacy implementation through A6/);
assert.ok(arm64Display.limitations.some((text) => text.includes('MachineEffects')));
const projectedDisplay = supportDisplayForTruth(arm64Truth);
assert.equal(projectedDisplay.format.levelCode, 'F2');
assert.equal(projectedDisplay.format.implementedLevelCode, 'F5');

const matrix = currentSupportMatrix({ decoderSupport: { arm64: true, x86_64: true } });
assert.deepEqual(matrix.architectures.map((entry) => [entry.id, entry.level, entry.implementedLevel, entry.status]), [
  ['arm64', 'A1', 'A6', 'partial'],
  ['arm64e', 'A1', 'A6', 'partial'],
  ['x86_64', 'A1', 'A6', 'partial'],
  ['riscv64', 'A1', 'A6', 'partial'],
]);
assert.deepEqual(matrix.formats.map((entry) => [entry.id, entry.level, entry.implementedLevel, entry.features.importsExportsRelocations]), [
  ['macho', 'F2', 'F5', 'partial'],
  ['elf', 'F2', 'F4', 'partial'],
  ['pe', 'F2', 'F4', 'partial'],
]);
assert.deepEqual(matrix.managed.map((entry) => [entry.id, entry.level, entry.implementedLevel, entry.status]), [
  ['wasm', 'M5', 'M5', 'partial'],
  ['dex', 'M5', 'M5', 'partial'],
  ['cil', 'M5', 'M5', 'partial'],
  ['jvm', 'M5', 'M5', 'partial'],
]);

console.log('capability-maturity: PASS');
