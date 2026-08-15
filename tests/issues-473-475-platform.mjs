import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';
import { BinaryImage, functionSeed, mergeFunctionSeeds } from '../js/binary/model.js';
import { describeBinaryImage } from '../js/platform/describe.js';

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

function thin64(cpu, subtype) {
  const bytes = new Uint8Array(32);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xfeedfacf, true);
  dv.setInt32(4, cpu, true);
  dv.setInt32(8, subtype, true);
  dv.setUint32(12, 2, true);
  dv.setUint32(16, 0, true); dv.setUint32(20, 0, true); dv.setUint32(24, 0, true); dv.setUint32(28, 0, true);
  return bytes;
}

function fatWith(slice, cpu, subtype) {
  const offset = 28;
  const bytes = new Uint8Array(offset + slice.length);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); dv.setUint32(4, 1, false);
  dv.setInt32(8, cpu, false); dv.setInt32(12, subtype, false);
  dv.setUint32(16, offset, false); dv.setUint32(20, slice.length, false); dv.setUint32(24, 0, false);
  bytes.set(slice, offset);
  return bytes;
}

{
  const arm64e = parseMachO(thin64(CPU_ARM64, 2));
  assert.equal(arm64e.arch, 'arm64e');
  assert.equal(arm64e.metadata.subtypeBase, 2);
  assert.equal(arm64e.metadata.subtypeName, 'arm64e');
  const desc = describeBinaryImage(arm64e, { engine: { arm64e: true, arm64: true, verified: false } });
  assert.equal(desc.slices[0].info.cpu, 'arm64e');
  assert.equal(desc.slices[0].info.cpuSub, 'arm64e');
  assert.equal(desc.slices[0].info.isArm64, true);
  assert.equal(desc.slices[0].info.isArm64e, true);
  assert.equal(desc.capability.architecture, 'arm64e');
  assert.equal(desc.capability.canDisassemble, true);
  assert.equal(desc.capability.canAnalyzeDataflow, true);
  assert.equal(desc.capability.analysisLevel, 'partial');
  assert.equal(desc.capability.partial, true);
  assert.ok(desc.capability.limitations.length > 0);

  const fat = parseMachO(fatWith(thin64(CPU_ARM64, 2), CPU_ARM64, 2));
  assert.equal(fat.arch, 'arm64e');
  assert.equal(fat.metadata.fat.selected.arch, 'arm64e');

  const arm64 = parseMachO(thin64(CPU_ARM64, 0));
  assert.equal(describeBinaryImage(arm64, { engine: { arm64: true, verified: true } }).capability.analysisLevel, 'full');
  const x86 = parseMachO(thin64(CPU_X86_64, 3));
  assert.equal(describeBinaryImage(x86, { engine: { x86_64: true, verified: true } }).capability.canAnalyzeDataflow, false);
}

{
  const image = new BinaryImage(new Uint8Array(8), { format: 'macho', arch: 'arm64', bits: 64, metadata: {} });
  image.finalize();
  assert.equal(describeBinaryImage(image, { engine: { arm64: true, verified: true } }).capability.engineVerified, true);
  assert.equal(describeBinaryImage(image, { engine: { arm64: true, verified: false } }).capability.engineVerified, false);
  assert.equal(describeBinaryImage(image, { engine: { arm64: true } }).capability.engineVerified, false);
  assert.equal(describeBinaryImage(image).capability.engineVerified, false);
}

{
  const merged = mergeFunctionSeeds([
    functionSeed(0x1000n, { source: 'symbol', confidence: 0.98, name: '_target' }),
    functionSeed(0x1000n, { source: 'heuristic', confidence: 0.2, size: 0x400n }),
  ])[0];
  assert.equal(merged.source, 'symbol'); assert.equal(merged.size, 0x400n); assert.equal(merged.end, 0x1400n);
  assert.equal(merged.extentSource, 'heuristic'); assert.equal(merged.extentConfidence, 0.2); assert.equal(merged.extentInherited, true);

  const own = mergeFunctionSeeds([
    functionSeed(0x2000n, { source: 'symbol', confidence: 0.97, size: 0x20n }),
    functionSeed(0x2000n, { source: 'heuristic', confidence: 0.1, size: 0x100n }),
  ])[0];
  assert.equal(own.size, 0x20n); assert.equal(own.extentSource, 'symbol'); assert.equal(own.extentConfidence, 0.97); assert.equal(own.extentInherited, false);

  const unwind = mergeFunctionSeeds([
    functionSeed(0x3000n, { source: 'symbol', confidence: 0.99 }),
    functionSeed(0x3000n, { source: 'unwind', confidence: 0.9, end: 0x3040n }),
  ])[0];
  assert.equal(unwind.source, 'symbol'); assert.equal(unwind.end, 0x3040n); assert.equal(unwind.size, 0x40n);
  assert.equal(unwind.extentSource, 'unwind'); assert.equal(unwind.extentConfidence, 0.9);
}

console.log('issues #473-#475 platform/architecture regressions PASS');
