import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { parseRiscvAttributes, parseRiscvMappingSymbol, resolveRiscvIsaProfile } from '../../../js/binary/riscv-isa.js';
import { analyzeDecodedSemanticFunction, semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI, MICROSOFT_X64_ABI, RISCV_LP64D_ABI, UNKNOWN_ABI, resolveABIPlugin } from '../../../js/targets/abi/index.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftRiscv64ControlEffects } from '../../../js/targets/architecture/riscv64/effects/control.js';
import { liftArm64MemoryEffects } from '../../../js/targets/architecture/arm64/effects/memory.js';
import { liftArm64AtomicEffects } from '../../../js/targets/architecture/arm64/effects/atomic.js';

function rvControl(op, fields = {}) {
  return {
    contractVersion:'riscv64-decoded-instruction/v1', instructionId:`rv-${op}`, origin:{instructionIds:[`rv-${op}`]},
    mode:'rv64imc', address:0x1000n, size:4,
    fields:{ supported:true, op, compressed:false, rd:'x0', rs1:'x10', rs2:'x11', imm:4, ...fields },
  };
}

test('#907 IALIGN=16 does not invent instruction-address-misaligned faults', () => {
  const branchPcPlus2 = liftRiscv64ControlEffects(rvControl('beq', { imm:2 }), { instructionAlignment:2 });
  assert.deepEqual(branchPcPlus2.possibleFaults, []);
  const jalPcPlus2 = liftRiscv64ControlEffects(rvControl('jal', { imm:2 }), { instructionAlignment:2 });
  assert.deepEqual(jalPcPlus2.possibleFaults, []);
  const jalrOddPreMask = liftRiscv64ControlEffects(rvControl('jalr', { imm:1 }), { instructionAlignment:2 });
  assert.deepEqual(jalrOddPreMask.possibleFaults, []);
  const ordinaryAligned = liftRiscv64ControlEffects(rvControl('beq', { imm:4 }), { instructionAlignment:2 });
  assert.deepEqual(ordinaryAligned.possibleFaults, []);
});

test('#907 future IALIGN=32 profile retains an explicit 4-byte target-alignment fault', () => {
  const branch = liftRiscv64ControlEffects(rvControl('beq', { imm:2 }), { instructionAlignment:4 });
  assert.equal(branch.possibleFaults.length, 1);
  assert.equal(branch.possibleFaults[0].condition.alignmentBytes, 4);
});

function u32le(value) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }
function attributesFor(arch) {
  const encoder = new TextEncoder();
  const archBytes = [...encoder.encode(arch), 0];
  const attributes = [5, ...archBytes];
  const fileSubsection = [1, ...u32le(1 + 4 + attributes.length), ...attributes];
  const vendor = [...encoder.encode('riscv'), 0];
  const vendorSubsection = [...u32le(4 + vendor.length + fileSubsection.length), ...vendor, ...fileSubsection];
  return Uint8Array.from([0x41, ...vendorSubsection]);
}

test('#909 Tag_RISCV_arch drives compressed-instruction capability', () => {
  const noC = parseRiscvAttributes(attributesFor('rv64i2p1_m2p0_a2p1'));
  assert.equal(noC.compressedInstructions, false);
  assert.equal(noC.instructionAlignment, 4);
  const withC = parseRiscvAttributes(attributesFor('rv64i2p1_m2p0_a2p1_c2p0'));
  assert.equal(withC.compressedInstructions, true);
  assert.equal(withC.instructionAlignment, 2);
});

test('#909 mapping-symbol ISA overrides file ISA by address and $d blocks code decode', () => {
  const file = { ...parseRiscvAttributes(attributesFor('rv64i2p1_m2p0')), evidence:'elf-attribute' };
  const mapped = parseRiscvMappingSymbol('$xrv64i2p1_c2p0.7');
  const metadata = { file, mappings:[
    { address:0x1000n, kind:'instruction', isa:null },
    { address:0x1100n, ...mapped },
    { address:0x1200n, kind:'data', isa:null },
  ] };
  assert.equal(resolveRiscvIsaProfile(metadata, 0x1004n).compressedInstructions, false);
  assert.equal(resolveRiscvIsaProfile(metadata, 0x1104n).compressedInstructions, true);
  assert.equal(resolveRiscvIsaProfile(metadata, 0x1204n).code, false);
});

function arm64Load(mnemonic = 'ldr') {
  return { instructionId:`a64-${mnemonic}`, mnemonic, ops:[
    { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
    { k:'mem', base:{ k:'reg', cls:'gp', num:1, bits:64, text:'x1' }, mode:'offset', disp:0 },
  ] };
}

test('#910 ARM64 scalar and atomic MemoryAccess consume dataEndianness', () => {
  const scalar = liftArm64MemoryEffects(arm64Load('ldr'), { dataEndianness:'big' });
  const scalarRead = scalar.operations.find((operation) => operation.kind === 'memory-read');
  assert.equal(scalarRead.access.endian, 'big');

  const atomic = liftArm64AtomicEffects(arm64Load('ldxr'), { dataEndianness:'big' });
  const atomicRead = atomic.operations.find((operation) => operation.kind === 'memory-read');
  assert.equal(atomicRead.access.endian, 'big');
});

test('#913 ABI adapter exposes architecture-correct function registers', () => {
  const riscv = semanticAbiAdapter(resolveABIPlugin({ architecture:'riscv64', platform:'linux', abiId:'lp64' }));
  assert.equal(riscv.returnRegister({ returnType:'int' }), 'x10');
  assert.deepEqual(riscv.argumentRegisters().slice(0, 8), ['x10','x11','x12','x13','x14','x15','x16','x17']);

  const sysv = semanticAbiAdapter(resolveABIPlugin({ architecture:'x86_64', platform:'linux', abiId:'sysv-amd64' }));
  assert.equal(sysv.returnRegister({ returnType:'int' }), 'rax');
  assert.deepEqual(sysv.argumentRegisters().slice(0, 6), ['rdi','rsi','rdx','rcx','r8','r9']);
});

test('#913 ABI return locations cover FP, void, Microsoft x64, and unknown fail-closed', () => {
  const aapcs = semanticAbiAdapter(AAPCS64_ABI);
  assert.equal(aapcs.returnRegister({ returnType:'double' }), 'v0');
  assert.equal(aapcs.returnRegister({ returnType:'void' }), null);

  const riscvD = semanticAbiAdapter(RISCV_LP64D_ABI);
  assert.equal(riscvD.returnRegister({ returnType:'double' }), 'f10');

  const microsoft = semanticAbiAdapter(MICROSOFT_X64_ABI);
  assert.equal(microsoft.returnRegister({ returnType:'long long' }), 'rax');
  assert.deepEqual(microsoft.argumentLocations({
    functionPrototype:{ parameters:[{type:'int64'}, {type:'int64'}] },
  }).map(({index,reg}) => ({index,reg})), [
    { index:0, reg:'rcx' },
    { index:1, reg:'rdx' },
  ]);

  const unknown = semanticAbiAdapter(UNKNOWN_ABI);
  assert.equal(unknown.returnRegister({ returnType:'int64' }), null);
  assert.deepEqual(unknown.argumentLocations(), []);
});

test('#913 ABI argument locations preserve cross-class parameter indexes', () => {
  const aapcs = semanticAbiAdapter(AAPCS64_ABI);
  assert.deepEqual(aapcs.argumentLocations({
    functionPrototype:{ parameters:[{type:'int64'}, {type:'double'}] },
  }).map(({index,reg}) => ({index,reg})), [
    { index:0, reg:'x0' },
    { index:1, reg:'v0' },
  ]);

  const riscvD = semanticAbiAdapter(RISCV_LP64D_ABI);
  assert.deepEqual(riscvD.argumentLocations({
    functionPrototype:{ parameters:[{type:'int64'}, {type:'double'}] },
  }).map(({index,reg}) => ({index,reg})), [
    { index:0, reg:'x10' },
    { index:1, reg:'f10' },
  ]);
});

test('#913 shared decompiler no longer embeds AAPCS64 return/argument register literals', async () => {
  const source = await readFile(new URL('../../../js/decompiler/pipeline-core.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\^x\(\[0-7\]\)\$/);
  assert.doesNotMatch(source, /\? 'v0' : 'x0'/);
  assert.match(source, /abiAdapter\?\.returnRegister/);
  assert.match(source, /abiAdapter\?\.argumentLocations/);
  assert.doesNotMatch(source, /\^x\[0-7\]\$/);
});


test('#909 structured decoder and MachineEffects preserve resolved ISA identity fields', async () => {
  const decoderSource = await readFile(new URL('../../../js/targets/architecture/riscv64/capstone-structured.js', import.meta.url), 'utf8');
  const decodedSource = await readFile(new URL('../../../js/targets/architecture/riscv64/decoded-instruction.js', import.meta.url), 'utf8');
  const effectsSource = await readFile(new URL('../../../js/targets/architecture/riscv64/effects/common.js', import.meta.url), 'utf8');
  assert.match(decoderSource, /isaIdentity/);
  assert.match(decoderSource, /instructionAlignment/);
  assert.match(decodedSource, /isaEvidence/);
  assert.match(effectsSource, /isaIdentity/);
  assert.match(effectsSource, /instructionAlignment/);
});


test('#909 mapping-symbol state never leaks across executable ELF sections', () => {
  const file = { ...parseRiscvAttributes(attributesFor('rv64i2p1_m2p0')), evidence:'elf-attribute' };
  const mapped = parseRiscvMappingSymbol('$xrv64i2p1_c2p0');
  const metadata = {
    file,
    sections:[
      { sectionIndex:1, start:0x1000n, end:0x1100n },
      { sectionIndex:2, start:0x2000n, end:0x2100n },
    ],
    mappings:[{ address:0x1000n, sectionIndex:1, ...mapped }],
  };
  assert.equal(resolveRiscvIsaProfile(metadata, 0x1004n).compressedInstructions, true);
  assert.equal(resolveRiscvIsaProfile(metadata, 0x2004n).compressedInstructions, false,
    'section 2 must fall back to the file ISA rather than inheriting section 1 mapping state');
});


test('#909 C-disabled decoded contract rejects 16-bit compressed bytes', () => {
  assert.throws(() => createRiscv64DecodedInstruction({
    address:0x1000n, size:2, rawBytes:Uint8Array.from([0x01,0x00]), mode:'rv64im',
  }), /compressed-disabled/);
  const compressed = createRiscv64DecodedInstruction({
    address:0x1000n, size:2, rawBytes:Uint8Array.from([0x01,0x00]), mode:'rv64imc',
    isaIdentity:'rv64i2p1_m2p0_c2p0', isaEvidence:'elf-attribute', instructionAlignment:2, compressedInstructions:true,
  });
  assert.equal(compressed.size, 2);
  assert.equal(compressed.mode, 'rv64imc');
  assert.equal(compressed.instructionAlignment, 2);
  assert.equal(compressed.isaEvidence, 'elf-attribute');
  assert.equal(compressed.fields.supported, true);
  assert.equal(compressed.fields.compressed, true);
  assert.equal(compressed.compressed, true);
});

test('#909 C-disabled profile accepts a legal 32-bit ADDI control instruction', () => {
  const addi = createRiscv64DecodedInstruction({
    address:0x1000n, size:4, rawBytes:Uint8Array.from([0x13,0x05,0x15,0x00]), mode:'rv64im',
    isaIdentity:'rv64i2p1_m2p0', isaEvidence:'elf-attribute', instructionAlignment:4, compressedInstructions:false,
  });
  assert.equal(addi.mode, 'rv64im');
  assert.equal(addi.size, 4);
  assert.equal(addi.fields.supported, true);
  assert.equal(addi.fields.op, 'addi');
  assert.equal(addi.instructionAlignment, 4);
});


function arm64MemoryInstruction(mnemonic, ops) {
  return { instructionId:`a64-${mnemonic}-acceptance`, mnemonic, ops };
}
function gp(num, bits = 64) { return { k:'reg', cls:'gp', num, bits, text:bits === 32 ? `w${num}` : `x${num}` }; }
function vec(num, bits = 128) { return { k:'reg', cls:'vec', num, bits, text:bits === 128 ? `q${num}` : `d${num}` }; }
function mem(base = 3, disp = 0) { return { k:'mem', base:{ k:'reg', cls:'gp', num:base, bits:64, text:`x${base}` }, mode:'offset', disp }; }
function memoryAccess(bundle, kind) { return bundle.operations.find((operation) => operation.kind === kind)?.access ?? null; }

test('#910 ARM64 endian truth covers store, pair, and SIMD/FP memory transfers', () => {
  for (const dataEndianness of ['little','big']) {
    const store = liftArm64MemoryEffects(arm64MemoryInstruction('str', [gp(0), mem()]), { dataEndianness });
    assert.equal(memoryAccess(store, 'memory-write')?.endian, dataEndianness);

    const pairLoad = liftArm64MemoryEffects(arm64MemoryInstruction('ldp', [gp(0), gp(1), mem()]), { dataEndianness });
    const pairReads = pairLoad.operations.filter((operation) => operation.kind === 'memory-read');
    assert.equal(pairReads.length, 2);
    assert.ok(pairReads.every((operation) => operation.access.endian === dataEndianness));

    const pairStore = liftArm64MemoryEffects(arm64MemoryInstruction('stp', [gp(0), gp(1), mem()]), { dataEndianness });
    const pairWrites = pairStore.operations.filter((operation) => operation.kind === 'memory-write');
    assert.equal(pairWrites.length, 2);
    assert.ok(pairWrites.every((operation) => operation.access.endian === dataEndianness));

    const vectorLoad = liftArm64MemoryEffects(arm64MemoryInstruction('ldr', [vec(0), mem()]), { dataEndianness });
    assert.equal(memoryAccess(vectorLoad, 'memory-read')?.endian, dataEndianness);
  }
});

test('#910 backend keeps instruction and data endianness as distinct semantic/cache fields', async () => {
  const backend = await readFile(new URL('../../../js/backend.js', import.meta.url), 'utf8');
  assert.match(backend, /dataEndianness/);
  assert.match(backend, /instructionEndianness/);
  assert.match(backend, /architecture === 'arm64' \? 'little' : dataEndianness/);
  assert.match(backend, /machineEffectsContext:{/);
});


test('#909 rv64gc/G+C abbreviation preserves compressed capability', () => {
  const gc = parseRiscvAttributes(attributesFor('rv64gc'));
  assert.equal(gc.compressedInstructions, true);
  assert.equal(gc.instructionAlignment, 2);

  const gcv = parseRiscvMappingSymbol('$xrv64gcv');
  assert.equal(gcv.isa.compressedInstructions, true);
  assert.equal(gcv.isa.instructionAlignment, 2);
});


function rvDecoded(address, bytes, instructionId) {
  return createRiscv64DecodedInstruction({
    address, size:bytes.length, rawBytes:Uint8Array.from(bytes), mode:'rv64imc', instructionId,
    origin:{ instructionIds:[instructionId] },
  });
}

function x86Decoded({ address, bytes, instructionId, family, operands = [] }) {
  return createX86DecodedInstruction({
    address, length:bytes.length, rawBytes:Uint8Array.from(bytes), mode:'long-64',
    instructionId, instructionCode:family === 'ret' ? 2 : 1, instructionFamily:family,
    detailAvailable:true, detailStatus:'complete',
    detail:{ operandCount:operands.length, operands }, mnemonic:family,
  });
}

test('#913 Semantic IR -> compat -> shared Decompiler honors RISC-V and SysV ABI registers', () => {
  const riscv = analyzeDecodedSemanticFunction({
    architecture:'riscv64', platform:'linux', abiId:'lp64', mode:'rv64imc',
    decoderSemanticVersion:'acceptance-riscv-v1', binaryId:'acceptance-riscv', sliceId:'0',
    functionPrototype:{ returnType:'int64', parameters:[{ type:'int64' }] },
    instructions:[
      // addi a0, a0, 1
      rvDecoded(0x1000n, [0x13,0x05,0x15,0x00], 'rv-addi-a0'),
      // jalr x0, x1, 0 (ret)
      rvDecoded(0x1004n, [0x67,0x80,0x00,0x00], 'rv-ret'),
    ],
  });
  assert.equal(riscv.decompiler.semantic, true);
  assert.match(riscv.decompiler.pseudocode, /return/);
  assert.doesNotMatch(riscv.decompiler.pseudocode, /\bx0\b/, 'RISC-V must never inherit AAPCS64 x0 return/argument spelling');

  const sysv = analyzeDecodedSemanticFunction({
    architecture:'x86_64', platform:'linux', abiId:'sysv-amd64', mode:'long-64',
    decoderSemanticVersion:'acceptance-x86-v1', binaryId:'acceptance-x86', sliceId:'0',
    functionPrototype:{ returnType:'int64', parameters:[{ type:'int64' }] },
    instructions:[
      // mov rax, rdi
      x86Decoded({ address:0x2000n, bytes:[0x48,0x89,0xf8], instructionId:'x86-mov-ret', family:'mov', operands:[
        { type:'register', register:'rax', access:'write' },
        { type:'register', register:'rdi', access:'read' },
      ] }),
      x86Decoded({ address:0x2003n, bytes:[0xc3], instructionId:'x86-ret', family:'ret' }),
    ],
  });
  assert.equal(sysv.decompiler.semantic, true);
  assert.match(sysv.decompiler.pseudocode, /return/);
  assert.doesNotMatch(sysv.decompiler.pseudocode, /\bx0\b|\bv0\b/, 'x86 must never inherit AAPCS64 register spelling');
});
