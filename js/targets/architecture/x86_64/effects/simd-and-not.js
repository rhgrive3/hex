import { createX86EffectContext } from './common.js';
import { readX86VectorOperand, writeX86VectorRegister, x86VectorEncodingInfo } from './simd.js';

function isVector(operand) {
  return operand?.type === 'register' && operand.register?.kind === 'vector';
}

function mergeFaults(...groups) {
  return groups.flat().filter(Boolean);
}

export function liftX86SimdAndNotEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (family !== 'pandn' && family !== 'vpandn') return null;

  const ctx = createX86EffectContext(instruction, context);
  const encoding = x86VectorEncodingInfo(ctx.instruction);
  if (!encoding.valid) return ctx.partial('x86-vector-prefix-metadata-malformed', ['registers','memory','other'], { metadata:{ operation:family } });
  if (encoding.kind === 'evex') return ctx.partial('x86-evex-physical-state-unmodelled', ['registers','other'], { metadata:{ operation:family, vectorPrefixKind:'evex' } });
  if (family === 'pandn' && encoding.kind !== 'legacy') return ctx.partial('x86-pandn-encoding-mismatch', ['registers','other']);
  if (family === 'vpandn' && encoding.kind !== 'vex') return ctx.partial('x86-vpandn-encoding-mismatch', ['registers','other']);

  const [destination, operand1, operand2] = ctx.operands;
  if (!isVector(destination)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers']);

  const width = family === 'pandn' ? 128 : Number(destination.widthBits || 0);
  if (![128,256].includes(width) || destination.widthBits !== width) return ctx.partial(`x86-${family}-width-unmodelled`, ['registers','memory','other']);
  if (family === 'vpandn' && encoding.vectorWidthBits !== width) return ctx.partial('x86-vpandn-vector-width-mismatch', ['registers','memory','other']);

  const leftOperand = family === 'pandn' ? destination : operand1;
  const rightOperand = family === 'pandn' ? operand1 : operand2;
  const left = readX86VectorOperand(ctx, leftOperand, width);
  const right = readX86VectorOperand(ctx, rightOperand, width);
  if (!left || !right) return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','memory']);

  const allOnes = ctx.constant(width, (1n << BigInt(width)) - 1n);
  const invertedLeft = ctx.valueOp('xor', [left.value, allOnes], width, {
    semanticFamily:family,
    operation:'bitwise-not-left',
  });
  const result = ctx.valueOp('and', [invertedLeft, right.value], width, {
    semanticFamily:family,
    operation:'and-not',
  });

  if (!writeX86VectorRegister(ctx, destination, result, encoding, width)) {
    return ctx.partial(`x86-${family}-destination-write-unmodelled`, ['registers']);
  }

  return ctx.finish({
    family:'simd',
    possibleFaults:mergeFaults(left.possibleFaults, right.possibleFaults),
    metadata:{
      operation:family,
      vectorWidthBits:width,
      bitwiseOperation:'and-not',
      exactFormula:'(~left) & right',
      encodingKind:encoding.kind,
      upperLaneBehavior:width === 256 ? 'replace-ymm' : encoding.kind === 'vex' ? 'zero-upper-128' : 'preserve-upper-128',
    },
  });
}
