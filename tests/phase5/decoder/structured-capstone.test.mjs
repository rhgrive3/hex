import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import '../../../js/targets/architecture/x86_64/capstone-structured.js';
import {
  X86_DECODED_INSTRUCTION_CONTRACT_VERSION,
  X86_DECODER_SEMANTIC_VERSION,
  createX86DecodedInstruction,
  x86DecodedInstructionIsStructured,
} from '../../../js/targets/architecture/x86_64/decoded-instruction.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const capstoneModulePath = path.join(os.tmpdir(), `hex-p5-capstone-${process.pid}-${Date.now()}.cjs`);
const structured = globalThis.HexX86CapstoneStructured;
assert.ok(structured, 'structured x86 Capstone bridge must install its public API');

fs.copyFileSync(path.join(root, 'capstone.js'), capstoneModulePath);

let M;
let handlePointer;
let handle;
let outputPointer;

async function withDecoded(bytes, address, callback, { detail = true } = {}) {
  const input = Uint8Array.from(bytes);
  const buffer = M._malloc(Math.max(1, input.length));
  if (input.length) M.writeArrayToMemory(input, buffer);
  const detailResult = M.ccall(
    'cs_option', 'number', ['number','number','number'],
    [handle, M.OPT_DETAIL, detail ? M.OPT_ON : M.OPT_OFF],
  );
  assert.equal(detailResult, 0, 'Capstone detail mode must be configurable');
  const count = M.ccall(
    'cs_disasm', 'number',
    ['number','number','number','number','number','number'],
    [handle, buffer, input.length, BigInt(address), 1, outputPointer],
  );
  assert.equal(count, 1, `fixture must decode exactly one instruction: ${input.toHex?.() || [...input]}`);
  const instructionPointer = M.getValue(outputPointer, 'i32');
  try {
    return await callback(instructionPointer, input);
  } finally {
    if (instructionPointer) M.ccall('cs_free', 'void', ['number','number'], [instructionPointer, count]);
    M._free(buffer);
  }
}

async function decode(bytes, address = 0x401000n, options = {}) {
  return withDecoded(bytes, address, (instructionPointer) => (
    structured.parseInstruction(M, handle, instructionPointer, { address, mode:'long-64' })
  ), options);
}

try {
  const require = createRequire(import.meta.url);
  const MCapstone = require(capstoneModulePath);
  M = await MCapstone({
    locateFile: (name) => path.join(root, name),
    print: () => {},
    printErr: () => {},
  });

  assert.deepEqual(structured.verifyVersion(M), { major:5, minor:0 });
  assert.equal(structured.ABI.contractVersion, 'capstone-5-wasm32-x86-detail/v1');
  assert.equal(structured.ABI.instructionSize, 240);
  assert.equal(structured.ABI.instructionDetailPointer, 236);
  assert.equal(structured.ABI.operandStride, 48);

  handlePointer = M._malloc(4);
  outputPointer = M._malloc(4);
  const openResult = M.ccall(
    'cs_open', 'number', ['number','number','pointer'],
    [M.ARCH_X86, M.MODE_64 | M.MODE_LITTLE_ENDIAN, handlePointer],
  );
  assert.equal(openResult, 0, 'bundled Capstone must open x86-64 mode');
  handle = M.getValue(handlePointer, 'i32');

  // REX + SIB + signed displacement proves structured register, memory,
  // width, access, prefix, and encoding-offset fidelity without using opStr.
  const memoryMove = await decode([0x48,0x8b,0x44,0x8b,0xf0]);
  assert.equal(memoryMove.mnemonic, 'mov');
  assert.equal(memoryMove.opStr, 'rax, qword ptr [rbx + rcx*4 - 0x10]');
  assert.equal(memoryMove.address, 0x401000n);
  assert.equal(memoryMove.size, 5);
  assert.equal(memoryMove.length, 5);
  assert.deepEqual([...memoryMove.rawBytes], [0x48,0x8b,0x44,0x8b,0xf0]);
  assert.equal(memoryMove.rawBytes.byteLength, memoryMove.size);
  assert.equal(memoryMove.rawBytes.buffer.byteLength, memoryMove.size,
    'each decoded instruction must retain only its exact bytes');
  assert.equal(memoryMove.detailAvailable, true);
  assert.equal(memoryMove.detailStatus, 'complete');
  assert.equal(memoryMove.decoderContractVersion, X86_DECODED_INSTRUCTION_CONTRACT_VERSION);
  assert.equal(memoryMove.decoderSemanticVersion, X86_DECODER_SEMANTIC_VERSION);
  assert.equal(memoryMove.detail.operandCount, 2);
  assert.deepEqual(
    memoryMove.detail.operands.map((operand) => ({ type:operand.type, widthBits:operand.widthBits, access:operand.access })),
    [
      { type:'register', widthBits:64, access:'write' },
      { type:'memory', widthBits:64, access:'read' },
    ],
  );
  assert.equal(memoryMove.detail.operands[0].registerId, 'rax');
  assert.deepEqual(
    {
      segment:memoryMove.detail.operands[1].memory.segment,
      base:memoryMove.detail.operands[1].memory.base,
      index:memoryMove.detail.operands[1].memory.index,
      scale:memoryMove.detail.operands[1].memory.scale,
      displacement:memoryMove.detail.operands[1].memory.displacement,
    },
    { segment:null, base:'rbx', index:'rcx', scale:4, displacement:-16n },
  );
  assert.deepEqual([...memoryMove.detail.prefixes.legacy], []);
  assert.equal(memoryMove.detail.prefixes.rex, 0x48);
  assert.equal(memoryMove.detail.prefixes.vector, null);
  assert.equal(memoryMove.detail.addressSizeBits, 64);
  assert.equal(memoryMove.detail.modrm, 0x44);
  assert.equal(memoryMove.detail.sib, 0x8b);
  assert.equal(memoryMove.detail.displacement, -16n);
  assert.equal(memoryMove.detail.sibBase, 'rbx');
  assert.equal(memoryMove.detail.sibIndex, 'rcx');
  assert.equal(memoryMove.detail.sibScale, 4);
  assert.deepEqual(memoryMove.detail.encodingOffsets, {
    modrmOffset:2,
    displacementOffset:4,
    displacementSize:1,
    immediateOffset:0,
    immediateSize:0,
  });

  // The immediate value and its encoded width remain structural facts.
  const immediateMove = await decode([0x48,0xc7,0xc0,0x78,0x56,0x34,0x12], 0x402000n);
  const immediate = immediateMove.detail.operands.find((operand) => operand.type === 'immediate');
  assert.ok(immediate, 'MOV immediate must expose a structured immediate operand');
  assert.equal(immediate.value, 0x12345678n);
  assert.equal(immediate.widthBits, 64);
  assert.equal(immediate.access, 'unknown', 'missing decoder access metadata must stay unknown');
  assert.equal(immediateMove.detail.encodingOffsets.immediateOffset, 3);
  assert.equal(immediateMove.detail.encodingOffsets.immediateSize, 4);

  // LOCK and read-modify-write access must not degrade into presentation text.
  const locked = await decode([0xf0,0x48,0x0f,0xc1,0x08], 0x403000n);
  assert.deepEqual([...locked.detail.prefixes.legacy], [0xf0]);
  assert.equal(locked.detail.prefixes.rex, 0x48);
  assert.deepEqual(locked.detail.operands.map((operand) => operand.access), ['read-write','read-write']);
  assert.equal(locked.detail.operands[0].type, 'memory');
  assert.equal(locked.detail.operands[0].memory.base, 'rax');

  // VEX state is bounded and explicitly reports unverified bit-field decoding.
  const vex = await decode([0xc5,0xf8,0x57,0xc0], 0x404000n);
  assert.equal(vex.detail.prefixes.vector.kind, 'vex2');
  assert.deepEqual([...vex.detail.prefixes.vector.bytes], [0xc5,0xf8]);
  assert.equal(vex.detail.prefixes.vector.offset, 0);
  assert.equal(vex.detail.prefixes.vector.fieldsVerified, false);
  assert.deepEqual(vex.detail.unavailableFacts, ['decoded-vex-evex-bitfields']);

  // Capstone implicit state is required for stack and control semantics.
  const push = await decode([0x50], 0x405000n);
  assert.ok(push.detail.implicitReads.includes('rsp'), 'PUSH must expose implicit RSP read');
  assert.ok(push.detail.implicitWrites.includes('rsp'), 'PUSH must expose implicit RSP write');

  // Normalize the actual bridge output into the frozen semantic boundary.
  const normalized = createX86DecodedInstruction(memoryMove);
  assert.equal(normalized.contractVersion, X86_DECODED_INSTRUCTION_CONTRACT_VERSION);
  assert.equal(normalized.decoderContractVersion, X86_DECODED_INSTRUCTION_CONTRACT_VERSION);
  assert.equal(normalized.decoderSemanticVersion, X86_DECODER_SEMANTIC_VERSION);
  assert.equal(normalized.detail.operands[0].register.physicalId, 'rax');
  assert.equal(normalized.detail.operands[1].memory.base.physicalId, 'rbx');
  assert.equal(normalized.detail.operands[1].memory.index.physicalId, 'rcx');
  assert.equal(normalized.rawBytes.buffer.byteLength, normalized.length);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.detail), true);
  assert.equal(x86DecodedInstructionIsStructured(memoryMove), true);

  // A view into a larger caller buffer must be copied into an exact-sized buffer.
  const largeBacking = new Uint8Array(64);
  largeBacking.set(memoryMove.rawBytes, 17);
  const bounded = createX86DecodedInstruction({
    ...memoryMove,
    rawBytes:new Uint8Array(largeBacking.buffer, 17, memoryMove.size),
  });
  assert.equal(bounded.rawBytes.buffer.byteLength, memoryMove.size);
  largeBacking[17] ^= 0xff;
  assert.deepEqual([...bounded.rawBytes], [0x48,0x8b,0x44,0x8b,0xf0]);

  // Contract, address, byte length, and instruction length all fail closed.
  assert.throws(
    () => createX86DecodedInstruction({ ...memoryMove, contractVersion:'x86-64-decoded-instruction/v2' }),
    /x86-decoded-instruction-contract-version-mismatch/,
  );
  assert.throws(
    () => createX86DecodedInstruction({ ...memoryMove, rawBytes:memoryMove.rawBytes.slice(0, 4) }),
    /x86-decoded-instruction-byte-length-mismatch/,
  );
  await withDecoded([0x90], 0x406000n, (instructionPointer) => {
    assert.throws(
      () => structured.parseInstruction(M, handle, instructionPointer, { address:0x406001n, mode:'long-64' }),
      /x86-decoder-address-mismatch/,
    );
    const originalSize = M.getValue(instructionPointer + 16, 'i16');
    try {
      M.setValue(instructionPointer + 16, 0, 'i16');
      assert.throws(
        () => structured.parseInstruction(M, handle, instructionPointer, { address:0x406000n, mode:'long-64' }),
        /x86-decoder-invalid-instruction-length:0/,
      );
      M.setValue(instructionPointer + 16, 16, 'i16');
      assert.throws(
        () => structured.parseInstruction(M, handle, instructionPointer, { address:0x406000n, mode:'long-64' }),
        /x86-decoder-invalid-instruction-length:16/,
      );
    } finally {
      M.setValue(instructionPointer + 16, originalSize, 'i16');
    }
  });

  const wrongVersion = Object.create(M);
  wrongVersion.ccall = (name, returnType, argumentTypes, args) => {
    if (name !== 'cs_version') return M.ccall(name, returnType, argumentTypes, args);
    M.setValue(args[0], 6, 'i32');
    M.setValue(args[1], 0, 'i32');
    return 0x600;
  };
  assert.throws(() => structured.verifyVersion(wrongVersion), /x86-capstone-detail-abi-version-mismatch:6\.0/);

  console.log('phase5 structured x86 Capstone decoder contract passed');
} finally {
  if (M && handlePointer) {
    try { M.ccall('cs_close', 'number', ['pointer'], [handlePointer]); } catch {}
  }
  if (M && outputPointer) M._free(outputPointer);
  if (M && handlePointer) M._free(handlePointer);
  fs.rmSync(capstoneModulePath, { force:true });
}
