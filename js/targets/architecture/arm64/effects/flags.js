import { createArm64EffectContext, asUnsigned, bitMask, conditionOf, instructionBits, immediateOf } from './common.js';

export const ARM64_FLAG_EFFECT_MNEMONICS = Object.freeze(new Set([
  'cmp', 'cmn', 'tst', 'ccmp', 'ccmn',
]));

const CONDITION_CODES = new Set([
  'eq','ne','cs','hs','cc','lo','mi','pl','vs','vc','hi','ls','ge','lt','gt','le','al','nv',
]);

function bool(value) { return value ? 1 : 0; }

export function evaluateArm64AddSubFlags(lhs, rhs, widthBits, { subtract = false, carryIn = subtract ? 1 : 0 } = {}) {
  if (widthBits !== 32 && widthBits !== 64) throw new TypeError('arm64-flags-invalid-width');
  const width = BigInt(widthBits);
  const mask = bitMask(widthBits);
  const a = asUnsigned(lhs, widthBits);
  const b = asUnsigned(rhs, widthBits);
  const cin = BigInt(carryIn ? 1 : 0);
  const operand2 = subtract ? ((~b) & mask) : b;
  const unsignedSum = a + operand2 + cin;
  const result = unsignedSum & mask;
  const c = unsignedSum >> width ? 1 : 0;
  const sign = 1n << (width - 1n);
  const effectiveB = b;
  const overflow = subtract
    ? (((a ^ effectiveB) & (a ^ result) & sign) !== 0n)
    : (((~(a ^ effectiveB)) & (a ^ result) & sign) !== 0n);
  return Object.freeze({
    result,
    N: bool((result & sign) !== 0n),
    Z: bool(result === 0n),
    C: c,
    V: bool(overflow),
  });
}

export function evaluateArm64Condition(nzcv, condition) {
  const cond = String(condition || '').toLowerCase();
  if (!CONDITION_CODES.has(cond)) throw new TypeError('arm64-flags-invalid-condition');
  const N = !!nzcv?.N;
  const Z = !!nzcv?.Z;
  const C = !!nzcv?.C;
  const V = !!nzcv?.V;
  switch (cond) {
    case 'eq': return Z;
    case 'ne': return !Z;
    case 'cs': case 'hs': return C;
    case 'cc': case 'lo': return !C;
    case 'mi': return N;
    case 'pl': return !N;
    case 'vs': return V;
    case 'vc': return !V;
    case 'hi': return C && !Z;
    case 'ls': return !C || Z;
    case 'ge': return N === V;
    case 'lt': return N !== V;
    case 'gt': return !Z && N === V;
    case 'le': return Z || N !== V;
    case 'al': case 'nv': return true;
    default: throw new TypeError('arm64-flags-invalid-condition');
  }
}

export function emitArm64AddSub(ctx, lhs, rhs, widthBits, { subtract = false, carryIn = null } = {}) {
  let second = rhs;
  let cin = carryIn;
  if (subtract) {
    second = ctx.valueOp('not', [rhs], widthBits, { widthBits });
    if (cin == null) cin = ctx.constant(1, 1n);
  } else if (cin == null) {
    cin = ctx.constant(1, 0n);
  }
  const [result, C, V] = ctx.valueOpMulti('add-with-carry', [lhs, second, cin], [widthBits, 1, 1], {
    widthBits,
    subtract,
  });
  const N = ctx.valueOp('extract-bit', [result], 1, { bit: widthBits - 1, widthBits });
  const Z = ctx.valueOp('is-zero', [result], 1, { widthBits });
  return { result, N, Z, C, V };
}

export function emitArm64LogicalFlags(ctx, result, widthBits) {
  return {
    N: ctx.valueOp('extract-bit', [result], 1, { bit: widthBits - 1, widthBits }),
    Z: ctx.valueOp('is-zero', [result], 1, { widthBits }),
    C: ctx.constant(1, 0n),
    V: ctx.constant(1, 0n),
  };
}

export function writeArm64NZCV(ctx, flags) {
  ctx.writeFlag('N', flags.N);
  ctx.writeFlag('Z', flags.Z);
  ctx.writeFlag('C', flags.C);
  ctx.writeFlag('V', flags.V);
}

export function emitArm64Condition(ctx, condition) {
  const cond = String(condition || '').toLowerCase();
  if (!CONDITION_CODES.has(cond)) return null;
  if (cond === 'al' || cond === 'nv') return ctx.constant(1, 1n);

  const read = (name) => ctx.readFlag(name);
  const not = (value) => ctx.valueOp('not-bool', [value], 1);
  const and = (a, b) => ctx.valueOp('and-bool', [a, b], 1);
  const or = (a, b) => ctx.valueOp('or-bool', [a, b], 1);
  const eq = (a, b) => ctx.valueOp('equal-bool', [a, b], 1);

  switch (cond) {
    case 'eq': return read('Z');
    case 'ne': return not(read('Z'));
    case 'cs': case 'hs': return read('C');
    case 'cc': case 'lo': return not(read('C'));
    case 'mi': return read('N');
    case 'pl': return not(read('N'));
    case 'vs': return read('V');
    case 'vc': return not(read('V'));
    case 'hi': return and(read('C'), not(read('Z')));
    case 'ls': return or(not(read('C')), read('Z'));
    case 'ge': return eq(read('N'), read('V'));
    case 'lt': return not(eq(read('N'), read('V')));
    case 'gt': return and(not(read('Z')), eq(read('N'), read('V')));
    case 'le': return or(read('Z'), not(eq(read('N'), read('V'))));
    default: return null;
  }
}

function fallbackFlags(ctx, immediate) {
  const imm = Number(immediate & 0xfn);
  return {
    N: ctx.constant(1, BigInt((imm >> 3) & 1)),
    Z: ctx.constant(1, BigInt((imm >> 2) & 1)),
    C: ctx.constant(1, BigInt((imm >> 1) & 1)),
    V: ctx.constant(1, BigInt(imm & 1)),
  };
}

export function liftArm64FlagEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  if (!ARM64_FLAG_EFFECT_MNEMONICS.has(mnemonic)) return null;
  const ctx = createArm64EffectContext(instruction, options);
  const ops = instruction?.ops || [];
  const widthBits = instructionBits(ops[0]);

  if (mnemonic === 'tst') {
    const lhs = ctx.readOperand(ops[0], widthBits);
    const rhs = ctx.readOperand(ops[1], widthBits);
    if (!lhs || !rhs) return ctx.partial('arm64-tst-operands-unmodelled', ['flags', 'other']);
    const result = ctx.valueOp('and', [lhs, rhs], widthBits, { widthBits });
    writeArm64NZCV(ctx, emitArm64LogicalFlags(ctx, result, widthBits));
    return ctx.finish({ metadata: { family: 'flags', operation: 'tst' } });
  }

  if (mnemonic === 'cmp' || mnemonic === 'cmn') {
    const lhs = ctx.readOperand(ops[0], widthBits);
    const rhs = ctx.readOperand(ops[1], widthBits);
    if (!lhs || !rhs) return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['flags', 'other']);
    const flags = emitArm64AddSub(ctx, lhs, rhs, widthBits, { subtract: mnemonic === 'cmp' });
    writeArm64NZCV(ctx, flags);
    return ctx.finish({ metadata: { family: 'flags', operation: mnemonic, widthBits } });
  }

  const condition = conditionOf(instruction);
  const fallback = immediateOf(ops[2]);
  const lhs = ctx.readOperand(ops[0], widthBits);
  const rhs = ctx.readOperand(ops[1], widthBits);
  if (!lhs || !rhs || fallback == null || !condition || fallback < 0n || fallback > 15n) {
    return ctx.partial(`arm64-${mnemonic}-operands-unmodelled`, ['flags', 'other']);
  }
  const conditionValue = emitArm64Condition(ctx, condition);
  if (!conditionValue) return ctx.partial(`arm64-${mnemonic}-condition-unmodelled`, ['flags', 'other']);
  const candidate = emitArm64AddSub(ctx, lhs, rhs, widthBits, { subtract: mnemonic === 'ccmp' });
  const fallbackNzcv = fallbackFlags(ctx, fallback);
  const selected = {};
  for (const flag of ['N','Z','C','V']) {
    selected[flag] = ctx.valueOp('select', [conditionValue, candidate[flag], fallbackNzcv[flag]], 1, {
      condition,
      flag,
    });
  }
  writeArm64NZCV(ctx, selected);
  return ctx.finish({ metadata: { family: 'flags', operation: mnemonic, condition, fallbackNzcv: Number(fallback) } });
}
