import { RISCV64_XLEN, createRiscv64EffectContext } from './common.js';

/**
 * RV64I integer-register and integer-immediate effects, plus the RV64-only
 * `*W` forms.
 *
 * Authority: RISC-V Unprivileged ISA, "Integer Computational Instructions"
 * (RV32I base) and "Integer Computational Instructions" for RV64I.
 *
 * The two behaviours worth calling out because they are the classic RV64
 * lifting bugs:
 *
 *  - every `*W` instruction computes a 32-bit result and *sign-extends* it to
 *    XLEN, including the unsigned shift `srlw`;
 *  - shift amounts are masked: 6 bits for the XLEN-wide shifts, 5 bits for the
 *    `*W` shifts, taken from the low bits of rs2.
 */

const XLEN_BINARY = Object.freeze({
  add: 'add', sub: 'sub', and: 'and', or: 'or', xor: 'xor',
  addi: 'add', andi: 'and', ori: 'or', xori: 'xor',
});
const XLEN_SHIFT = Object.freeze({ sll: 'shl', srl: 'lshr', sra: 'ashr', slli: 'shl', srli: 'lshr', srai: 'ashr' });
const WORD_BINARY = Object.freeze({ addw: 'add', subw: 'sub', addiw: 'add' });
const WORD_SHIFT = Object.freeze({ sllw: 'shl', srlw: 'lshr', sraw: 'ashr', slliw: 'shl', srliw: 'lshr', sraiw: 'ashr' });
const COMPARE = Object.freeze({
  slt: { predicate: 'slt', signed: true },
  slti: { predicate: 'slt', signed: true },
  sltu: { predicate: 'ult', signed: false },
  sltiu: { predicate: 'ult', signed: false },
});

const IMMEDIATE_FORMS = new Set(['addi', 'andi', 'ori', 'xori', 'slti', 'sltiu', 'addiw']);

function operandValues(ctx, fields) {
  const left = ctx.readRegister(fields.rs1);
  if (fields.rs2 != null) return [left, ctx.readRegister(fields.rs2)];
  // `sltiu rd, rs1, imm` compares against the sign-extended immediate treated
  // as an unsigned XLEN value; sign extension already happened at decode.
  return [left, ctx.constant(RISCV64_XLEN, fields.imm)];
}

export function liftRiscv64IntegerEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported) return null;
  const op = fields.op;

  if (op === 'lui') {
    // LUI materialises imm[31:12] as a sign-extended 32-bit constant.
    ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, fields.imm));
    return ctx.finish({ family: 'integer-constant', metadata: { valueOrigin: 'lui-upper-immediate' } });
  }

  if (op === 'auipc') {
    // AUIPC forms a PC-relative address. The instruction's own address is
    // architectural input, so it is materialised as an explicit constant and
    // the resulting value keeps a pc-relative provenance marker.
    const pc = ctx.constant(RISCV64_XLEN, ctx.instruction.address);
    const offset = ctx.constant(RISCV64_XLEN, fields.imm);
    const address = ctx.valueOp('add', [pc, offset], RISCV64_XLEN, {
      addressArithmetic: 'pc-relative',
      pcValue: `0x${BigInt(ctx.instruction.address).toString(16)}`,
    });
    ctx.writeRegister(fields.rd, address);
    return ctx.finish({ family: 'address-formation', metadata: { valueOrigin: 'auipc-pc-relative' } });
  }

  if (COMPARE[op]) {
    const { predicate, signed } = COMPARE[op];
    const [left, right] = operandValues(ctx, fields);
    const bit = ctx.valueOp(`icmp.${predicate}`, [left, right], 1, { predicate, signed, widthBits: RISCV64_XLEN });
    // The comparison result is an ordinary integer value in rd. No flag state
    // is written, because RV64 has none.
    ctx.writeRegister(fields.rd, ctx.valueOp('zext', [bit], RISCV64_XLEN, { fromBits: 1, toBits: RISCV64_XLEN }));
    return ctx.finish({ family: 'comparison', metadata: { predicate, signed, materializedInto: 'general-purpose-register' } });
  }

  if (XLEN_BINARY[op]) {
    const [left, right] = operandValues(ctx, fields);
    ctx.writeRegister(fields.rd, ctx.valueOp(XLEN_BINARY[op], [left, right], RISCV64_XLEN, {
      widthBits: RISCV64_XLEN,
      ...(IMMEDIATE_FORMS.has(op) ? { immediate: String(fields.imm) } : {}),
    }));
    return ctx.finish({ family: 'integer' });
  }

  if (XLEN_SHIFT[op]) {
    const value = ctx.readRegister(fields.rs1);
    const amount = fields.shamt != null
      ? ctx.constant(RISCV64_XLEN, fields.shamt)
      // Register shifts use rs2[5:0]; the upper bits are architecturally ignored.
      : ctx.valueOp('and', [ctx.readRegister(fields.rs2), ctx.constant(RISCV64_XLEN, 63)], RISCV64_XLEN, { shiftAmountMask: 63 });
    ctx.writeRegister(fields.rd, ctx.valueOp(XLEN_SHIFT[op], [value, amount], RISCV64_XLEN, {
      widthBits: RISCV64_XLEN,
      shiftAmountBits: 6,
      signed: op === 'sra' || op === 'srai',
    }));
    return ctx.finish({ family: 'shift' });
  }

  if (WORD_BINARY[op]) {
    const [left, right] = operandValues(ctx, fields);
    const wide = ctx.valueOp(WORD_BINARY[op], [left, right], RISCV64_XLEN, { widthBits: RISCV64_XLEN });
    ctx.writeRegister(fields.rd, ctx.signExtend32To64(wide));
    return ctx.finish({ family: 'integer-word', metadata: { resultBits: 32, resultExtension: 'sign-extend-to-xlen' } });
  }

  if (WORD_SHIFT[op]) {
    // *W shifts operate on the low 32 bits with a 5-bit shift amount, then
    // sign-extend the 32-bit result. `srlw` is a *logical* 32-bit shift whose
    // 32-bit result is nevertheless sign-extended.
    const narrow = ctx.valueOp('trunc', [ctx.readRegister(fields.rs1)], 32, { fromBits: RISCV64_XLEN, toBits: 32 });
    const amount = fields.shamt != null
      ? ctx.constant(32, fields.shamt)
      : ctx.valueOp('trunc', [
        ctx.valueOp('and', [ctx.readRegister(fields.rs2), ctx.constant(RISCV64_XLEN, 31)], RISCV64_XLEN, { shiftAmountMask: 31 }),
      ], 32, { fromBits: RISCV64_XLEN, toBits: 32 });
    const shifted = ctx.valueOp(WORD_SHIFT[op], [narrow, amount], 32, {
      widthBits: 32,
      shiftAmountBits: 5,
      signed: op === 'sraw' || op === 'sraiw',
    });
    ctx.writeRegister(fields.rd, ctx.valueOp('sext', [shifted], RISCV64_XLEN, { fromBits: 32, toBits: RISCV64_XLEN }));
    return ctx.finish({ family: 'shift-word', metadata: { resultBits: 32, resultExtension: 'sign-extend-to-xlen' } });
  }

  return null;
}
