import { RISCV64_XLEN, createRiscv64EffectContext } from './common.js';

/**
 * "M" standard extension: integer multiply and divide.
 *
 * Authority: RISC-V Unprivileged ISA, "M" Standard Extension for Integer
 * Multiplication and Division.
 *
 * RISC-V does *not* trap on division by zero or on signed overflow; it defines
 * exact results for both. Emitting a bare `sdiv` and calling the bundle exact
 * would therefore be an overclaim, so the defined edge cases are modelled
 * explicitly:
 *
 *   div  : divisor == 0 -> all ones (-1); MIN / -1 -> MIN
 *   divu : divisor == 0 -> 2^XLEN - 1
 *   rem  : divisor == 0 -> dividend;      MIN % -1 -> 0
 *   remu : divisor == 0 -> dividend
 *
 * The divisor fed to the underlying division operation is itself guarded, so
 * the emitted expression never contains a structural division by zero for any
 * later constant-folding pass to trip over.
 */

const HIGH_MULTIPLY = Object.freeze({
  mulh: { left: 'sext', right: 'sext' },
  mulhu: { left: 'zext', right: 'zext' },
  mulhsu: { left: 'sext', right: 'zext' },
});

const DIVIDE = Object.freeze({
  div: { opcode: 'sdiv', signed: true, remainder: false, bits: 64 },
  divu: { opcode: 'udiv', signed: false, remainder: false, bits: 64 },
  rem: { opcode: 'srem', signed: true, remainder: true, bits: 64 },
  remu: { opcode: 'urem', signed: false, remainder: true, bits: 64 },
  divw: { opcode: 'sdiv', signed: true, remainder: false, bits: 32 },
  divuw: { opcode: 'udiv', signed: false, remainder: false, bits: 32 },
  remw: { opcode: 'srem', signed: true, remainder: true, bits: 32 },
  remuw: { opcode: 'urem', signed: false, remainder: true, bits: 32 },
});

function narrow(ctx, value, bits) {
  return bits === RISCV64_XLEN ? value : ctx.valueOp('trunc', [value], bits, { fromBits: RISCV64_XLEN, toBits: bits });
}

export function liftRiscv64MulDivEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported) return null;
  const op = fields.op;

  if (op === 'mul' || op === 'mulw') {
    const product = ctx.valueOp('mul', [ctx.readRegister(fields.rs1), ctx.readRegister(fields.rs2)], RISCV64_XLEN, { widthBits: RISCV64_XLEN });
    ctx.writeRegister(fields.rd, op === 'mulw' ? ctx.signExtend32To64(product) : product);
    return ctx.finish({
      family: 'multiply',
      metadata: { operation: op, extension: 'M', ...(op === 'mulw' ? { resultBits: 32, resultExtension: 'sign-extend-to-xlen' } : {}) },
    });
  }

  if (HIGH_MULTIPLY[op]) {
    const { left, right } = HIGH_MULTIPLY[op];
    const wide = 2 * RISCV64_XLEN;
    const a = ctx.valueOp(left, [ctx.readRegister(fields.rs1)], wide, { fromBits: RISCV64_XLEN, toBits: wide });
    const b = ctx.valueOp(right, [ctx.readRegister(fields.rs2)], wide, { fromBits: RISCV64_XLEN, toBits: wide });
    const product = ctx.valueOp('mul', [a, b], wide, { widthBits: wide });
    const high = ctx.valueOp('lshr', [product, ctx.constant(wide, RISCV64_XLEN)], wide, { widthBits: wide });
    ctx.writeRegister(fields.rd, ctx.valueOp('trunc', [high], RISCV64_XLEN, { fromBits: wide, toBits: RISCV64_XLEN }));
    return ctx.finish({
      family: 'multiply',
      metadata: { operation: op, extension: 'M', resultPortion: 'high-xlen-bits', leftExtension: left, rightExtension: right },
    });
  }

  const spec = DIVIDE[op];
  if (!spec) return null;

  const bits = spec.bits;
  const dividend = narrow(ctx, ctx.readRegister(fields.rs1), bits);
  const divisor = narrow(ctx, ctx.readRegister(fields.rs2), bits);
  const zero = ctx.constant(bits, 0);
  const one = ctx.constant(bits, 1);
  const allOnes = ctx.constant(bits, -1n);
  const minimum = ctx.constant(bits, -(1n << BigInt(bits - 1)));

  const divisorIsZero = ctx.valueOp('icmp.eq', [divisor, zero], 1, { predicate: 'eq', widthBits: bits, edgeCase: 'divide-by-zero' });
  // Keep the operand handed to the division non-zero so no structural
  // division by zero can ever appear in the lowered expression.
  const safeDivisor = ctx.valueOp('select', [divisorIsZero, one, divisor], bits, { edgeCase: 'divide-by-zero-guard' });
  const raw = ctx.valueOp(spec.opcode, [dividend, safeDivisor], bits, { widthBits: bits, signed: spec.signed });

  let result = raw;
  if (spec.signed) {
    const dividendIsMinimum = ctx.valueOp('icmp.eq', [dividend, minimum], 1, { predicate: 'eq', widthBits: bits, edgeCase: 'signed-overflow' });
    const divisorIsNegativeOne = ctx.valueOp('icmp.eq', [divisor, allOnes], 1, { predicate: 'eq', widthBits: bits, edgeCase: 'signed-overflow' });
    const overflow = ctx.valueOp('and', [dividendIsMinimum, divisorIsNegativeOne], 1, { edgeCase: 'signed-overflow' });
    result = ctx.valueOp('select', [overflow, spec.remainder ? zero : minimum, result], bits, {
      edgeCase: 'signed-overflow',
      definedResult: spec.remainder ? 'zero' : 'most-negative-value',
    });
  }
  result = ctx.valueOp('select', [divisorIsZero, spec.remainder ? dividend : allOnes, result], bits, {
    edgeCase: 'divide-by-zero',
    definedResult: spec.remainder ? 'dividend' : 'all-ones',
  });

  const extended = bits === RISCV64_XLEN
    ? result
    : ctx.valueOp('sext', [result], RISCV64_XLEN, { fromBits: bits, toBits: RISCV64_XLEN });
  ctx.writeRegister(fields.rd, extended);
  return ctx.finish({
    family: spec.remainder ? 'remainder' : 'divide',
    metadata: {
      operation: op,
      extension: 'M',
      signed: spec.signed,
      resultBits: bits,
      ...(bits === RISCV64_XLEN ? {} : { resultExtension: 'sign-extend-to-xlen' }),
      definedEdgeCases: spec.signed ? ['divide-by-zero', 'signed-overflow'] : ['divide-by-zero'],
      trapsOnDivideByZero: false,
    },
  });
}
