import { RISCV64_XLEN, createRiscv64EffectContext, riscv64MemoryFaults } from './common.js';

/**
 * RV64 load and store effects.
 *
 * Authority: RISC-V Unprivileged ISA, "Load and Store Instructions" plus the
 * RV64I additions (`ld`, `lwu`, `sd`).
 *
 * The effective address is always `rs1 + sext(imm)`, computed with explicit
 * value operations so the address expression keeps its provenance into
 * MemorySSA. Loads sign- or zero-extend the accessed width to XLEN according to
 * the opcode; stores write the low `widthBits` of rs2 and never touch rd.
 *
 * Alignment is not proven: the frozen Phase 6 profile does not model the
 * privileged architecture, so the misaligned-address fault stays explicit
 * rather than being asserted away.
 */
export function liftRiscv64MemoryEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported) return null;
  if (fields.kind !== 'load' && fields.kind !== 'store') return null;

  const base = ctx.readRegister(fields.rs1);
  const addressExpr = ctx.valueOp('add', [base, ctx.constant(RISCV64_XLEN, fields.imm)], RISCV64_XLEN, {
    addressArithmetic: 'base-plus-displacement',
    displacement: String(fields.imm),
    baseRegister: fields.rs1,
  });
  const widthBits = Number(fields.memoryWidthBits);

  if (fields.kind === 'load') {
    const loaded = ctx.readMemory(addressExpr, widthBits, {
      metadata: { accessWidthBits: widthBits, alignmentProven: false },
    });
    const extended = widthBits === RISCV64_XLEN
      ? loaded
      : ctx.valueOp(fields.memorySigned ? 'sext' : 'zext', [loaded], RISCV64_XLEN, { fromBits: widthBits, toBits: RISCV64_XLEN });
    ctx.writeRegister(fields.rd, extended);
    return ctx.finish({
      family: 'memory',
      possibleFaults: riscv64MemoryFaults('read', widthBits),
      metadata: { operation: fields.op, accessWidthBits: widthBits, resultExtension: fields.memorySigned ? 'sign-extend' : 'zero-extend' },
    });
  }

  const source = ctx.readRegister(fields.rs2);
  const stored = widthBits === RISCV64_XLEN
    ? source
    : ctx.valueOp('trunc', [source], widthBits, { fromBits: RISCV64_XLEN, toBits: widthBits });
  ctx.writeMemory(addressExpr, widthBits, stored, {
    metadata: { accessWidthBits: widthBits, alignmentProven: false },
  });
  return ctx.finish({
    family: 'memory',
    possibleFaults: riscv64MemoryFaults('write', widthBits),
    metadata: { operation: fields.op, accessWidthBits: widthBits },
  });
}
