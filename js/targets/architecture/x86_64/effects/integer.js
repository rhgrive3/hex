import { createX86EffectContext, x86RegisterOperand } from './common.js';
import { materializeX86Address } from './addressing.js';
import {
  emitX86ArithmeticFlags,
  emitX86Condition,
  emitX86DivisionUndefinedFlags,
  emitX86IncDecFlags,
  emitX86LogicalFlags,
  emitX86MultiplyFlags,
  emitX86NegFlags,
  emitX86RotateFlags,
  emitX86ShiftFlags,
} from './flags.js';

const MOVES = new Set(['mov','movabs']);
const EXTENDS = new Map([
  ['movzx', false], ['movsx', true], ['movsxd', true],
]);
const ARITHMETIC = new Set(['add','adc','sub','sbb']);
const LOGICAL = new Set(['and','or','xor']);
const UNARY_ARITHMETIC = new Set(['inc','dec','neg']);
const SHIFTS = new Set(['shl','sal','shr','sar']);
const ROTATES = new Set(['rol','ror']);
const MULTIPLY = new Set(['mul','imul']);
const DIVIDE = new Set(['div','idiv']);
const WIDTHS = new Set([8,16,32,64]);

function supportedWidth(widthBits) { return WIDTHS.has(Number(widthBits)); }
function hasMemory(operands) { return operands.some((operand) => operand?.type === 'memory'); }
function registerOrImmediate(operand) { return operand?.type === 'register' || operand?.type === 'immediate'; }
function canonicalShift(family) { return family === 'sal' ? 'shl' : family; }
function maskForCount(widthBits) { return widthBits === 64 ? 0x3fn : 0x1fn; }

function writeConditionalRegister(ctx, destination, condition, trueValue) {
  const descriptor = destination?.register;
  if (!descriptor) return false;
  const physical = x86RegisterOperand(descriptor.physicalId);
  if (!physical) return false;
  const oldPhysical = ctx.readRegister(physical);
  if (!oldPhysical) return false;

  let truePhysical = trueValue;
  if (descriptor.writePolicy === 'zero-extend-32') {
    truePhysical = ctx.coerce(trueValue, descriptor.viewBits, descriptor.physicalBits, false);
  } else if (descriptor.viewBits !== descriptor.physicalBits || descriptor.lsb !== 0) {
    truePhysical = ctx.valueOp('insert', [oldPhysical,trueValue], descriptor.physicalBits, {
      lsb:descriptor.lsb,
      widthBits:descriptor.viewBits,
      physicalBits:descriptor.physicalBits,
      physicalId:descriptor.physicalId,
      view:descriptor.id,
      writePolicy:'preserve-unaffected',
      conditionalWrite:true,
    });
  }
  const finalPhysical = ctx.valueOp('select', [condition,truePhysical,oldPhysical], descriptor.physicalBits, {
    semantic:'x86-conditional-register-write',
    destinationView:descriptor.id,
  });
  return ctx.writeRegister(physical, finalPhysical);
}

function effectiveCount(ctx, operand, widthBits, { rotate = false } = {}) {
  if (!operand) return null;
  const mask = maskForCount(widthBits);
  if (operand.type === 'immediate') {
    const masked = Number(BigInt(operand.value) & mask);
    const count = rotate ? masked % widthBits : masked;
    return Object.freeze({ value:ctx.constant(8, BigInt(count)), knownCount:count });
  }
  if (operand.type !== 'register' || operand.register?.id !== 'cl') return null;
  const raw = ctx.readRegister(operand);
  if (!raw) return null;
  let value = ctx.valueOp('and', [raw,ctx.constant(8,mask)], 8, {
    semantic:'x86-effective-count-mask',
    source:'cl',
    mask:Number(mask),
  });
  if (rotate && widthBits < 32) {
    value = ctx.valueOp('urem', [value,ctx.constant(8,BigInt(widthBits))], 8, {
      semantic:'x86-rotate-count-modulo-width',
      widthBits,
    });
  }
  return Object.freeze({ value, knownCount:null });
}

function implicitMultiplyRegisters(widthBits) {
  switch (widthBits) {
    case 8: return Object.freeze({ accumulator:'al', combined:'ax' });
    case 16: return Object.freeze({ accumulator:'ax', high:'dx' });
    case 32: return Object.freeze({ accumulator:'eax', high:'edx' });
    case 64: return Object.freeze({ accumulator:'rax', high:'rdx' });
    default: return null;
  }
}

function implicitDivideRegisters(widthBits) {
  switch (widthBits) {
    case 8: return Object.freeze({ low:'al', high:'ah', dividend:'ax', quotient:'al', remainder:'ah', combinedResult:'ax' });
    case 16: return Object.freeze({ low:'ax', high:'dx', quotient:'ax', remainder:'dx' });
    case 32: return Object.freeze({ low:'eax', high:'edx', quotient:'eax', remainder:'edx' });
    case 64: return Object.freeze({ low:'rax', high:'rdx', quotient:'rax', remainder:'rdx' });
    default: return null;
  }
}

function divisionFault(operation, divisor, dividend, widthBits) {
  return Object.freeze({
    kind:'divide-error',
    condition:Object.freeze({
      kind:'x86-divide-error',
      operation,
      widthBits,
      anyOf:Object.freeze([
        Object.freeze({ kind:'divisor-zero', divisor }),
        Object.freeze({ kind:'quotient-out-of-range', dividend, divisor, quotientWidthBits:widthBits, signed:operation === 'idiv' }),
      ]),
    }),
    detail:Object.freeze({ vector:'#DE', faultClass:'fault', architecturallyPossible:true }),
  });
}

export function liftX86IntegerEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const recognized = MOVES.has(family)
    || EXTENDS.has(family)
    || ARITHMETIC.has(family)
    || LOGICAL.has(family)
    || UNARY_ARITHMETIC.has(family)
    || SHIFTS.has(family)
    || ROTATES.has(family)
    || MULTIPLY.has(family)
    || DIVIDE.has(family)
    || ['cmp','test','not','setcc','cmovcc'].includes(family)
    || family.startsWith('set')
    || family.startsWith('cmov');
  if (!recognized) return null;

  const ctx = createX86EffectContext(instruction, context);
  const [destination, source, third] = ctx.operands;

  if (hasMemory(ctx.operands)) {
    return ctx.partial(`x86-${family}-memory-form-deferred-to-p5-2`, ['memory','registers','flags'], {
      metadata:{ operation:family, p5Boundary:'p5-2-memory-addressing' },
    });
  }

  if (MOVES.has(family)) {
    if (destination?.type !== 'register' || !source || !registerOrImmediate(source)) {
      return ctx.partial('x86-mov-operand-shape-unmodelled', ['registers']);
    }
    const value = ctx.readOperand(source, destination.widthBits);
    if (!value || !ctx.writeRegister(destination, value)) return ctx.partial('x86-mov-register-view-unmodelled', ['registers']);
    return ctx.finish({ family:'integer', metadata:{ operation:family, widthBits:destination.widthBits } });
  }

  if (EXTENDS.has(family)) {
    if (destination?.type !== 'register' || source?.type !== 'register' || !supportedWidth(destination.widthBits) || !supportedWidth(source.widthBits)
      || destination.widthBits <= source.widthBits
      || (family === 'movsxd' && (source.widthBits !== 32 || destination.widthBits !== 64))) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers']);
    }
    const raw = ctx.readOperand(source, source.widthBits);
    if (!raw) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers']);
    const extended = ctx.coerce(raw, source.widthBits, destination.widthBits, EXTENDS.get(family));
    if (!ctx.writeRegister(destination, extended)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers']);
    return ctx.finish({ family:'integer', metadata:{ operation:family, fromBits:source.widthBits, toBits:destination.widthBits } });
  }

  if (ARITHMETIC.has(family)) {
    if (destination?.type !== 'register' || !source || !registerOrImmediate(source) || !supportedWidth(destination.widthBits)) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    }
    const left = ctx.readRegister(destination);
    const right = ctx.readOperand(source, destination.widthBits);
    if (!left || !right) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers','flags']);
    let carryIn = null;
    const inputs = [left,right];
    if (family === 'adc' || family === 'sbb') {
      carryIn = ctx.readFlag('CF');
      inputs.push(carryIn);
    }
    const result = ctx.valueOp(family, inputs, destination.widthBits, {
      widthBits:destination.widthBits,
      carryInput:carryIn != null,
      semantic:family === 'adc' ? 'left + right + CF' : family === 'sbb' ? 'left - (right + CF)' : family,
    });
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    emitX86ArithmeticFlags(ctx, family, left, right, result, destination.widthBits, { carryIn });
    return ctx.finish({ family:'integer', metadata:{ operation:family, widthBits:destination.widthBits, carryDependency:carryIn != null } });
  }

  if (UNARY_ARITHMETIC.has(family)) {
    if (destination?.type !== 'register' || !supportedWidth(destination.widthBits)) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    }
    const sourceValue = ctx.readRegister(destination);
    if (!sourceValue) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers','flags']);
    let result;
    if (family === 'inc' || family === 'dec') {
      result = ctx.valueOp(family === 'inc' ? 'add' : 'sub', [sourceValue,ctx.constant(destination.widthBits,1n)], destination.widthBits, {
        widthBits:destination.widthBits,
        semantic:family,
      });
    } else {
      result = ctx.valueOp('neg', [sourceValue], destination.widthBits, { widthBits:destination.widthBits });
    }
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    if (family === 'inc' || family === 'dec') emitX86IncDecFlags(ctx, family, sourceValue, result, destination.widthBits);
    else emitX86NegFlags(ctx, sourceValue, result, destination.widthBits);
    return ctx.finish({ family:'integer', metadata:{ operation:family, widthBits:destination.widthBits, cfPreserved:family !== 'neg' } });
  }

  if (LOGICAL.has(family)) {
    if (destination?.type !== 'register' || !source || !registerOrImmediate(source) || !supportedWidth(destination.widthBits)) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    }
    const left = ctx.readRegister(destination);
    const right = ctx.readOperand(source, destination.widthBits);
    if (!left || !right) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers','flags']);
    const result = ctx.valueOp(family, [left,right], destination.widthBits, { widthBits:destination.widthBits });
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    emitX86LogicalFlags(ctx, family, left, right, result, destination.widthBits);
    return ctx.finish({ family:'integer', metadata:{ operation:family, widthBits:destination.widthBits } });
  }

  if (family === 'not') {
    if (destination?.type !== 'register' || !supportedWidth(destination.widthBits)) return ctx.partial('x86-not-operand-shape-unmodelled', ['registers']);
    const value = ctx.readRegister(destination);
    if (!value) return ctx.partial('x86-not-source-unmodelled', ['registers']);
    const result = ctx.valueOp('not', [value], destination.widthBits, { widthBits:destination.widthBits });
    if (!ctx.writeRegister(destination, result)) return ctx.partial('x86-not-destination-unmodelled', ['registers']);
    return ctx.finish({ family:'integer', metadata:{ operation:'not', widthBits:destination.widthBits, flagsModified:false } });
  }

  if (family === 'cmp' || family === 'test') {
    if (destination?.type !== 'register' || !source || !registerOrImmediate(source) || !supportedWidth(destination.widthBits)) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    }
    const left = ctx.readOperand(destination, destination.widthBits);
    const right = ctx.readOperand(source, destination.widthBits);
    if (!left || !right) return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    const result = ctx.valueOp(family === 'cmp' ? 'sub' : 'and', [left,right], destination.widthBits, {
      compareOnly:true,
      widthBits:destination.widthBits,
    });
    if (family === 'cmp') emitX86ArithmeticFlags(ctx, family, left, right, result, destination.widthBits);
    else emitX86LogicalFlags(ctx, family, left, right, result, destination.widthBits);
    return ctx.finish({ family:'flags', metadata:{ operation:family, destinationWrite:false, widthBits:destination.widthBits } });
  }

  if (SHIFTS.has(family) || ROTATES.has(family)) {
    const rotate = ROTATES.has(family);
    const operation = canonicalShift(family);
    if (destination?.type !== 'register' || !source || !supportedWidth(destination.widthBits)) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    }
    const count = effectiveCount(ctx, source, destination.widthBits, { rotate });
    if (!count) return ctx.partial(`x86-${family}-count-source-unmodelled`, ['registers','flags']);
    if (count.knownCount === 0) {
      return ctx.finish({
        family:'integer',
        statePreservation:{ proven:true, reason:`x86-${family}-zero-effective-count-preserves-destination-and-flags` },
        metadata:{ operation:family, widthBits:destination.widthBits, effectiveCount:0 },
      });
    }
    const value = ctx.readRegister(destination);
    if (!value) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers','flags']);
    const [result] = ctx.intrinsic(`x86.integer.${operation}`, [value,count.value], [destination.widthBits], {
      determinism:'input-dependent',
      symbolicDetail:'summary-only',
      metadata:{
        operation,
        widthBits:destination.widthBits,
        effectiveCountMask:Number(maskForCount(destination.widthBits)),
        ...(rotate ? { effectiveCountModuloWidth:destination.widthBits } : {}),
        exactArchitecturalSummary:true,
      },
    });
    if (count.knownCount == null) {
      const zero = ctx.valueOp('is-zero', [count.value], 1, { widthBits:8, semantic:'x86-effective-count-zero' });
      const nonzero = ctx.valueOp('not-bool', [zero], 1, { semantic:'x86-effective-count-nonzero' });
      if (!writeConditionalRegister(ctx, destination, nonzero, result)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    } else if (!ctx.writeRegister(destination, result)) {
      return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    }
    if (rotate) emitX86RotateFlags(ctx, operation, result, count.value, destination.widthBits, { knownCount:count.knownCount });
    else emitX86ShiftFlags(ctx, operation, value, result, count.value, destination.widthBits, { knownCount:count.knownCount });
    return ctx.finish({
      family:'integer',
      metadata:{ operation, widthBits:destination.widthBits, effectiveCount:count.knownCount, countSource:source.type },
    });
  }

  if (MULTIPLY.has(family)) {
    const signed = family === 'imul';
    if (ctx.operands.length === 1) {
      const operand = destination;
      const widthBits = Number(operand?.widthBits);
      const registers = implicitMultiplyRegisters(widthBits);
      if (!registers || operand?.type !== 'register') return ctx.partial(`x86-${family}-implicit-form-unmodelled`, ['registers','flags']);
      const accumulator = ctx.readRegister(x86RegisterOperand(registers.accumulator));
      const multiplier = ctx.readOperand(operand, widthBits);
      if (!accumulator || !multiplier) return ctx.partial(`x86-${family}-implicit-source-unmodelled`, ['registers','flags']);
      if (widthBits === 8) {
        const [product,overflow] = ctx.intrinsic(`x86.integer.${family}.implicit`, [accumulator,multiplier], [16,1], {
          determinism:'input-dependent', symbolicDetail:'summary-only',
          metadata:{ signed, operandWidthBits:8, productWidthBits:16, implicitAccumulator:'al', destination:'ax', exactArchitecturalSummary:true },
        });
        if (!ctx.writeRegister(x86RegisterOperand(registers.combined), product)) return ctx.partial(`x86-${family}-implicit-destination-unmodelled`, ['registers','flags']);
        emitX86MultiplyFlags(ctx, family, overflow, 8);
      } else {
        const [low,high,overflow] = ctx.intrinsic(`x86.integer.${family}.implicit`, [accumulator,multiplier], [widthBits,widthBits,1], {
          determinism:'input-dependent', symbolicDetail:'summary-only',
          metadata:{ signed, operandWidthBits:widthBits, productWidthBits:widthBits * 2, implicitAccumulator:registers.accumulator, highDestination:registers.high, exactArchitecturalSummary:true },
        });
        if (!ctx.writeRegister(x86RegisterOperand(registers.accumulator), low) || !ctx.writeRegister(x86RegisterOperand(registers.high), high)) {
          return ctx.partial(`x86-${family}-implicit-destination-unmodelled`, ['registers','flags']);
        }
        emitX86MultiplyFlags(ctx, family, overflow, widthBits);
      }
      return ctx.finish({ family:'integer', metadata:{ operation:family, form:'one-operand-implicit', signed, widthBits } });
    }

    if (family !== 'imul' || (ctx.operands.length !== 2 && ctx.operands.length !== 3)) {
      return ctx.partial(`x86-${family}-operand-count-unmodelled`, ['registers','flags']);
    }
    if (destination?.type !== 'register' || ![16,32,64].includes(destination.widthBits)) return ctx.partial('x86-imul-destination-unmodelled', ['registers','flags']);
    let left;
    let right;
    let form;
    if (ctx.operands.length === 2) {
      if (source?.type !== 'register') return ctx.partial('x86-imul-two-operand-source-unmodelled', ['registers','flags']);
      left = ctx.readRegister(destination);
      right = ctx.readOperand(source, destination.widthBits, { signed:true });
      form = 'two-operand';
    } else {
      if (source?.type !== 'register' || third?.type !== 'immediate') return ctx.partial('x86-imul-three-operand-source-unmodelled', ['registers','flags']);
      left = ctx.readOperand(source, destination.widthBits, { signed:true });
      right = ctx.readOperand(third, destination.widthBits, { signed:true });
      form = 'three-operand';
    }
    if (!left || !right) return ctx.partial(`x86-imul-${form}-source-unmodelled`, ['registers','flags']);
    const [result,overflow] = ctx.intrinsic('x86.integer.imul.truncated', [left,right], [destination.widthBits,1], {
      determinism:'input-dependent', symbolicDetail:'summary-only',
      metadata:{ signed:true, form, widthBits:destination.widthBits, overflowRule:'full product != sign-extension of truncated destination', exactArchitecturalSummary:true },
    });
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-imul-${form}-destination-unmodelled`, ['registers','flags']);
    emitX86MultiplyFlags(ctx, 'imul', overflow, destination.widthBits);
    return ctx.finish({ family:'integer', metadata:{ operation:'imul', form, signed:true, widthBits:destination.widthBits } });
  }

  if (DIVIDE.has(family)) {
    const divisorOperand = destination;
    const widthBits = Number(divisorOperand?.widthBits);
    const registers = implicitDivideRegisters(widthBits);
    if (ctx.operands.length !== 1 || !registers || divisorOperand?.type !== 'register') {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags','faults']);
    }
    const divisor = ctx.readOperand(divisorOperand, widthBits);
    if (!divisor) return ctx.partial(`x86-${family}-divisor-unmodelled`, ['registers','flags','faults']);
    let dividend;
    if (widthBits === 8) {
      dividend = ctx.readRegister(x86RegisterOperand(registers.dividend));
    } else {
      const low = ctx.readRegister(x86RegisterOperand(registers.low));
      const high = ctx.readRegister(x86RegisterOperand(registers.high));
      if (!low || !high) return ctx.partial(`x86-${family}-implicit-dividend-unmodelled`, ['registers','flags','faults']);
      dividend = ctx.valueOp('concat', [high,low], widthBits * 2, {
        high:registers.high,
        low:registers.low,
        semantic:'x86-implicit-dividend',
      });
    }
    if (!dividend) return ctx.partial(`x86-${family}-implicit-dividend-unmodelled`, ['registers','flags','faults']);
    const [quotient,remainder] = ctx.intrinsic(`x86.integer.${family}`, [dividend,divisor], [widthBits,widthBits], {
      determinism:'input-dependent', symbolicDetail:'summary-only',
      metadata:{ signed:family === 'idiv', dividendWidthBits:widthBits * 2, divisorWidthBits:widthBits, quotientWidthBits:widthBits, exactArchitecturalSummary:true },
    });
    if (widthBits === 8) {
      const combined = ctx.valueOp('concat', [remainder,quotient], 16, { high:'ah', low:'al', semantic:'x86-div-result-ax' });
      if (!ctx.writeRegister(x86RegisterOperand(registers.combinedResult), combined)) return ctx.partial(`x86-${family}-result-registers-unmodelled`, ['registers','flags']);
    } else if (!ctx.writeRegister(x86RegisterOperand(registers.quotient), quotient) || !ctx.writeRegister(x86RegisterOperand(registers.remainder), remainder)) {
      return ctx.partial(`x86-${family}-result-registers-unmodelled`, ['registers','flags']);
    }
    emitX86DivisionUndefinedFlags(ctx, family, widthBits);
    return ctx.finish({
      family:'integer',
      possibleFaults:[divisionFault(family, divisor, dividend, widthBits)],
      metadata:{ operation:family, form:'implicit-dividend-pair', signed:family === 'idiv', widthBits },
    });
  }

  if (family.startsWith('set')) {
    const code = ctx.instruction.detail.conditionCode ?? family.slice(3);
    if (destination?.type !== 'register' || destination.widthBits !== 8 || ctx.operands.length !== 1) {
      return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    }
    const condition = emitX86Condition(ctx, code);
    if (!condition) return ctx.partial(`x86-${family}-condition-unmodelled`, ['registers','flags']);
    const value = ctx.coerce(condition, 1, 8, false);
    if (!ctx.writeRegister(destination, value)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    return ctx.finish({ family:'integer', metadata:{ operation:family, conditionCode:code, flagsModified:false, materializedBits:8 } });
  }

  if (family.startsWith('cmov')) {
    const code = ctx.instruction.detail.conditionCode ?? family.slice(4);
    if (destination?.type !== 'register' || source?.type !== 'register' || ctx.operands.length !== 2 || ![16,32,64].includes(destination.widthBits)) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    }
    const condition = emitX86Condition(ctx, code);
    const sourceValue = ctx.readOperand(source, destination.widthBits);
    if (!condition || !sourceValue) return ctx.partial(`x86-${family}-condition-or-source-unmodelled`, ['registers','flags']);
    if (!writeConditionalRegister(ctx, destination, condition, sourceValue)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    return ctx.finish({
      family:'integer',
      metadata:{ operation:family, conditionCode:code, conditionalDestinationWrite:true, falsePathPreservesPhysicalRegister:true, flagsModified:false },
    });
  }

  return null;
}

export function liftX86LeaEffects(instruction, context = {}) {
  if (String(instruction?.instructionFamily || '').toLowerCase() !== 'lea') return null;
  const ctx = createX86EffectContext(instruction, context);
  const [destination, source] = ctx.operands;
  if (destination?.type !== 'register' || source?.type !== 'memory') return ctx.partial('x86-lea-operand-shape-unmodelled', ['registers','other']);
  const address = materializeX86Address(ctx, source);
  if (!address || !ctx.writeRegister(destination, address)) return ctx.partial('x86-lea-address-unmodelled', ['registers','other']);
  return ctx.finish({ family:'integer', metadata:{ operation:'lea', semanticMemoryAccess:false, address:source.memory } });
}
