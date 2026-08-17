import { x86RegisterOperand } from './common.js';
import { emitX86DivisionUndefinedFlags, emitX86MultiplyFlags } from './flags.js';

export const X86_SCALAR_WIDTHS = Object.freeze([8,16,32,64]);
const WIDTHS = new Set(X86_SCALAR_WIDTHS);

export function x86ScalarWidth(widthBits) { return WIDTHS.has(Number(widthBits)); }
export function canonicalX86Shift(family) { return family === 'sal' ? 'shl' : String(family || '').toLowerCase(); }
export function x86ShiftCountMask(widthBits) { return Number(widthBits) === 64 ? 0x3fn : 0x1fn; }

export function resolveX86EffectiveCount(ctx, operand, widthBits, { rotate = false } = {}) {
  if (!operand || !x86ScalarWidth(widthBits)) return null;
  const width = Number(widthBits);
  const mask = x86ShiftCountMask(width);
  if (operand.type === 'immediate') {
    const masked = Number(BigInt(operand.value) & mask);
    const count = rotate ? masked % width : masked;
    return Object.freeze({ value:ctx.constant(8, BigInt(count)), knownCount:count });
  }
  if (operand.type !== 'register' || operand.register?.id !== 'cl') return null;
  const raw = ctx.readRegister(operand);
  if (!raw) return null;
  let value = ctx.valueOp('and', [raw,ctx.constant(8,mask)], 8, {
    semantic:'x86-effective-count-mask', source:'cl', mask:Number(mask),
  });
  if (rotate && width < 32) {
    value = ctx.valueOp('urem', [value,ctx.constant(8,BigInt(width))], 8, {
      semantic:'x86-rotate-count-modulo-width', widthBits:width,
    });
  }
  return Object.freeze({ value, knownCount:null });
}

export function x86ShiftResultRule(operation) {
  switch (canonicalX86Shift(operation)) {
    case 'shl': return 'destination << effectiveCount, truncated to destination width';
    case 'shr': return 'unsigned(destination) >> effectiveCount with zero fill';
    case 'sar': return 'signed(destination) >> effectiveCount with sign fill';
    case 'rol': return 'destination bits rotated left by effectiveCount modulo operand width';
    case 'ror': return 'destination bits rotated right by effectiveCount modulo operand width';
    default: return 'unsupported';
  }
}

export function x86ImplicitMultiplyRegisters(widthBits) {
  switch (Number(widthBits)) {
    case 8: return Object.freeze({ accumulator:'al', combined:'ax' });
    case 16: return Object.freeze({ accumulator:'ax', high:'dx' });
    case 32: return Object.freeze({ accumulator:'eax', high:'edx' });
    case 64: return Object.freeze({ accumulator:'rax', high:'rdx' });
    default: return null;
  }
}

export function x86ImplicitDivideRegisters(widthBits) {
  switch (Number(widthBits)) {
    case 8: return Object.freeze({ low:'al', high:'ah', dividend:'ax', quotient:'al', remainder:'ah', combinedResult:'ax' });
    case 16: return Object.freeze({ low:'ax', high:'dx', quotient:'ax', remainder:'dx' });
    case 32: return Object.freeze({ low:'eax', high:'edx', quotient:'eax', remainder:'edx' });
    case 64: return Object.freeze({ low:'rax', high:'rdx', quotient:'rax', remainder:'rdx' });
    default: return null;
  }
}

export function x86DivisionFault(operation, divisor, dividend, widthBits) {
  return Object.freeze({
    kind:'divide-error',
    condition:Object.freeze({
      kind:'x86-divide-error', operation, widthBits,
      anyOf:Object.freeze([
        Object.freeze({ kind:'divisor-zero', divisor }),
        Object.freeze({ kind:'quotient-out-of-range', dividend, divisor, quotientWidthBits:widthBits, signed:operation === 'idiv' }),
      ]),
    }),
    detail:Object.freeze({ vector:'#DE', faultClass:'fault', architecturallyPossible:true }),
  });
}

export function x86MultiplyRules(signed) {
  return Object.freeze({
    product:signed ? 'signed two-complement accumulator multiplied by signed two-complement source' : 'unsigned accumulator multiplied by unsigned source',
    overflow:signed ? 'CF=OF=1 iff upper half is not the sign-extension of the low half' : 'CF=OF=1 iff upper half is nonzero',
  });
}

export function x86TruncatedImulRules() {
  return Object.freeze({
    result:'low destination-width bits of signed two-complement product',
    overflow:'CF=OF=1 iff full signed product is not the sign-extension of the truncated destination',
  });
}

export function x86DivisionRules(signed) {
  return Object.freeze(signed ? {
    quotient:'signed two-complement dividend / signed divisor, truncated toward zero',
    remainder:'dividend - quotient*divisor; zero or same sign as dividend',
    fault:'divide error if divisor is zero or signed quotient does not fit destination width',
  } : {
    quotient:'unsigned dividend / unsigned divisor, integer quotient',
    remainder:'unsigned dividend modulo unsigned divisor',
    fault:'divide error if divisor is zero or unsigned quotient does not fit destination width',
  });
}


export function emitX86ImplicitMultiply(ctx, family, multiplier, widthBits) {
  const width = Number(widthBits);
  const signed = family === 'imul';
  const registers = x86ImplicitMultiplyRegisters(width);
  if (!registers || !multiplier) return null;
  const accumulator = ctx.readRegister(x86RegisterOperand(registers.accumulator));
  if (!accumulator) return null;
  const rules = x86MultiplyRules(signed);
  if (width === 8) {
    const [product,overflow] = ctx.intrinsic(`x86.integer.${family}.implicit`, [accumulator,multiplier], [16,1], {
      determinism:'input-dependent', symbolicDetail:'summary-only',
      metadata:{ signed, operandWidthBits:8, productWidthBits:16, implicitAccumulator:'al', destination:'ax', semanticRules:rules, exactArchitecturalSummary:true },
    });
    if (!ctx.writeRegister(x86RegisterOperand(registers.combined), product)) return null;
    emitX86MultiplyFlags(ctx, family, overflow, 8);
  } else {
    const [low,high,overflow] = ctx.intrinsic(`x86.integer.${family}.implicit`, [accumulator,multiplier], [width,width,1], {
      determinism:'input-dependent', symbolicDetail:'summary-only',
      metadata:{ signed, operandWidthBits:width, productWidthBits:width * 2, implicitAccumulator:registers.accumulator, highDestination:registers.high, semanticRules:rules, exactArchitecturalSummary:true },
    });
    if (!ctx.writeRegister(x86RegisterOperand(registers.accumulator), low) || !ctx.writeRegister(x86RegisterOperand(registers.high), high)) return null;
    emitX86MultiplyFlags(ctx, family, overflow, width);
  }
  return Object.freeze({ signed, widthBits:width, form:'one-operand-implicit' });
}

export function emitX86TruncatedImul(ctx, left, right, widthBits, form) {
  if (!left || !right) return null;
  const width = Number(widthBits);
  const [result,overflow] = ctx.intrinsic('x86.integer.imul.truncated', [left,right], [width,1], {
    determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ signed:true, form, widthBits:width, semanticRules:x86TruncatedImulRules(), exactArchitecturalSummary:true },
  });
  emitX86MultiplyFlags(ctx, 'imul', overflow, width);
  return result;
}

export function emitX86ImplicitDivide(ctx, family, divisor, widthBits, {
  const width = Number(widthBits);
  const registers = x86ImplicitDivideRegisters(width);
  if (!registers || !divisor) return null;
  let dividend;
  if (width === 8) {
    dividend = ctx.readRegister(x86RegisterOperand(registers.dividend));
  } else {
    const low = ctx.readRegister(x86RegisterOperand(registers.low));
    const high = ctx.readRegister(x86RegisterOperand(registers.high));
    if (!low || !high) return null;
    dividend = ctx.valueOp('concat', [high,low], width * 2, { high:registers.high, low:registers.low, semantic:'x86-implicit-dividend' });
  }
  if (!dividend) return null;
  const signed = family === 'idiv';
  const [quotient,remainder] = ctx.intrinsic(`x86.integer.${family}`, [dividend,divisor], [width,width], {
    determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ signed, dividendWidthBits:width * 2, divisorWidthBits:width, quotientWidthBits:width, semanticRules:x86DivisionRules(signed), exactArchitecturalSummary:true },
  });
  if (width === 8) {
    const combined = ctx.valueOp('concat', [remainder,quotient], 16, { high:'ah', low:'al', semantic:'x86-div-result-ax' });
    if (!ctx.writeRegister(x86RegisterOperand(registers.combinedResult), combined)) return null;
  } else if (!ctx.writeRegister(x86RegisterOperand(registers.quotient), quotient) || !ctx.writeRegister(x86RegisterOperand(registers.remainder), remainder)) {
    return null;
  }
  emitX86DivisionUndefinedFlags(ctx, family, width);
  return Object.freeze({ signed, widthBits:width, form:'implicit-dividend-pair', possibleFault:x86DivisionFault(family, divisor, dividend, width) });
}
