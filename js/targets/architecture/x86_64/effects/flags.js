const ARITHMETIC_FLAGS = Object.freeze(['CF','PF','AF','ZF','SF','OF']);
const DEFINED_RESULT_FLAGS = Object.freeze(['PF','ZF','SF']);
const X86_INTEGER_WIDTHS = new Set([8,16,32,64]);

const CONDITION_ALIASES = Object.freeze({
  e:'e', z:'e',
  ne:'ne', nz:'ne',
  a:'a', nbe:'a',
  ae:'ae', nb:'ae', nc:'ae',
  b:'b', c:'b', nae:'b',
  be:'be', na:'be',
  g:'g', nle:'g',
  ge:'ge', nl:'ge',
  l:'l', nge:'l',
  le:'le', ng:'le',
  s:'s', ns:'ns',
  o:'o', no:'no',
  p:'p', pe:'p',
  np:'np', po:'np',
});

function normalizeWidth(widthBits) {
  const width = Number(widthBits);
  if (!X86_INTEGER_WIDTHS.has(width)) throw new TypeError('x86-flags-invalid-width');
  return width;
}

function bitMask(widthBits) { return (1n << BigInt(widthBits)) - 1n; }
function asUnsigned(value, widthBits) { return BigInt(value) & bitMask(widthBits); }
function asSigned(value, widthBits) {
  const width = BigInt(widthBits);
  const unsigned = asUnsigned(value, widthBits);
  const sign = 1n << (width - 1n);
  return (unsigned & sign) === 0n ? unsigned : unsigned - (1n << width);
}
function bool(value) { return value ? 1 : 0; }
function parityEvenLowByte(value) {
  let byte = Number(BigInt(value) & 0xffn);
  let ones = 0;
  for (let bit = 0; bit < 8; bit++) {
    ones += byte & 1;
    byte >>>= 1;
  }
  return (ones & 1) === 0 ? 1 : 0;
}
function resultFlags(result, widthBits) {
  const unsigned = asUnsigned(result, widthBits);
  const sign = 1n << BigInt(widthBits - 1);
  return {
    PF:parityEvenLowByte(unsigned),
    ZF:bool(unsigned === 0n),
    SF:bool((unsigned & sign) !== 0n),
  };
}

export function canonicalX86ConditionCode(conditionCode) {
  const code = String(conditionCode ?? '').trim().toLowerCase();
  return CONDITION_ALIASES[code] ?? null;
}

export function evaluateX86ArithmeticFlags(operation, left, right, widthBits, { carryIn = 0 } = {}) {
  const width = normalizeWidth(widthBits);
  const op = String(operation || '').toLowerCase();
  const mask = bitMask(width);
  const sign = 1n << BigInt(width - 1);
  const minimum = -sign;
  const maximum = sign - 1n;
  const a = asUnsigned(left, width);
  const b = asUnsigned(right ?? 0n, width);
  const carry = BigInt(carryIn ? 1 : 0);

  if (op === 'neg') {
    const result = (-a) & mask;
    return Object.freeze({
      result,
      CF:bool(a !== 0n),
      ...resultFlags(result, width),
      AF:bool((a & 0xfn) !== 0n),
      OF:bool(a === sign),
    });
  }

  if (op === 'inc' || op === 'dec') {
    const base = evaluateX86ArithmeticFlags(op === 'inc' ? 'add' : 'sub', a, 1n, width);
    return Object.freeze({ ...base, CF:'unchanged' });
  }

  if (op === 'add' || op === 'adc') {
    const cin = op === 'adc' ? carry : 0n;
    const full = a + b + cin;
    const result = full & mask;
    const signedMath = asSigned(a, width) + asSigned(b, width) + cin;
    return Object.freeze({
      result,
      CF:bool(full > mask),
      ...resultFlags(result, width),
      AF:bool((a & 0xfn) + (b & 0xfn) + cin > 0xfn),
      OF:bool(signedMath < minimum || signedMath > maximum),
    });
  }

  if (op === 'sub' || op === 'sbb' || op === 'cmp') {
    const borrow = op === 'sbb' ? carry : 0n;
    const subtrahend = b + borrow;
    const result = (a - subtrahend) & mask;
    const signedMath = asSigned(a, width) - asSigned(b, width) - borrow;
    return Object.freeze({
      result,
      CF:bool(a < subtrahend),
      ...resultFlags(result, width),
      AF:bool((a & 0xfn) < ((b & 0xfn) + borrow)),
      OF:bool(signedMath < minimum || signedMath > maximum),
    });
  }

  throw new TypeError('x86-flags-unsupported-arithmetic-operation');
}

export function evaluateX86LogicalFlags(result, widthBits) {
  const width = normalizeWidth(widthBits);
  return Object.freeze({
    CF:0,
    ...resultFlags(result, width),
    AF:'undefined',
    OF:0,
  });
}

export function evaluateX86Condition(flags, conditionCode) {
  const code = canonicalX86ConditionCode(conditionCode);
  if (!code) throw new TypeError('x86-flags-invalid-condition');
  const read = (name) => !!flags?.[name];
  switch (code) {
    case 'e': return read('ZF');
    case 'ne': return !read('ZF');
    case 'a': return !read('CF') && !read('ZF');
    case 'ae': return !read('CF');
    case 'b': return read('CF');
    case 'be': return read('CF') || read('ZF');
    case 'g': return !read('ZF') && read('SF') === read('OF');
    case 'ge': return read('SF') === read('OF');
    case 'l': return read('SF') !== read('OF');
    case 'le': return read('ZF') || read('SF') !== read('OF');
    case 's': return read('SF');
    case 'ns': return !read('SF');
    case 'o': return read('OF');
    case 'no': return !read('OF');
    case 'p': return read('PF');
    case 'np': return !read('PF');
    default: throw new TypeError('x86-flags-invalid-condition');
  }
}

function undefinedFlag(ctx, flag, operation, widthBits, metadata = {}) {
  const [value] = ctx.intrinsic(`x86.flag.undefined.${flag.toLowerCase()}`, [], [1], {
    determinism:'nondeterministic',
    symbolicDetail:'summary-only',
    metadata:{
      flag,
      operation,
      widthBits,
      definedness:'undefined',
      semanticRule:'architecturally-undefined-value',
      ...metadata,
    },
  });
  ctx.writeFlag(flag, value, { operation, widthBits, definedness:'undefined' });
}

export function emitX86UndefinedFlags(ctx, flags, operation, widthBits, metadata = {}) {
  for (const flag of flags) undefinedFlag(ctx, flag, operation, widthBits, metadata);
}

function emitResultFlags(ctx, operation, result, widthBits) {
  const [PF,ZF,SF] = ctx.intrinsic('x86.flags.result-pzs', [result], [1,1,1], {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{
      flags:DEFINED_RESULT_FLAGS,
      operation,
      widthBits,
      exactArchitecturalSummary:true,
      semanticRules:Object.freeze({
        PF:'even parity of result[7:0]',
        ZF:'result == 0',
        SF:'most-significant result bit',
      }),
    },
  });
  for (const [flag,value] of [['PF',PF],['ZF',ZF],['SF',SF]]) {
    ctx.writeFlag(flag, value, { operation, widthBits, definedness:'defined' });
  }
  return { PF,ZF,SF };
}

export function emitX86ArithmeticFlags(ctx, operation, left, right, result, widthBits, { carryIn = null } = {}) {
  const op = String(operation || '').toLowerCase();
  const inputs = carryIn == null ? [left,right,result] : [left,right,carryIn,result];
  const outputs = ctx.intrinsic(`x86.flags.${op}`, inputs, ARITHMETIC_FLAGS.map(() => 1), {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{
      flags:ARITHMETIC_FLAGS,
      widthBits,
      carryInput:carryIn != null,
      defined:Object.freeze([...ARITHMETIC_FLAGS]),
      unchanged:Object.freeze([]),
      undefined:Object.freeze([]),
      exactArchitecturalSummary:true,
      semanticModel:'intel-x86-add-sub-flags/v1',
      semanticRules:Object.freeze({
        result:'modulo 2^width arithmetic result',
        CF:op === 'add' || op === 'adc' ? 'unsigned carry out' : 'unsigned borrow out',
        PF:'even parity of result[7:0]',
        AF:op === 'add' || op === 'adc' ? 'carry out of bit 3' : 'borrow out of bit 3',
        ZF:'result == 0',
        SF:'most-significant result bit',
        OF:'signed result is outside the destination-width signed range',
      }),
    },
  });
  ARITHMETIC_FLAGS.forEach((flag, index) => ctx.writeFlag(flag, outputs[index], { operation:op, widthBits, definedness:'defined' }));
}

export function emitX86IncDecFlags(ctx, operation, left, result, widthBits) {
  const flags = Object.freeze(['PF','AF','ZF','SF','OF']);
  const outputs = ctx.intrinsic(`x86.flags.${operation}`, [left,result], flags.map(() => 1), {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{
      flags,
      widthBits,
      defined:flags,
      unchanged:Object.freeze(['CF']),
      undefined:Object.freeze([]),
      exactArchitecturalSummary:true,
      semanticModel:'intel-x86-inc-dec-flags/v1',
    },
  });
  flags.forEach((flag, index) => ctx.writeFlag(flag, outputs[index], { operation, widthBits, definedness:'defined' }));
}

export function emitX86NegFlags(ctx, source, result, widthBits) {
  const outputs = ctx.intrinsic('x86.flags.neg', [source,result], ARITHMETIC_FLAGS.map(() => 1), {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{
      flags:ARITHMETIC_FLAGS,
      widthBits,
      defined:Object.freeze([...ARITHMETIC_FLAGS]),
      unchanged:Object.freeze([]),
      undefined:Object.freeze([]),
      exactArchitecturalSummary:true,
      semanticModel:'intel-x86-neg-flags/v1',
      semanticRules:Object.freeze({
        CF:'0 iff source == 0, otherwise 1',
        OF:'1 iff source is the signed minimum value',
        AF:'borrow out of bit 3 from 0 - source',
        PF:'even parity of result[7:0]',
        ZF:'result == 0',
        SF:'most-significant result bit',
      }),
    },
  });
  ARITHMETIC_FLAGS.forEach((flag, index) => ctx.writeFlag(flag, outputs[index], { operation:'neg', widthBits, definedness:'defined' }));
}

export function emitX86LogicalFlags(ctx, operation, left, right, result, widthBits) {
  ctx.writeFlag('CF', ctx.constant(1,0n), { operation, widthBits, definedness:'fixed', fixedValue:0 });
  ctx.writeFlag('OF', ctx.constant(1,0n), { operation, widthBits, definedness:'fixed', fixedValue:0 });
  emitResultFlags(ctx, operation, result, widthBits);
  undefinedFlag(ctx, 'AF', operation, widthBits, {
    inputsPresent:Object.freeze([left != null, right != null]),
  });
}

function parityFlagValue(ctx, result, operation, widthBits) {
  return ctx.intrinsic('x86.flags.parity-low-byte', [result], [1], {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{ operation, widthBits, semanticRule:'even parity of result[7:0]', exactArchitecturalSummary:true },
  })[0];
}

function boolNot(ctx, value) { return ctx.valueOp('not-bool', [value], 1); }
function boolAnd(ctx, left, right) { return ctx.valueOp('and-bool', [left,right], 1); }
function boolOr(ctx, left, right) { return ctx.valueOp('or-bool', [left,right], 1); }
function boolEqual(ctx, left, right) { return ctx.valueOp('equal-bool', [left,right], 1); }
function boolXor(ctx, left, right) { return ctx.valueOp('xor-bool', [left,right], 1); }
function bit(ctx, value, index, widthBits) { return ctx.valueOp('extract-bit', [value], 1, { bit:index, widthBits }); }

export function emitX86Condition(ctx, conditionCode) {
  const code = canonicalX86ConditionCode(conditionCode);
  if (!code) return null;
  const read = (name) => ctx.readFlag(name);
  switch (code) {
    case 'e': return read('ZF');
    case 'ne': return boolNot(ctx, read('ZF'));
    case 'a': return boolAnd(ctx, boolNot(ctx, read('CF')), boolNot(ctx, read('ZF')));
    case 'ae': return boolNot(ctx, read('CF'));
    case 'b': return read('CF');
    case 'be': return boolOr(ctx, read('CF'), read('ZF'));
    case 'g': return boolAnd(ctx, boolNot(ctx, read('ZF')), boolEqual(ctx, read('SF'), read('OF')));
    case 'ge': return boolEqual(ctx, read('SF'), read('OF'));
    case 'l': return boolNot(ctx, boolEqual(ctx, read('SF'), read('OF')));
    case 'le': return boolOr(ctx, read('ZF'), boolNot(ctx, boolEqual(ctx, read('SF'), read('OF'))));
    case 's': return read('SF');
    case 'ns': return boolNot(ctx, read('SF'));
    case 'o': return read('OF');
    case 'no': return boolNot(ctx, read('OF'));
    case 'p': return read('PF');
    case 'np': return boolNot(ctx, read('PF'));
    default: return null;
  }
}

export function emitX86ShiftFlags(ctx, operation, source, result, effectiveCount, widthBits, { knownCount = null } = {}) {
  const op = operation === 'sal' ? 'shl' : operation;
  if (!['shl','shr','sar'].includes(op)) throw new TypeError('x86-flags-invalid-shift-operation');

  if (knownCount == null) {
    const zero = ctx.valueOp('is-zero', [effectiveCount], 1, { widthBits:8, semantic:'effective-shift-count-zero' });
    const calculatedPF = parityFlagValue(ctx, result, op, widthBits);
    const calculatedZF = ctx.valueOp('is-zero', [result], 1, { widthBits });
    const calculatedSF = bit(ctx, result, widthBits - 1, widthBits);
    for (const [flag,calculated] of [['PF',calculatedPF],['ZF',calculatedZF],['SF',calculatedSF]]) {
      const old = ctx.readFlag(flag);
      const finalValue = ctx.valueOp('select', [zero,old,calculated], 1, { condition:'effective-count-zero', flag });
      ctx.writeFlag(flag, finalValue, { operation:op, widthBits, definedness:'count-dependent' });
    }

    const oldCF = ctx.readFlag('CF');
    const [finalCF] = ctx.intrinsic('x86.flags.shift-cf', [source,result,effectiveCount,oldCF], [1], {
      determinism:op === 'sar' || widthBits >= 32 ? 'input-dependent' : 'nondeterministic',
      symbolicDetail:'summary-only',
      metadata:{
        operation:op,
        widthBits,
        semanticRules:Object.freeze({
          zero:'unchanged',
          nonzero:'last bit shifted out',
          undefined:op === 'sar' ? 'none' : 'effective count >= operand width',
        }),
        exactArchitecturalSummary:true,
      },
    });
    ctx.writeFlag('CF', finalCF, { operation:op, widthBits, definedness:'count-dependent' });

    const oldAF = ctx.readFlag('AF');
    const [finalAF] = ctx.intrinsic('x86.flags.shift-af', [effectiveCount,oldAF], [1], {
      determinism:'nondeterministic',
      symbolicDetail:'summary-only',
      metadata:{ operation:op, widthBits, semanticRules:Object.freeze({ zero:'unchanged', nonzero:'undefined' }), exactArchitecturalSummary:true },
    });
    ctx.writeFlag('AF', finalAF, { operation:op, widthBits, definedness:'count-dependent' });

    const oldOF = ctx.readFlag('OF');
    const [finalOF] = ctx.intrinsic('x86.flags.shift-of', [source,result,effectiveCount,oldOF], [1], {
      determinism:'nondeterministic',
      symbolicDetail:'summary-only',
      metadata:{
        operation:op,
        widthBits,
        semanticRules:Object.freeze({
          zero:'unchanged',
          one:op === 'shl' ? 'MSB(result) XOR CF' : op === 'shr' ? 'original MSB' : '0',
          greaterThanOne:'undefined',
        }),
        exactArchitecturalSummary:true,
      },
    });
    ctx.writeFlag('OF', finalOF, { operation:op, widthBits, definedness:'count-dependent' });
    return;
  }

  if (knownCount <= 0) throw new TypeError('x86-flags-shift-known-count-must-be-nonzero');
  emitResultFlags(ctx, op, result, widthBits);
  undefinedFlag(ctx, 'AF', op, widthBits, { effectiveCount:knownCount });

  let cf;
  if ((op === 'shl' || op === 'shr') && knownCount >= widthBits) {
    undefinedFlag(ctx, 'CF', op, widthBits, { effectiveCount:knownCount, reason:'count-at-least-width' });
  } else {
    if (op === 'shl') cf = bit(ctx, source, widthBits - knownCount, widthBits);
    else if (op === 'shr') cf = bit(ctx, source, knownCount - 1, widthBits);
    else cf = bit(ctx, source, Math.min(knownCount, widthBits) - 1, widthBits);
    ctx.writeFlag('CF', cf, { operation:op, widthBits, definedness:'defined', effectiveCount:knownCount });
  }

  if (knownCount === 1) {
    let of;
    if (op === 'shl') of = boolXor(ctx, bit(ctx, result, widthBits - 1, widthBits), cf);
    else if (op === 'shr') of = bit(ctx, source, widthBits - 1, widthBits);
    else of = ctx.constant(1,0n);
    ctx.writeFlag('OF', of, { operation:op, widthBits, definedness:'defined', effectiveCount:knownCount });
  } else {
    undefinedFlag(ctx, 'OF', op, widthBits, { effectiveCount:knownCount });
  }
}

export function emitX86RotateFlags(ctx, operation, result, effectiveCount, widthBits, { knownCount = null } = {}) {
  const op = String(operation || '').toLowerCase();
  if (!['rol','ror'].includes(op)) throw new TypeError('x86-flags-invalid-rotate-operation');
  const calculatedCF = op === 'rol' ? bit(ctx, result, 0, widthBits) : bit(ctx, result, widthBits - 1, widthBits);

  if (knownCount == null) {
    const zero = ctx.valueOp('is-zero', [effectiveCount], 1, { widthBits:8, semantic:'effective-rotate-count-zero' });
    const oldCF = ctx.readFlag('CF');
    const finalCF = ctx.valueOp('select', [zero,oldCF,calculatedCF], 1, { condition:'effective-count-zero', flag:'CF' });
    ctx.writeFlag('CF', finalCF, { operation:op, widthBits, definedness:'count-dependent' });
    const oldOF = ctx.readFlag('OF');
    const [finalOF] = ctx.intrinsic('x86.flags.rotate-of', [result,effectiveCount,oldOF], [1], {
      determinism:'nondeterministic',
      symbolicDetail:'summary-only',
      metadata:{
        operation:op,
        widthBits,
        semanticRules:Object.freeze({
          zero:'unchanged',
          one:op === 'rol' ? 'MSB(result) XOR CF' : 'MSB(result) XOR next-MSB(result)',
          greaterThanOne:'undefined',
        }),
        exactArchitecturalSummary:true,
      },
    });
    ctx.writeFlag('OF', finalOF, { operation:op, widthBits, definedness:'count-dependent' });
    return;
  }

  if (knownCount <= 0) throw new TypeError('x86-flags-rotate-known-count-must-be-nonzero');
  ctx.writeFlag('CF', calculatedCF, { operation:op, widthBits, definedness:'defined', effectiveCount:knownCount });
  if (knownCount === 1) {
    const of = op === 'rol'
      ? boolXor(ctx, bit(ctx, result, widthBits - 1, widthBits), calculatedCF)
      : boolXor(ctx, bit(ctx, result, widthBits - 1, widthBits), bit(ctx, result, widthBits - 2, widthBits));
    ctx.writeFlag('OF', of, { operation:op, widthBits, definedness:'defined', effectiveCount:knownCount });
  } else {
    undefinedFlag(ctx, 'OF', op, widthBits, { effectiveCount:knownCount });
  }
}

export function emitX86MultiplyFlags(ctx, operation, overflow, widthBits) {
  ctx.writeFlag('CF', overflow, { operation, widthBits, definedness:'defined', semanticRule:'upper product is not the required zero/sign extension of the low half' });
  ctx.writeFlag('OF', overflow, { operation, widthBits, definedness:'defined', semanticRule:'same value as CF' });
  emitX86UndefinedFlags(ctx, ['PF','AF','ZF','SF'], operation, widthBits);
}

export function emitX86DivisionUndefinedFlags(ctx, operation, widthBits) {
  emitX86UndefinedFlags(ctx, ARITHMETIC_FLAGS, operation, widthBits);
}
