(function installHexRiscv64CapstoneStructured(root) {
  'use strict';

  /**
   * Deployed-Capstone binding for RISC-V64.
   *
   * Capstone is the canonical decode provider: it owns instruction boundaries
   * and lengths, which matters because the "C" standard extension makes the
   * stream variable-width. Its RISC-V printer, however, normalises encodings to
   * assembler pseudo-instructions and drops architectural fields (`jal ra, off`
   * and `jal zero, off` both print with one operand). So this bridge exports the
   * decoder-proven boundary, the raw instruction bytes, and Capstone's own
   * structured operands, and the exact architectural fields are recovered from
   * the raw word by js/targets/architecture/riscv64/instruction-word.js.
   *
   * The Capstone operands are retained precisely so that
   * tests/phase6/decoder/** can cross-check the two independent decodings.
   */
  const ABI = Object.freeze({
    contractVersion: 'capstone-5-wasm32-riscv64-detail/v1',
    capstoneMajor: 5,
    capstoneMinor: 0,
    instructionSize: 240,
    instructionBytes: 18,
    mnemonic: 42,
    opStr: 74,
    size: 16,
    instructionDetailPointer: 236,
    // cs_detail's architecture union starts here on this wasm32 build; the same
    // offset is used by the proven x86 bridge and is asserted by the tests.
    riscvDetail: 96,
    operandCount: 1,
    operands: 8,
    operandStride: 24,
  });

  const OPERAND_INVALID = 0;
  const OPERAND_REG = 1;
  const OPERAND_IMM = 2;
  const OPERAND_MEM = 3;

  function u8(M, pointer) { return M.getValue(pointer, 'i8') & 0xff; }
  function u16(M, pointer) { return M.getValue(pointer, 'i16') & 0xffff; }
  function u32(M, pointer) { return M.getValue(pointer, 'i32') >>> 0; }
  function i64(M, pointer) { return BigInt(M.getValue(pointer, 'i64')); }

  function registerName(M, handle, id) {
    if (!id) return null;
    try {
      const value = M.ccall('cs_reg_name', 'string', ['number', 'number'], [handle, id]);
      return value ? String(value).toLowerCase() : null;
    } catch { return null; }
  }

  function verifyVersion(M) {
    const major = M._malloc(4);
    const minor = M._malloc(4);
    try {
      M.ccall('cs_version', 'number', ['pointer', 'pointer'], [major, minor]);
      const actualMajor = M.getValue(major, 'i32');
      const actualMinor = M.getValue(minor, 'i32');
      if (actualMajor !== ABI.capstoneMajor || actualMinor !== ABI.capstoneMinor) {
        throw new Error(`riscv64-capstone-detail-abi-version-mismatch:${actualMajor}.${actualMinor}`);
      }
      return Object.freeze({ major: actualMajor, minor: actualMinor });
    } finally {
      M._free(major);
      M._free(minor);
    }
  }

  function capstoneOperands(M, handle, instructionPointer) {
    const detailPointer = u32(M, instructionPointer + ABI.instructionDetailPointer);
    if (!detailPointer) return null;
    const riscv = detailPointer + ABI.riscvDetail;
    const count = Math.min(8, u8(M, riscv + ABI.operandCount));
    const operands = [];
    for (let index = 0; index < count; index += 1) {
      const pointer = riscv + ABI.operands + index * ABI.operandStride;
      const type = u32(M, pointer);
      if (type === OPERAND_REG) {
        operands.push(Object.freeze({ index, type: 'register', registerId: registerName(M, handle, u32(M, pointer + 8)) }));
      } else if (type === OPERAND_IMM) {
        operands.push(Object.freeze({ index, type: 'immediate', value: i64(M, pointer + 8) }));
      } else if (type === OPERAND_MEM) {
        operands.push(Object.freeze({
          index,
          type: 'memory',
          base: registerName(M, handle, u32(M, pointer + 8)),
          displacement: i64(M, pointer + 16),
        }));
      } else if (type !== OPERAND_INVALID) {
        operands.push(Object.freeze({ index, type: 'unknown', typeCode: type }));
      }
    }
    return Object.freeze(operands);
  }

  function parseInstruction(M, handle, instructionPointer, options = {}) {
    const size = u16(M, instructionPointer + ABI.size);
    if (size !== 2 && size !== 4) throw new Error(`riscv64-decoder-invalid-instruction-length:${size}`);
    const address = i64(M, instructionPointer + 8);
    const expected = BigInt(options.address);
    if (address !== expected) throw new Error(`riscv64-decoder-address-mismatch:${address}:${expected}`);
    const rawBytes = Uint8Array.from({ length: size }, (_unused, index) => u8(M, instructionPointer + ABI.instructionBytes + index));
    return Object.freeze({
      address,
      size,
      length: size,
      rawBytes,
      mnemonic: M.UTF8ToString(instructionPointer + ABI.mnemonic),
      opStr: M.UTF8ToString(instructionPointer + ABI.opStr),
      architecture: 'riscv64',
      mode: String(options.mode || 'rv64imc'),
      ...(options.isaIdentity == null ? {} : { isaIdentity:String(options.isaIdentity) }),
      ...(options.isaEvidence == null ? {} : { isaEvidence:String(options.isaEvidence) }),
      ...(options.instructionAlignment == null ? {} : { instructionAlignment:Number(options.instructionAlignment) }),
      ...(options.compressedInstructions == null ? {} : { compressedInstructions:options.compressedInstructions === true }),
      decoderSemanticVersion: 'capstone-5-riscv64-word-exact-v1',
      capstoneInstructionId: u32(M, instructionPointer),
      capstoneOperands: capstoneOperands(M, handle, instructionPointer),
      abiContractVersion: ABI.contractVersion,
    });
  }

  root.HexRiscv64CapstoneStructured = Object.freeze({ ABI, verifyVersion, parseInstruction });
})(globalThis);
