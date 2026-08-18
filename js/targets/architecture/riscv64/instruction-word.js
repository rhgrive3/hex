/**
 * Exact RV64 instruction-word decoder.
 *
 * Why this exists: the deployed Capstone RISC-V printer normalises encodings to
 * assembler pseudo-instructions and, in doing so, drops architectural fields.
 * `jal ra, off` and `jal zero, off` both print with a single immediate operand,
 * `xori rd, rs1, -1` prints as `not rd, rs1`, and `addi rd, x0, imm` prints as
 * `li`. Recovering semantics from those strings would be exactly the
 * display-text reparsing the Master Architecture forbids.
 *
 * So the semantic front end decodes the instruction word itself, straight from
 * the decoder-provided raw bytes, following the official RISC-V Unprivileged
 * ISA encoding tables (RV32I/RV64I base, "M" standard extension, and the "C"
 * standard extension quadrants 0-2). Capstone remains the canonical decode
 * provider for instruction boundaries and identity; tests/phase6/decoder/**
 * additionally uses Capstone's own structured operands as an independent
 * cross-check that this field extraction agrees with a second implementation.
 *
 * Anything outside the frozen Phase 6 ISA profile (F/D/A/V/Zicsr/privileged)
 * decodes to an explicit `unsupported` record. It never silently becomes a nop.
 */

export const RISCV64_INSTRUCTION_WORD_CONTRACT_VERSION = 'riscv64-instruction-word/v1';

const X = (index) => `x${index}`;

function bits(word, high, low) {
  return (word >>> low) & ((1 << (high - low + 1)) - 1);
}
function signExtend(value, width) {
  const big = BigInt(value) & ((1n << BigInt(width)) - 1n);
  const sign = 1n << BigInt(width - 1);
  return (big ^ sign) - sign;
}

/** RISC-V instruction length is encoded in the low bits (ISA "Expanded Instruction-Length Encoding"). */
export function riscvInstructionLength(firstTwoBytes) {
  const low = Number(firstTwoBytes) & 0xffff;
  if ((low & 0b11) !== 0b11) return 2;
  if ((low & 0b11111) !== 0b11111) return 4;
  if ((low & 0b111111) === 0b011111) return 6;
  if ((low & 0b1111111) === 0b0111111) return 8;
  return null; // >= 80-bit encodings are not part of any ratified profile
}

function unsupported(reason, detail = {}) {
  return Object.freeze({ supported: false, reason, ...detail });
}

// --------------------------------------------------------------------------
// 32-bit (uncompressed) encodings
// --------------------------------------------------------------------------

const OPIMM_FUNCT3 = Object.freeze({ 0: 'addi', 2: 'slti', 3: 'sltiu', 4: 'xori', 6: 'ori', 7: 'andi' });
const OP_BASE = Object.freeze({ 0: 'add', 1: 'sll', 2: 'slt', 3: 'sltu', 4: 'xor', 5: 'srl', 6: 'or', 7: 'and' });
const OP_M = Object.freeze({ 0: 'mul', 1: 'mulh', 2: 'mulhsu', 3: 'mulhu', 4: 'div', 5: 'divu', 6: 'rem', 7: 'remu' });
const OP32_M = Object.freeze({ 0: 'mulw', 4: 'divw', 5: 'divuw', 6: 'remw', 7: 'remuw' });
const BRANCH_FUNCT3 = Object.freeze({ 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' });
const LOAD_FUNCT3 = Object.freeze({
  0: { op: 'lb', widthBits: 8, signed: true },
  1: { op: 'lh', widthBits: 16, signed: true },
  2: { op: 'lw', widthBits: 32, signed: true },
  3: { op: 'ld', widthBits: 64, signed: true },
  4: { op: 'lbu', widthBits: 8, signed: false },
  5: { op: 'lhu', widthBits: 16, signed: false },
  6: { op: 'lwu', widthBits: 32, signed: false },
});
const STORE_FUNCT3 = Object.freeze({
  0: { op: 'sb', widthBits: 8 },
  1: { op: 'sh', widthBits: 16 },
  2: { op: 'sw', widthBits: 32 },
  3: { op: 'sd', widthBits: 64 },
});

function immediateI(word) { return signExtend(word >>> 20, 12); }
function immediateS(word) { return signExtend((bits(word, 31, 25) << 5) | bits(word, 11, 7), 12); }
function immediateB(word) {
  const value = (bits(word, 31, 31) << 12) | (bits(word, 7, 7) << 11) | (bits(word, 30, 25) << 5) | (bits(word, 11, 8) << 1);
  return signExtend(value, 13);
}
function immediateU(word) {
  // U-type places imm[31:12] in the word and RV64 sign-extends the 32-bit result.
  return signExtend(BigInt(word >>> 12) << 12n, 32);
}
function immediateJ(word) {
  const value = (bits(word, 31, 31) << 20) | (bits(word, 19, 12) << 12) | (bits(word, 20, 20) << 11) | (bits(word, 30, 21) << 1);
  return signExtend(value, 21);
}

function decodeUncompressed(word) {
  const opcode = word & 0x7f;
  const rd = X(bits(word, 11, 7));
  const rs1 = X(bits(word, 19, 15));
  const rs2 = X(bits(word, 24, 20));
  const funct3 = bits(word, 14, 12);
  const funct7 = bits(word, 31, 25);
  const base = { compressed: false, sizeBytes: 4 };

  switch (opcode) {
    case 0x37: return { ...base, op: 'lui', format: 'U', rd, imm: immediateU(word) };
    case 0x17: return { ...base, op: 'auipc', format: 'U', rd, imm: immediateU(word) };
    case 0x6f: return { ...base, op: 'jal', format: 'J', rd, imm: immediateJ(word) };
    case 0x67:
      if (funct3 !== 0) return unsupported('riscv64-reserved-jalr-funct3', { opcode, funct3 });
      return { ...base, op: 'jalr', format: 'I', rd, rs1, imm: immediateI(word) };
    case 0x63: {
      const op = BRANCH_FUNCT3[funct3];
      if (!op) return unsupported('riscv64-reserved-branch-funct3', { opcode, funct3 });
      return { ...base, op, format: 'B', rs1, rs2, imm: immediateB(word) };
    }
    case 0x03: {
      const load = LOAD_FUNCT3[funct3];
      if (!load) return unsupported('riscv64-reserved-load-funct3', { opcode, funct3 });
      return { ...base, op: load.op, format: 'I', kind: 'load', rd, rs1, imm: immediateI(word), memoryWidthBits: load.widthBits, memorySigned: load.signed };
    }
    case 0x23: {
      const store = STORE_FUNCT3[funct3];
      if (!store) return unsupported('riscv64-reserved-store-funct3', { opcode, funct3 });
      return { ...base, op: store.op, format: 'S', kind: 'store', rs1, rs2, imm: immediateS(word), memoryWidthBits: store.widthBits };
    }
    case 0x13: {
      if (funct3 === 1) {
        if (bits(word, 31, 26) !== 0) return unsupported('riscv64-reserved-slli-encoding', { opcode, funct7 });
        return { ...base, op: 'slli', format: 'I', rd, rs1, shamt: bits(word, 25, 20) };
      }
      if (funct3 === 5) {
        const arithmetic = bits(word, 30, 30) === 1;
        if ((bits(word, 31, 26) & 0b101111) !== 0) return unsupported('riscv64-reserved-srli-srai-encoding', { opcode, funct7 });
        return { ...base, op: arithmetic ? 'srai' : 'srli', format: 'I', rd, rs1, shamt: bits(word, 25, 20) };
      }
      const op = OPIMM_FUNCT3[funct3];
      if (!op) return unsupported('riscv64-reserved-op-imm-funct3', { opcode, funct3 });
      return { ...base, op, format: 'I', rd, rs1, imm: immediateI(word) };
    }
    case 0x1b: {
      if (funct3 === 0) return { ...base, op: 'addiw', format: 'I', rd, rs1, imm: immediateI(word), resultBits: 32 };
      if (funct3 === 1) {
        if (funct7 !== 0) return unsupported('riscv64-reserved-slliw-encoding', { opcode, funct7 });
        return { ...base, op: 'slliw', format: 'I', rd, rs1, shamt: bits(word, 24, 20), resultBits: 32 };
      }
      if (funct3 === 5) {
        if (funct7 !== 0 && funct7 !== 0x20) return unsupported('riscv64-reserved-srliw-sraiw-encoding', { opcode, funct7 });
        return { ...base, op: funct7 === 0x20 ? 'sraiw' : 'srliw', format: 'I', rd, rs1, shamt: bits(word, 24, 20), resultBits: 32 };
      }
      return unsupported('riscv64-reserved-op-imm-32-funct3', { opcode, funct3 });
    }
    case 0x33: {
      if (funct7 === 0x01) return { ...base, op: OP_M[funct3], format: 'R', rd, rs1, rs2, extension: 'M' };
      if (funct7 === 0x00) return { ...base, op: OP_BASE[funct3], format: 'R', rd, rs1, rs2 };
      if (funct7 === 0x20 && funct3 === 0) return { ...base, op: 'sub', format: 'R', rd, rs1, rs2 };
      if (funct7 === 0x20 && funct3 === 5) return { ...base, op: 'sra', format: 'R', rd, rs1, rs2 };
      return unsupported('riscv64-reserved-op-encoding', { opcode, funct3, funct7 });
    }
    case 0x3b: {
      if (funct7 === 0x01) {
        const op = OP32_M[funct3];
        if (!op) return unsupported('riscv64-reserved-op-32-m-funct3', { opcode, funct3 });
        return { ...base, op, format: 'R', rd, rs1, rs2, extension: 'M', resultBits: 32 };
      }
      if (funct7 === 0x00 && funct3 === 0) return { ...base, op: 'addw', format: 'R', rd, rs1, rs2, resultBits: 32 };
      if (funct7 === 0x00 && funct3 === 1) return { ...base, op: 'sllw', format: 'R', rd, rs1, rs2, resultBits: 32 };
      if (funct7 === 0x00 && funct3 === 5) return { ...base, op: 'srlw', format: 'R', rd, rs1, rs2, resultBits: 32 };
      if (funct7 === 0x20 && funct3 === 0) return { ...base, op: 'subw', format: 'R', rd, rs1, rs2, resultBits: 32 };
      if (funct7 === 0x20 && funct3 === 5) return { ...base, op: 'sraw', format: 'R', rd, rs1, rs2, resultBits: 32 };
      return unsupported('riscv64-reserved-op-32-encoding', { opcode, funct3, funct7 });
    }
    case 0x0f: {
      if (funct3 === 0) return { ...base, op: 'fence', format: 'I', predecessor: bits(word, 27, 24), successor: bits(word, 23, 20), fenceMode: bits(word, 31, 28) };
      if (funct3 === 1) return { ...base, op: 'fence.i', format: 'I', extension: 'Zifencei' };
      return unsupported('riscv64-reserved-misc-mem-funct3', { opcode, funct3 });
    }
    case 0x73: {
      if (funct3 !== 0) return unsupported('riscv64-zicsr-outside-phase6-profile', { opcode, funct3 });
      const imm = word >>> 20;
      if (imm === 0 && rd === 'x0' && rs1 === 'x0') return { ...base, op: 'ecall', format: 'I' };
      if (imm === 1 && rd === 'x0' && rs1 === 'x0') return { ...base, op: 'ebreak', format: 'I' };
      return unsupported('riscv64-privileged-system-outside-phase6-profile', { opcode, funct3, imm });
    }
    case 0x2f: return unsupported('riscv64-atomic-extension-outside-phase6-profile', { opcode });
    case 0x07: case 0x27: case 0x43: case 0x47: case 0x4b: case 0x4f: case 0x53:
      return unsupported('riscv64-floating-point-extension-outside-phase6-profile', { opcode });
    default:
      return unsupported('riscv64-unknown-opcode', { opcode });
  }
}

// --------------------------------------------------------------------------
// 16-bit (C standard extension) encodings
// --------------------------------------------------------------------------

const CREG = (value) => X(8 + value);

function decodeQuadrant0(word) {
  const funct3 = bits(word, 15, 13);
  const base = { compressed: true, sizeBytes: 2 };
  const rdPrime = CREG(bits(word, 4, 2));
  const rs1Prime = CREG(bits(word, 9, 7));
  const rs2Prime = CREG(bits(word, 4, 2));
  switch (funct3) {
    case 0: {
      // C.ADDI4SPN: nzuimm[5:4|9:6|2|3]
      const uimm = (bits(word, 10, 7) << 6) | (bits(word, 12, 11) << 4) | (bits(word, 5, 5) << 3) | (bits(word, 6, 6) << 2);
      if (uimm === 0) return unsupported('riscv64-c-addi4spn-reserved-zero-immediate');
      return { ...base, op: 'addi', expandedFrom: 'c.addi4spn', format: 'I', rd: rdPrime, rs1: 'x2', imm: BigInt(uimm) };
    }
    case 2: {
      const offset = (bits(word, 5, 5) << 6) | (bits(word, 12, 10) << 3) | (bits(word, 6, 6) << 2);
      return { ...base, op: 'lw', expandedFrom: 'c.lw', format: 'I', kind: 'load', rd: rdPrime, rs1: rs1Prime, imm: BigInt(offset), memoryWidthBits: 32, memorySigned: true };
    }
    case 3: {
      const offset = (bits(word, 6, 5) << 6) | (bits(word, 12, 10) << 3);
      return { ...base, op: 'ld', expandedFrom: 'c.ld', format: 'I', kind: 'load', rd: rdPrime, rs1: rs1Prime, imm: BigInt(offset), memoryWidthBits: 64, memorySigned: true };
    }
    case 6: {
      const offset = (bits(word, 5, 5) << 6) | (bits(word, 12, 10) << 3) | (bits(word, 6, 6) << 2);
      return { ...base, op: 'sw', expandedFrom: 'c.sw', format: 'S', kind: 'store', rs1: rs1Prime, rs2: rs2Prime, imm: BigInt(offset), memoryWidthBits: 32 };
    }
    case 7: {
      const offset = (bits(word, 6, 5) << 6) | (bits(word, 12, 10) << 3);
      return { ...base, op: 'sd', expandedFrom: 'c.sd', format: 'S', kind: 'store', rs1: rs1Prime, rs2: rs2Prime, imm: BigInt(offset), memoryWidthBits: 64 };
    }
    case 1: case 5: return unsupported('riscv64-floating-point-extension-outside-phase6-profile', { quadrant: 0, funct3 });
    default: return unsupported('riscv64-reserved-c-quadrant0-encoding', { funct3 });
  }
}

function decodeQuadrant1(word) {
  const funct3 = bits(word, 15, 13);
  const base = { compressed: true, sizeBytes: 2 };
  const rd = X(bits(word, 11, 7));
  const rdPrime = CREG(bits(word, 9, 7));
  const imm6 = signExtend((bits(word, 12, 12) << 5) | bits(word, 6, 2), 6);
  switch (funct3) {
    case 0:
      if (bits(word, 11, 7) === 0) return { ...base, op: 'addi', expandedFrom: 'c.nop', format: 'I', rd: 'x0', rs1: 'x0', imm: 0n };
      return { ...base, op: 'addi', expandedFrom: 'c.addi', format: 'I', rd, rs1: rd, imm: imm6 };
    case 1:
      if (bits(word, 11, 7) === 0) return unsupported('riscv64-c-addiw-reserved-zero-rd');
      return { ...base, op: 'addiw', expandedFrom: 'c.addiw', format: 'I', rd, rs1: rd, imm: imm6, resultBits: 32 };
    case 2:
      return { ...base, op: 'addi', expandedFrom: 'c.li', format: 'I', rd, rs1: 'x0', imm: imm6 };
    case 3: {
      if (bits(word, 11, 7) === 2) {
        const nz = (bits(word, 12, 12) << 9) | (bits(word, 4, 3) << 7) | (bits(word, 5, 5) << 6) | (bits(word, 2, 2) << 5) | (bits(word, 6, 6) << 4);
        if (nz === 0) return unsupported('riscv64-c-addi16sp-reserved-zero-immediate');
        return { ...base, op: 'addi', expandedFrom: 'c.addi16sp', format: 'I', rd: 'x2', rs1: 'x2', imm: signExtend(nz, 10) };
      }
      const nz = (bits(word, 12, 12) << 17) | (bits(word, 6, 2) << 12);
      if (nz === 0) return unsupported('riscv64-c-lui-reserved-zero-immediate');
      return { ...base, op: 'lui', expandedFrom: 'c.lui', format: 'U', rd, imm: signExtend(nz, 18) };
    }
    case 4: {
      const select = bits(word, 11, 10);
      if (select === 0 || select === 1) {
        const shamt = (bits(word, 12, 12) << 5) | bits(word, 6, 2);
        if (shamt === 0) return unsupported('riscv64-c-shift-reserved-zero-shamt');
        return { ...base, op: select === 0 ? 'srli' : 'srai', expandedFrom: select === 0 ? 'c.srli' : 'c.srai', format: 'I', rd: rdPrime, rs1: rdPrime, shamt };
      }
      if (select === 2) return { ...base, op: 'andi', expandedFrom: 'c.andi', format: 'I', rd: rdPrime, rs1: rdPrime, imm: imm6 };
      const rs2Prime = CREG(bits(word, 4, 2));
      const table = { 0: 'sub', 1: 'xor', 2: 'or', 3: 'and' };
      const wideTable = { 0: 'subw', 1: 'addw' };
      if (bits(word, 12, 12) === 0) {
        return { ...base, op: table[bits(word, 6, 5)], expandedFrom: `c.${table[bits(word, 6, 5)]}`, format: 'R', rd: rdPrime, rs1: rdPrime, rs2: rs2Prime };
      }
      const wide = wideTable[bits(word, 6, 5)];
      if (!wide) return unsupported('riscv64-reserved-c-alu-encoding', { funct3, select, high: bits(word, 6, 5) });
      return { ...base, op: wide, expandedFrom: `c.${wide}`, format: 'R', rd: rdPrime, rs1: rdPrime, rs2: rs2Prime, resultBits: 32 };
    }
    case 5: {
      const offset = (bits(word, 12, 12) << 11) | (bits(word, 8, 8) << 10) | (bits(word, 10, 9) << 8) | (bits(word, 6, 6) << 7)
        | (bits(word, 7, 7) << 6) | (bits(word, 2, 2) << 5) | (bits(word, 11, 11) << 4) | (bits(word, 5, 3) << 1);
      return { ...base, op: 'jal', expandedFrom: 'c.j', format: 'J', rd: 'x0', imm: signExtend(offset, 12) };
    }
    case 6: case 7: {
      const offset = (bits(word, 12, 12) << 8) | (bits(word, 6, 5) << 6) | (bits(word, 2, 2) << 5) | (bits(word, 11, 10) << 3) | (bits(word, 4, 3) << 1);
      return {
        ...base,
        op: funct3 === 6 ? 'beq' : 'bne',
        expandedFrom: funct3 === 6 ? 'c.beqz' : 'c.bnez',
        format: 'B',
        rs1: rdPrime,
        rs2: 'x0',
        imm: signExtend(offset, 9),
      };
    }
    default: return unsupported('riscv64-reserved-c-quadrant1-encoding', { funct3 });
  }
}

function decodeQuadrant2(word) {
  const funct3 = bits(word, 15, 13);
  const base = { compressed: true, sizeBytes: 2 };
  const rd = X(bits(word, 11, 7));
  const rs2 = X(bits(word, 6, 2));
  switch (funct3) {
    case 0: {
      const shamt = (bits(word, 12, 12) << 5) | bits(word, 6, 2);
      if (shamt === 0 || bits(word, 11, 7) === 0) return unsupported('riscv64-c-slli-reserved-encoding');
      return { ...base, op: 'slli', expandedFrom: 'c.slli', format: 'I', rd, rs1: rd, shamt };
    }
    case 2: {
      if (bits(word, 11, 7) === 0) return unsupported('riscv64-c-lwsp-reserved-zero-rd');
      const offset = (bits(word, 3, 2) << 6) | (bits(word, 12, 12) << 5) | (bits(word, 6, 4) << 2);
      return { ...base, op: 'lw', expandedFrom: 'c.lwsp', format: 'I', kind: 'load', rd, rs1: 'x2', imm: BigInt(offset), memoryWidthBits: 32, memorySigned: true };
    }
    case 3: {
      if (bits(word, 11, 7) === 0) return unsupported('riscv64-c-ldsp-reserved-zero-rd');
      const offset = (bits(word, 4, 2) << 6) | (bits(word, 12, 12) << 5) | (bits(word, 6, 5) << 3);
      return { ...base, op: 'ld', expandedFrom: 'c.ldsp', format: 'I', kind: 'load', rd, rs1: 'x2', imm: BigInt(offset), memoryWidthBits: 64, memorySigned: true };
    }
    case 4: {
      const hasRs2 = bits(word, 6, 2) !== 0;
      const hasRd = bits(word, 11, 7) !== 0;
      if (bits(word, 12, 12) === 0) {
        if (!hasRs2) {
          if (!hasRd) return unsupported('riscv64-c-jr-reserved-zero-rs1');
          return { ...base, op: 'jalr', expandedFrom: 'c.jr', format: 'I', rd: 'x0', rs1: rd, imm: 0n };
        }
        if (!hasRd) return unsupported('riscv64-c-mv-reserved-zero-rd');
        return { ...base, op: 'add', expandedFrom: 'c.mv', format: 'R', rd, rs1: 'x0', rs2 };
      }
      if (!hasRs2 && !hasRd) return { ...base, op: 'ebreak', expandedFrom: 'c.ebreak', format: 'I' };
      if (!hasRs2) return { ...base, op: 'jalr', expandedFrom: 'c.jalr', format: 'I', rd: 'x1', rs1: rd, imm: 0n };
      if (!hasRd) return unsupported('riscv64-c-add-reserved-zero-rd');
      return { ...base, op: 'add', expandedFrom: 'c.add', format: 'R', rd, rs1: rd, rs2 };
    }
    case 6: {
      const offset = (bits(word, 8, 7) << 6) | (bits(word, 12, 9) << 2);
      return { ...base, op: 'sw', expandedFrom: 'c.swsp', format: 'S', kind: 'store', rs1: 'x2', rs2, imm: BigInt(offset), memoryWidthBits: 32 };
    }
    case 7: {
      const offset = (bits(word, 9, 7) << 6) | (bits(word, 12, 10) << 3);
      return { ...base, op: 'sd', expandedFrom: 'c.sdsp', format: 'S', kind: 'store', rs1: 'x2', rs2, imm: BigInt(offset), memoryWidthBits: 64 };
    }
    case 1: case 5: return unsupported('riscv64-floating-point-extension-outside-phase6-profile', { quadrant: 2, funct3 });
    default: return unsupported('riscv64-reserved-c-quadrant2-encoding', { funct3 });
  }
}

/**
 * Decode one RV64 instruction word into canonical architectural fields.
 *
 * `bytes` must be the exact decoder-provided raw bytes for a single
 * instruction. Register fields are canonical physical ids (`x0`..`x31`), never
 * psABI aliases, so no consumer can confuse `a0` with a second location.
 * Immediates are BigInt and already sign-extended per the ISA encoding tables.
 */
export function decodeRiscv64InstructionWord(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  if (input.length !== 2 && input.length !== 4) {
    return Object.freeze(unsupported('riscv64-unsupported-instruction-length', { length: input.length }));
  }
  const low = input[0] | (input[1] << 8);
  const expectedLength = riscvInstructionLength(low);
  if (expectedLength !== input.length) {
    return Object.freeze(unsupported('riscv64-instruction-length-disagrees-with-encoding', { expectedLength, actualLength: input.length }));
  }
  if (input.length === 2) {
    const quadrant = low & 0b11;
    const decoded = quadrant === 0 ? decodeQuadrant0(low) : quadrant === 1 ? decodeQuadrant1(low) : decodeQuadrant2(low);
    return Object.freeze(decoded.supported === false ? decoded : { supported: true, word: low, ...decoded });
  }
  const word = ((input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0);
  const decoded = decodeUncompressed(word);
  return Object.freeze(decoded.supported === false ? decoded : { supported: true, word, ...decoded });
}
