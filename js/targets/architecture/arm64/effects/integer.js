import {
  asUnsigned,
  bitMask,
  createArm64EffectContext,
  immediateOf,
  instructionBits,
  rotateRight,
} from './common.js';
import {
  emitArm64AddSub,
  emitArm64Condition,
  emitArm64LogicalFlags,
  writeArm64NZCV,
} from './flags.js';

export const ARM64_INTEGER_EFFECT_MNEMONICS = Object.freeze(new Set([
  'add','adds','sub','subs','adc','adcs','sbc','sbcs','neg','negs','ngc','ngcs',
  'and','ands','orr','eor','bic','bics','orn','eon','mvn',
  'lsl','lslv','lsr','lsrv','asr','asrv','ror','rorv',
  'mul','mneg','smull','umull','smulh','umulh','sdiv','udiv',
  'madd','msub','smaddl','smsubl','umaddl','umsubl',
  'mov','movz','movn','movk','adr','adrp',
  'ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi','bfc','ubfm','sbfm','bfm','extr',
  'sxtb','sxth','sxtw','uxtb','uxth','uxtw','clz','rbit','rev','rev16','rev32','abs',
  'csel','csinc','csinv','csneg','cset','csetm','cinc','cneg','cinv',
]));

function highestSetBit(value) {
  for (let bit = 6; bit >= 0; bit--) if ((value & (1 << bit)) !== 0) return bit;
  return -1;
}

function replicateElement(element, elementBits, widthBits) {
  let result = 0n;
  const part = asUnsigned(element, elementBits);
  for (let offset = 0; offset < widthBits; offset += elementBits) result |= part << BigInt(offset);
  return asUnsigned(result, widthBits);
}

export function decodeArm64BitMasks(widthBits, immrValue, immsValue) {
  if (widthBits !== 32 && widthBits !== 64) return null;
  const immr = Number(immrValue);
  const imms = Number(immsValue);
  if (!Number.isInteger(immr) || !Number.isInteger(imms) || immr < 0 || imms < 0 || immr > 63 || imms > 63) return null;
  if (widthBits === 32 && (immr >= 32 || imms >= 32)) return null;
  const N = widthBits === 64 ? 1 : 0;
  const concatenated = (N << 6) | ((~imms) & 0x3f);
  const len = highestSetBit(concatenated);
  if (len < 1) return null;
  const levels = (1 << len) - 1;
  const S = imms & levels;
  const R = immr & levels;
  const diff = (S - R) & levels;
  const elementBits = 1 << len;
  if (elementBits > widthBits) return null;
  const welem = (1n << BigInt(S + 1)) - 1n;
  const telem = (1n << BigInt(diff + 1)) - 1n;
  const wmask = replicateElement(rotateRight(welem, R, elementBits), elementBits, widthBits);
  const tmask = replicateElement(telem, elementBits, widthBits);
  return Object.freeze({ widthBits, immr, imms, R, S, elementBits, wmask, tmask });
}

export function evaluateArm64Bitfield(kind, source, destination, widthBits, immrValue, immsValue) {
  const decoded = decodeArm64BitMasks(widthBits, immrValue, immsValue);
  if (!decoded) throw new TypeError('arm64-bitfield-invalid-immediates');
  const src = asUnsigned(source, widthBits);
  const dst = asUnsigned(destination ?? 0n, widthBits);
  const rotated = rotateRight(src, decoded.R, widthBits);
  const botSource = rotated & decoded.wmask;
  if (kind === 'ubfm') return asUnsigned(botSource & decoded.tmask, widthBits);
  if (kind === 'sbfm') {
    const sign = (src >> BigInt(decoded.S)) & 1n;
    const top = sign ? bitMask(widthBits) : 0n;
    return asUnsigned((top & ~decoded.tmask) | (botSource & decoded.tmask), widthBits);
  }
  if (kind === 'bfm') {
    const bot = (dst & ~decoded.wmask) | botSource;
    return asUnsigned((dst & ~decoded.tmask) | (bot & decoded.tmask), widthBits);
  }
  throw new TypeError('arm64-bitfield-invalid-kind');
}

function bitfieldEncodingForAlias(mnemonic, lsbValue, widthValue, widthBits) {
  const lsb = Number(lsbValue);
  const fieldWidth = Number(widthValue);
  if (!Number.isInteger(lsb) || !Number.isInteger(fieldWidth) || lsb < 0 || fieldWidth <= 0 || lsb >= widthBits || fieldWidth > widthBits) return null;
  if (mnemonic === 'ubfx' || mnemonic === 'sbfx' || mnemonic === 'bfxil') {
    if (lsb + fieldWidth > widthBits) return null;
    return { immr: lsb, imms: lsb + fieldWidth - 1 };
  }
  if (mnemonic === 'ubfiz' || mnemonic === 'sbfiz' || mnemonic === 'bfi' || mnemonic === 'bfc') {
    if (lsb + fieldWidth > widthBits) return null;
    return { immr: (-lsb) & (widthBits - 1), imms: fieldWidth - 1 };
  }
  return null;
}

function destinationBits(ops) { return instructionBits(ops?.[0]); }

function writeOrPartial(ctx, destination, value, reason, categories = ['registers']) {
  return ctx.writeRegister(destination, value)
    ? null
    : ctx.partial(reason, categories);
}

function liftAddSub(ctx, ops, mnemonic) {
  const widthBits = destinationBits(ops);
  const destination = ops[0];
  const lhsOperand = (mnemonic === 'neg' || mnemonic === 'negs' || mnemonic === 'ngc' || mnemonic === 'ngcs') ? null : ops[1];
  const rhsOperand = lhsOperand ? ops[2] : ops[1];
  const lhs = lhsOperand ? ctx.readOperand(lhsOperand, widthBits) : ctx.constant(widthBits, 0n);
  const rhs = ctx.readOperand(rhsOperand, widthBits);
  const usesCarry = ['adc','adcs','sbc','sbcs','ngc','ngcs'].includes(mnemonic);
  const subtract = ['sub','subs','sbc','sbcs','neg','negs','ngc','ngcs'].includes(mnemonic);
  const setsFlags = ['adds','subs','adcs','sbcs','negs','ngcs'].includes(mnemonic);
  const carryIn = usesCarry ? ctx.readFlag('C') : null;
  if (!lhs || !rhs || (usesCarry && !carryIn)) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, setsFlags ? ['registers','flags','other'] : ['registers','other']);
  const result = emitArm64AddSub(ctx, lhs, rhs, widthBits, { subtract, carryIn });
  const failed = writeOrPartial(ctx, destination, result.result, `arm64-${mnemonic}-destination-unmodelled`, setsFlags ? ['registers','flags'] : ['registers']);
  if (failed) return failed;
  if (setsFlags) writeArm64NZCV(ctx, result);
  return ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function liftLogical(ctx, ops, mnemonic) {
  const widthBits = destinationBits(ops);
  const destination = ops[0];
  let result;
  if (mnemonic === 'mvn') {
    const source = ctx.readOperand(ops[1], widthBits);
    if (!source) return ctx.partial('arm64-mvn-source-unmodelled', ['registers','other']);
    result = ctx.valueOp('not', [source], widthBits, { widthBits });
  } else {
    const lhs = ctx.readOperand(ops[1], widthBits);
    const rhs = ctx.readOperand(ops[2], widthBits);
    if (!lhs || !rhs) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    const complementRhs = ['bic','bics','orn','eon'].includes(mnemonic);
    const second = complementRhs ? ctx.valueOp('not', [rhs], widthBits, { widthBits }) : rhs;
    const opcode = ['and','ands','bic','bics'].includes(mnemonic) ? 'and'
      : ['orr','orn'].includes(mnemonic) ? 'or' : 'xor';
    result = ctx.valueOp(opcode, [lhs, second], widthBits, { widthBits });
  }
  const failed = writeOrPartial(ctx, destination, result, `arm64-${mnemonic}-destination-unmodelled`, ['registers']);
  if (failed) return failed;
  if (mnemonic === 'ands' || mnemonic === 'bics') writeArm64NZCV(ctx, emitArm64LogicalFlags(ctx, result, widthBits));
  return ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function liftShift(ctx, ops, mnemonic) {
  const widthBits = destinationBits(ops);
  const source = ctx.readOperand(ops[1], widthBits);
  if (!source) return ctx.partial(`arm64-${mnemonic}-source-unmodelled`, ['registers','other']);
  const variable = mnemonic.endsWith('v');
  const base = mnemonic.replace(/v$/, '');
  const opcode = base === 'lsl' ? 'shl' : base === 'lsr' ? 'lshr' : base === 'asr' ? 'ashr' : 'ror';
  let result;
  if (variable) {
    const rawAmount = ctx.readOperand(ops[2], widthBits);
    if (!rawAmount) return ctx.partial(`arm64-${mnemonic}-shift-unmodelled`, ['registers','other']);
    const amount = ctx.valueOp('and', [rawAmount, ctx.constant(widthBits, BigInt(widthBits - 1))], widthBits, { reason: 'a64-variable-shift-modulo-register-width' });
    result = ctx.valueOp(opcode, [source, amount], widthBits, { widthBits, variable: true });
  } else {
    const amount = immediateOf(ops[2]);
    if (amount == null || amount < 0n || amount >= BigInt(widthBits)) return ctx.partial(`arm64-${mnemonic}-shift-out-of-range`, ['registers','other']);
    result = ctx.valueOp(opcode, [source, ctx.constant(widthBits, amount)], widthBits, { widthBits, amount: Number(amount) });
  }
  const failed = writeOrPartial(ctx, ops[0], result, `arm64-${mnemonic}-destination-unmodelled`);
  return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function liftMultiplyDivide(ctx, ops, mnemonic) {
  const widthBits = destinationBits(ops);
  const destination = ops[0];
  const read = (index, bits = instructionBits(ops[index], widthBits)) => ctx.readOperand(ops[index], bits);
  let result = null;

  if (mnemonic === 'mul' || mnemonic === 'mneg') {
    const a = read(1, widthBits), b = read(2, widthBits);
    if (!a || !b) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    const product = ctx.valueOp('mul', [a,b], widthBits, { widthBits });
    result = mnemonic === 'mneg' ? ctx.valueOp('neg', [product], widthBits, { widthBits }) : product;
  } else if (mnemonic === 'smull' || mnemonic === 'umull') {
    const a = read(1, 32), b = read(2, 32);
    if (!a || !b || widthBits !== 64) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    const extend = mnemonic === 'smull' ? ctx.signExtend : ctx.zeroExtend;
    result = ctx.valueOp('mul', [extend(a,32,64), extend(b,32,64)], 64, { widthBits: 64, widening: mnemonic[0] === 's' ? 'signed' : 'unsigned' });
  } else if (mnemonic === 'smulh' || mnemonic === 'umulh') {
    const a = read(1,64), b = read(2,64);
    if (!a || !b || widthBits !== 64) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    result = ctx.valueOp(mnemonic === 'smulh' ? 'mul-high-signed' : 'mul-high-unsigned', [a,b], 64, { operandBits: 64, resultBits: 64 });
  } else if (mnemonic === 'sdiv' || mnemonic === 'udiv') {
    const a = read(1,widthBits), b = read(2,widthBits);
    if (!a || !b) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    result = ctx.valueOp(mnemonic === 'sdiv' ? 'a64-sdiv' : 'a64-udiv', [a,b], widthBits, {
      widthBits,
      divisionByZero: 'returns-zero',
      signedOverflow: mnemonic === 'sdiv' ? 'wraps-min-div-minus-one' : 'not-applicable',
    });
  } else if (['madd','msub'].includes(mnemonic)) {
    const a = read(1,widthBits), b = read(2,widthBits), acc = read(3,widthBits);
    if (!a || !b || !acc) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    const product = ctx.valueOp('mul', [a,b], widthBits, { widthBits });
    result = ctx.valueOp(mnemonic === 'madd' ? 'add' : 'sub', [acc,product], widthBits, { widthBits });
  } else {
    const signed = mnemonic.startsWith('sm');
    const subtract = mnemonic.includes('sub');
    const a = read(1,32), b = read(2,32), acc = read(3,64);
    if (!a || !b || !acc || widthBits !== 64) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['registers','other']);
    const ea = signed ? ctx.signExtend(a,32,64) : ctx.zeroExtend(a,32,64);
    const eb = signed ? ctx.signExtend(b,32,64) : ctx.zeroExtend(b,32,64);
    const product = ctx.valueOp('mul', [ea,eb], 64, { widthBits: 64, widening: signed ? 'signed' : 'unsigned' });
    result = ctx.valueOp(subtract ? 'sub' : 'add', [acc,product], 64, { widthBits: 64 });
  }

  const failed = writeOrPartial(ctx, destination, result, `arm64-${mnemonic}-destination-unmodelled`);
  return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function moveImmediate(ctx, destination, immediate, shift, widthBits, mnemonic) {
  void destination;
  if (immediate == null || immediate < 0n || immediate > 0xffffn) return null;
  const amount = Number(shift ?? 0);
  if (![0,16,32,48].includes(amount) || (widthBits === 32 && amount > 16)) return null;
  const shifted = asUnsigned(immediate << BigInt(amount), widthBits);
  if (mnemonic === 'movn') return ctx.constant(widthBits, (~shifted) & bitMask(widthBits));
  return ctx.constant(widthBits, shifted);
}

function liftMove(ctx, ops, mnemonic, instruction) {
  const widthBits = destinationBits(ops);
  const destination = ops[0];
  let result = null;

  if (mnemonic === 'adr' || mnemonic === 'adrp') {
    if (widthBits !== 64) return ctx.partial(`arm64-${mnemonic}-destination-width-invalid`, ['registers','other']);
    let target = instruction?.pcRelTarget;
    try { if (target != null) target = BigInt(target); } catch { target = null; }
    if (target == null) return ctx.partial(`arm64-${mnemonic}-target-unavailable`, ['registers','other']);
    result = ctx.constant(64, target);
  } else if (mnemonic === 'mov') {
    result = ctx.readOperand(ops[1], widthBits);
    if (!result) return ctx.partial('arm64-mov-source-unmodelled', ['registers','other']);
  } else if (mnemonic === 'movz' || mnemonic === 'movn') {
    const immediate = immediateOf(ops[1]);
    const shift = ops[1]?.shift?.op === 'lsl' ? ops[1].shift.amount : 0;
    result = moveImmediate(ctx, destination, immediate, shift, widthBits, mnemonic);
    if (!result) return ctx.partial(`arm64-${mnemonic}-immediate-unmodelled`, ['registers','other']);
  } else if (mnemonic === 'movk') {
    const immediate = immediateOf(ops[1]);
    const shift = ops[1]?.shift?.op === 'lsl' ? Number(ops[1].shift.amount ?? 0) : 0;
    if (immediate == null || immediate < 0n || immediate > 0xffffn || ![0,16,32,48].includes(shift) || (widthBits === 32 && shift > 16)) {
      return ctx.partial('arm64-movk-immediate-unmodelled', ['registers','other']);
    }
    const oldValue = ctx.readRegister(destination);
    if (!oldValue) return ctx.partial('arm64-movk-destination-unmodelled', ['registers','other']);
    result = ctx.valueOp('insert-bits', [oldValue, ctx.constant(16, immediate)], widthBits, { lsb: shift, fieldWidth: 16, widthBits });
  }

  const failed = writeOrPartial(ctx, destination, result, `arm64-${mnemonic}-destination-unmodelled`);
  return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function liftBitfield(ctx, ops, mnemonic) {
  const widthBits = destinationBits(ops);
  const destination = ops[0];
  if (mnemonic === 'extr') {
    const high = ctx.readOperand(ops[1], widthBits);
    const low = ctx.readOperand(ops[2], widthBits);
    const lsb = immediateOf(ops[3]);
    if (!high || !low || lsb == null || lsb < 0n || lsb >= BigInt(widthBits)) return ctx.partial('arm64-extr-operands-unmodelled', ['registers','other']);
    const result = ctx.valueOp('extract-concat', [high,low], widthBits, { highBits: widthBits, lowBits: widthBits, lsb: Number(lsb), widthBits });
    const failed = writeOrPartial(ctx, destination, result, 'arm64-extr-destination-unmodelled');
    return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
  }

  let baseKind = mnemonic;
  let sourceOperand = ops[1];
  let immr;
  let imms;
  if (['ubfm','sbfm','bfm'].includes(mnemonic)) {
    immr = immediateOf(ops[2]);
    imms = immediateOf(ops[3]);
  } else {
    const lsbIndex = mnemonic === 'bfc' ? 1 : 2;
    const widthIndex = mnemonic === 'bfc' ? 2 : 3;
    const lsb = immediateOf(ops[lsbIndex]);
    const fieldWidth = immediateOf(ops[widthIndex]);
    if (lsb == null || fieldWidth == null) return ctx.partial(`arm64-${mnemonic}-immediate-unmodelled`, ['registers','other']);
    const encoding = bitfieldEncodingForAlias(mnemonic, lsb, fieldWidth, widthBits);
    if (!encoding) return ctx.partial(`arm64-${mnemonic}-bitfield-out-of-range`, ['registers','other']);
    immr = BigInt(encoding.immr);
    imms = BigInt(encoding.imms);
    baseKind = mnemonic.startsWith('s') ? 'sbfm' : mnemonic.startsWith('u') ? 'ubfm' : 'bfm';
    if (mnemonic === 'bfc') sourceOperand = null;
  }
  if (immr == null || imms == null) return ctx.partial(`arm64-${mnemonic}-immediate-unmodelled`, ['registers','other']);
  const decoded = decodeArm64BitMasks(widthBits, immr, imms);
  if (!decoded) return ctx.partial(`arm64-${mnemonic}-encoding-unmodelled`, ['registers','other']);

  const source = sourceOperand ? ctx.readOperand(sourceOperand, widthBits) : ctx.constant(widthBits, 0n);
  if (!source) return ctx.partial(`arm64-${mnemonic}-source-unmodelled`, ['registers','other']);
  const inputs = [source];
  if (baseKind === 'bfm') {
    const oldValue = ctx.readRegister(destination);
    if (!oldValue) return ctx.partial(`arm64-${mnemonic}-destination-read-unmodelled`, ['registers','other']);
    inputs.unshift(oldValue);
  }
  const result = ctx.valueOp(`a64-${baseKind}`, inputs, widthBits, {
    widthBits,
    immr: Number(immr),
    imms: Number(imms),
    wmask: `0x${decoded.wmask.toString(16)}`,
    tmask: `0x${decoded.tmask.toString(16)}`,
    alias: mnemonic === baseKind ? null : mnemonic,
  });
  const failed = writeOrPartial(ctx, destination, result, `arm64-${mnemonic}-destination-unmodelled`);
  return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function liftUnary(ctx, ops, mnemonic) {
  const widthBits = destinationBits(ops);
  const sourceBitsByMnemonic = { sxtb:8, sxth:16, sxtw:32, uxtb:8, uxth:16, uxtw:32 };
  const sourceBits = sourceBitsByMnemonic[mnemonic] ?? widthBits;
  let source = ctx.readOperand(ops[1], instructionBits(ops[1], widthBits));
  if (!source) return ctx.partial(`arm64-${mnemonic}-source-unmodelled`, ['registers','other']);
  const actualSourceBits = instructionBits(ops[1], widthBits);
  let result;
  if (sourceBitsByMnemonic[mnemonic] != null) {
    if (sourceBits > actualSourceBits) return ctx.partial(`arm64-${mnemonic}-source-width-invalid`, ['registers','other']);
    if (actualSourceBits !== sourceBits) source = ctx.truncate(source, actualSourceBits, sourceBits);
    result = mnemonic[0] === 's' ? ctx.signExtend(source, sourceBits, widthBits) : ctx.zeroExtend(source, sourceBits, widthBits);
  } else {
    const opcode = {
      clz:'count-leading-zeroes', rbit:'reverse-bits', rev:'reverse-bytes', rev16:'reverse-bytes-16', rev32:'reverse-bytes-32', abs:'a64-abs',
    }[mnemonic];
    result = ctx.valueOp(opcode, [source], widthBits, { widthBits });
  }
  const failed = writeOrPartial(ctx, ops[0], result, `arm64-${mnemonic}-destination-unmodelled`);
  return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, widthBits } });
}

function liftConditionalSelect(ctx, ops, mnemonic, instruction) {
  const widthBits = destinationBits(ops);
  const condition = (instruction?.ops || []).find((op) => op?.k === 'cond')?.text;
  const cond = String(condition || '').toLowerCase();
  const conditionValue = emitArm64Condition(ctx, cond);
  if (!conditionValue) return ctx.partial(`arm64-${mnemonic}-condition-unmodelled`, ['registers','flags','other']);

  let whenTrue, whenFalse;
  if (mnemonic === 'cset' || mnemonic === 'csetm') {
    whenTrue = ctx.constant(widthBits, mnemonic === 'cset' ? 1n : bitMask(widthBits));
    whenFalse = ctx.constant(widthBits, 0n);
  } else if (mnemonic === 'cinc' || mnemonic === 'cneg' || mnemonic === 'cinv') {
    const source = ctx.readOperand(ops[1], widthBits);
    if (!source) return ctx.partial(`arm64-${mnemonic}-source-unmodelled`, ['registers','flags','other']);
    whenFalse = source;
    whenTrue = mnemonic === 'cinc' ? ctx.valueOp('add', [source,ctx.constant(widthBits,1n)], widthBits, { widthBits })
      : mnemonic === 'cneg' ? ctx.valueOp('neg', [source], widthBits, { widthBits })
      : ctx.valueOp('not', [source], widthBits, { widthBits });
  } else {
    const a = ctx.readOperand(ops[1], widthBits);
    const b = ctx.readOperand(ops[2], widthBits);
    if (!a || !b) return ctx.partial(`arm64-${mnemonic}-sources-unmodelled`, ['registers','flags','other']);
    whenTrue = a;
    whenFalse = mnemonic === 'csel' ? b
      : mnemonic === 'csinc' ? ctx.valueOp('add', [b,ctx.constant(widthBits,1n)], widthBits, { widthBits })
      : mnemonic === 'csinv' ? ctx.valueOp('not', [b], widthBits, { widthBits })
      : ctx.valueOp('neg', [b], widthBits, { widthBits });
  }
  const result = ctx.valueOp('select', [conditionValue,whenTrue,whenFalse], widthBits, { condition: cond, widthBits });
  const failed = writeOrPartial(ctx, ops[0], result, `arm64-${mnemonic}-destination-unmodelled`, ['registers','flags']);
  return failed || ctx.finish({ metadata: { family: 'integer', operation: mnemonic, condition: cond, widthBits } });
}

export function liftArm64IntegerEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  if (!ARM64_INTEGER_EFFECT_MNEMONICS.has(mnemonic)) return null;
  const ctx = createArm64EffectContext(instruction, options);
  const ops = instruction?.ops || [];

  if (['add','adds','sub','subs','adc','adcs','sbc','sbcs','neg','negs','ngc','ngcs'].includes(mnemonic)) return liftAddSub(ctx, ops, mnemonic);
  if (['and','ands','orr','eor','bic','bics','orn','eon','mvn'].includes(mnemonic)) return liftLogical(ctx, ops, mnemonic);
  if (['lsl','lslv','lsr','lsrv','asr','asrv','ror','rorv'].includes(mnemonic)) return liftShift(ctx, ops, mnemonic);
  if (['mul','mneg','smull','umull','smulh','umulh','sdiv','udiv','madd','msub','smaddl','smsubl','umaddl','umsubl'].includes(mnemonic)) return liftMultiplyDivide(ctx, ops, mnemonic);
  if (['mov','movz','movn','movk','adr','adrp'].includes(mnemonic)) return liftMove(ctx, ops, mnemonic, instruction);
  if (['ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi','bfc','ubfm','sbfm','bfm','extr'].includes(mnemonic)) return liftBitfield(ctx, ops, mnemonic);
  if (['sxtb','sxth','sxtw','uxtb','uxth','uxtw','clz','rbit','rev','rev16','rev32','abs'].includes(mnemonic)) return liftUnary(ctx, ops, mnemonic);
  if (['csel','csinc','csinv','csneg','cset','csetm','cinc','cneg','cinv'].includes(mnemonic)) return liftConditionalSelect(ctx, ops, mnemonic, instruction);
  return ctx.partial(`arm64-${mnemonic}-integer-family-unmodelled`, ['registers','other']);
}
