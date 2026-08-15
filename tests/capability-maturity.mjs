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

assert.deepEqual(Object.keys(ARCHITECTURE_LEVELS), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
assert.deepEqual(Object.keys(FORMAT_LEVELS), ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
assert.deepEqual(Object.keys(MANAGED_LEVELS), ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']);

const arm64 = architectureMaturity('arm64');
assert.equal(arm64.level, 'A6');
assert.equal(arm64.fullySatisfiedLevel, 'A6');
assert.equal(arm64.status, CAPABILITY_STATUS.SUPPORTED);
assert.equal(arm64.partial, false);
assert.equal(arm64.features.decode, 'supported');
assert.equal(arm64.features.lowLevelEffects, 'supported');
assert.equal(arm64.features.cfgSemanticIR, 'supported');
assert.equal(arm64.features.ssaMemoryDataflow, 'supported');
assert.equal(arm64.features.decompiler, 'supported');
assert.equal(arm64.features.runtimeDebugPatchValidation, 'partial');

const arm64e = architectureMaturity('arm64e');
assert.equal(arm64e.level, 'A6');
assert.equal(arm64e.fullySatisfiedLevel, 'A1');
assert.equal(arm64e.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(arm64e.partial, true);
assert.equal(arm64e.features.decode, 'supported');
assert.equal(arm64e.features.lowLevelEffects, 'partial');
assert.equal(arm64e.features.decompiler, 'partial');
assert.ok(arm64e.limitations.includes('arm64e-pointer-authentication-semantics-partial'));

const x86 = architectureMaturity('x86_64');
assert.equal(x86.level, 'A1');
assert.equal(x86.fullySatisfiedLevel, 'A1');
assert.equal(x86.status, CAPABILITY_STATUS.SUPPORTED);
assert.equal(x86.features.decode, 'supported');
assert.equal(x86.features.lowLevelEffects, 'unsupported');
assert.equal(x86.features.cfgSemanticIR, 'unsupported');
assert.equal(x86.features.ssaMemoryDataflow, 'unsupported');
assert.equal(x86.features.decompiler, 'unsupported');

const unknown = architectureMaturity('made-up-cpu');
assert.equal(unknown.id, 'made-up-cpu');
assert.equal(unknown.level, null);
assert.equal(unknown.status, CAPABILITY_STATUS.UNSUPPORTED);
assert.ok(unknown.limitations.includes('unknown-architecture'));

const noDecoder = architectureMaturity('arm64', { decoderAvailable: false });
assert.equal(noDecoder.implementedLevel, 'A6');
assert.equal(noDecoder.level, 'A0');
assert.equal(noDecoder.fullySatisfiedLevel, 'A0');
assert.equal(noDecoder.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(noDecoder.features.detect, 'supported');
assert.equal(noDecoder.features.decode, 'unavailable');
assert.equal(noDecoder.features.lowLevelEffects, 'unavailable');
assert.equal(noDecoder.features.ssaMemoryDataflow, 'unavailable');
assert.equal(noDecoder.features.decompiler, 'unavailable');
assert.ok(noDecoder.limitations.includes('decoder-unavailable'));

// A working decoder is only A1 for x86-64. It must never imply semantics.
const x86Capability = architectureCapability({ arch: 'x86_64', format: 'elf', endian: 'little', bits: 64 }, { x86_64: true, verified: true });
assert.equal(x86Capability.canDisassemble, true);
assert.equal(x86Capability.canLiftSemantics, false);
assert.equal(x86Capability.canBuildCFG, false);
assert.equal(x86Capability.canBuildSSA, false);
assert.equal(x86Capability.canAnalyzeDataflow, false);
assert.equal(x86Capability.canDecompile, false);
assert.equal(x86Capability.maturity.level, 'A1');

const unavailableCapability = architectureCapability({ arch: 'arm64', format: 'macho', endian: 'little', bits: 64 }, { arm64: false, verified: true });
assert.equal(unavailableCapability.canDisassemble, false);
assert.equal(unavailableCapability.canLiftSemantics, false);
assert.equal(unavailableCapability.canBuildCFG, false);
assert.equal(unavailableCapability.canBuildSSA, false);
assert.equal(unavailableCapability.canAnalyzeDataflow, false);
assert.equal(unavailableCapability.canDecompile, false);
assert.equal(unavailableCapability.maturity.level, 'A0');

const arm64eCapability = architectureCapability({ arch: 'arm64e', format: 'macho', endian: 'little', bits: 64 }, { arm64: true, verified: true });
assert.equal(arm64eCapability.canDisassemble, true);
assert.equal(arm64eCapability.canAnalyzeDataflow, true);
assert.equal(arm64eCapability.canDecompile, true);
assert.equal(arm64eCapability.partial, true);
assert.equal(arm64eCapability.maturity.fullySatisfiedLevel, 'A1');

const macho = formatMaturity('macho');
assert.equal(macho.level, 'F5');
assert.equal(macho.status, CAPABILITY_STATUS.PARTIAL);
assert.equal(macho.features.parseStructures, 'supported');
assert.equal(macho.features.correctMapping, 'supported');
assert.equal(macho.features.importsExportsRelocations, 'supported');
assert.equal(macho.features.runtimeLanguageMetadata, 'partial');
assert.equal(macho.features.validatedRebuildPatch, 'unsupported');

for (const format of ['elf', 'pe']) {
  const maturity = formatMaturity(format);
  assert.equal(maturity.level, 'F4');
  assert.equal(maturity.features.parseStructures, 'supported');
  assert.equal(maturity.features.correctMapping, 'supported');
  assert.equal(maturity.features.importsExportsRelocations, 'supported');
  assert.equal(maturity.features.validatedRebuildPatch, 'unsupported');
}

const managed = managedMaturity('dex');
assert.equal(managed.level, null);
assert.equal(managed.status, CAPABILITY_STATUS.UNSUPPORTED);
assert.ok(managed.limitations.includes('managed-frontend-unsupported'));

// Internal truth contains codes/state only; display text is a separate projection.
assert.equal(arm64.display, undefined);
const arm64Display = capabilityDisplay(arm64);
assert.equal(arm64Display.levelCode, 'A6');
assert.equal(arm64Display.levelLabel, 'Decompiler');
assert.equal(arm64Display.statusLabel, 'Supported');

const matrix = currentSupportMatrix({ decoderSupport: { arm64: true, x86_64: true } });
assert.deepEqual(matrix.architectures.map((entry) => [entry.id, entry.level, entry.status]), [
  ['arm64', 'A6', 'supported'],
  ['arm64e', 'A6', 'partial'],
  ['x86_64', 'A1', 'supported'],
]);
assert.deepEqual(matrix.formats.map((entry) => entry.id), ['macho', 'elf', 'pe']);
assert.deepEqual(matrix.managed, []);

console.log('capability-maturity: PASS');
