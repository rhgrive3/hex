import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { normalizeArchitectureCapabilityId } from '../../../js/platform/capability-maturity.js';
import { riscvAbiFromElfFlags } from '../../../js/targets/abi/riscv-lp64.js';
import { buildPhase6VerificationCorpus } from '../../../tools/validation/phase6/build-verification-corpus.mjs';

let corpus = null;
function fixtures() {
  if (!corpus) corpus = buildPhase6VerificationCorpus();
  return corpus.fixtures;
}
function imageFor(id) {
  const fixture = fixtures().find((item) => item.id === id);
  assert.ok(fixture, `corpus fixture missing: ${id}`);
  return { fixture, image: parseELF(new Uint8Array(fixture.bytes)) };
}

test('EM_RISCV plus ELFCLASS64 produces the one canonical architecture identity', () => {
  const { image } = imageFor('riscv64-lp64-exec-O2');
  assert.equal(image.arch, 'riscv64', 'the loader must emit riscv64, never a width-ambiguous "riscv"');
  assert.equal(image.bits, 64);
  assert.equal(image.endian, 'little');
  assert.equal(image.metadata.machine, 243, 'EM_RISCV');

  // The same identity must resolve everywhere downstream.
  assert.equal(architecturePluginV2(image.arch).id, 'riscv64');
  assert.equal(normalizeArchitectureCapabilityId(image.arch), 'riscv64');
  assert.equal(normalizeArchitectureCapabilityId('rv64'), 'riscv64', 'rv64 is a normalized alias');
  // A bare `riscv` is deliberately not aliased: it does not say RV32 or RV64.
  assert.equal(normalizeArchitectureCapabilityId('riscv'), 'riscv');
  assert.notEqual(architecturePluginV2('riscv').id, 'riscv64');
});

test('both mandatory ELF types load and route identically', () => {
  const exec = imageFor('riscv64-lp64-exec-O2');
  const pie = imageFor('riscv64-lp64-pie-O2');
  assert.equal(exec.image.metadata.type, 2, 'ET_EXEC');
  assert.equal(pie.image.metadata.type, 3, 'ET_DYN');
  for (const { image } of [exec, pie]) {
    assert.equal(image.arch, 'riscv64');
    assert.ok(image.entrypoint > 0n, 'an entrypoint must be recovered');
    assert.ok(image.sections.length > 0, 'sections must be parsed');
    assert.ok(image.segments.length > 0, 'segments must be parsed');
    assert.ok(image.sections.some((section) => section.perms?.execute), 'an executable range must be identified');
  }
});

test('the psABI variant is selected from the ELF header, not assumed', () => {
  const { image } = imageFor('riscv64-lp64-exec-O2');
  const selected = riscvAbiFromElfFlags(image.metadata.flags, { bits: image.bits });
  assert.equal(selected.supported, true);
  assert.equal(selected.abiId, 'lp64', 'the corpus is built -mabi=lp64, and the header says so');
  assert.equal(selected.compressed, true, 'EF_RISCV_RVC is set because the corpus is built -march=rv64imc');
  assert.equal(selected.floatAbi, 'soft');
});

test('the PIE target carries the relocation the ELF lane exists to exercise', () => {
  const { fixture } = imageFor('riscv64-lp64-pie-O2');
  assert.match(fixture.objectMetadata, /R_RISCV_RELATIVE/,
    'the position-independent fixture must contain a real dynamic relocation');
  const exec = fixtures().find((item) => item.id === 'riscv64-lp64-exec-O2');
  assert.doesNotMatch(exec.objectMetadata, /R_RISCV_RELATIVE/,
    'the non-PIC fixture must not, so the two targets really are different ELF cases');
});

test('symbols and function evidence survive for both targets', () => {
  for (const id of ['riscv64-lp64-exec-O2', 'riscv64-lp64-pie-O2']) {
    const { fixture } = imageFor(id);
    assert.match(fixture.objectMetadata, /p6_scalar_integer_arithmetic/, `${id} must retain corpus symbols`);
    assert.match(fixture.disassembly, /<p6_entry>:/, `${id} must retain its entry symbol`);
  }
});

test('a truncated or non-ELF input fails closed instead of guessing an architecture', () => {
  assert.throws(() => parseELF(new Uint8Array([0x7f, 0x45, 0x4c])), /not an ELF file/);
  const { fixture } = imageFor('riscv64-lp64-exec-O2');
  const corrupt = new Uint8Array(fixture.bytes);
  corrupt[4] = 7; // invalid ELFCLASS
  assert.throws(() => parseELF(corrupt), /unsupported ELF class/);
});

test('a 32-bit RISC-V image is a different identity and is not claimed as supported', () => {
  const { fixture } = imageFor('riscv64-lp64-exec-O2');
  const rv32 = new Uint8Array(fixture.bytes);
  rv32[4] = 1; // ELFCLASS32
  // The header no longer describes a consistent 64-bit image, so parsing is
  // expected to fail; what must never happen is silently calling it riscv64.
  let identity = null;
  try { identity = parseELF(rv32).arch; } catch { identity = null; }
  assert.notEqual(identity, 'riscv64');
  assert.equal(riscvAbiFromElfFlags(0x1, { bits: 32 }).supported, false);
});
