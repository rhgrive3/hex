import { createX86EffectContext } from './common.js';
import { materializeX86Address } from './addressing.js';
import { emitX86ArithmeticFlags, emitX86LogicalFlags } from './flags.js';

const MOVES = new Set(['mov','movabs']);
const EXTENDS = new Map([
  ['movzx', false], ['movsx', true], ['movsxd', true],
]);
const ARITHMETIC = new Set(['add','sub']);
const LOGICAL = new Set(['and','or','xor']);

function registerOnly(operands) { return operands.every((operand) => operand?.type !== 'memory'); }

export function liftX86IntegerEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (![...MOVES, ...EXTENDS.keys(), ...ARITHMETIC, ...LOGICAL, 'cmp','test','lea'].includes(family)) return null;
  const ctx = createX86EffectContext(instruction, context);
  const [destination, source] = ctx.operands;
  if (!registerOnly(ctx.operands)) return null;

  if (MOVES.has(family)) {
    if (destination?.type !== 'register' || !source) return ctx.partial('x86-mov-operand-shape-unmodelled', ['registers']);
    const value = ctx.readOperand(source, destination.widthBits);
    if (!value || !ctx.writeRegister(destination, value)) return ctx.partial('x86-mov-register-view-unmodelled', ['registers']);
    return ctx.finish({ family:'integer', metadata:{ operation:family, widthBits:destination.widthBits } });
  }

  if (EXTENDS.has(family)) {
    if (destination?.type !== 'register' || !source) return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers']);
    const raw = ctx.readOperand(source, source.widthBits);
    if (!raw) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers']);
    const extended = ctx.coerce(raw, source.widthBits, destination.widthBits, EXTENDS.get(family));
    if (!ctx.writeRegister(destination, extended)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers']);
    return ctx.finish({ family:'integer', metadata:{ operation:family, fromBits:source.widthBits, toBits:destination.widthBits } });
  }

  if (family === 'lea') {
    return ctx.partial('x86-lea-requires-structured-memory-operand', ['registers','other']);
  }

  if (ARITHMETIC.has(family) || LOGICAL.has(family)) {
    if (destination?.type !== 'register' || !source) return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    const left = ctx.readRegister(destination);
    const right = ctx.readOperand(source, destination.widthBits);
    if (!left || !right) return ctx.partial(`x86-${family}-source-unmodelled`, ['registers','flags']);
    const result = ctx.valueOp(family, [left,right], destination.widthBits, { widthBits:destination.widthBits });
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers','flags']);
    if (ARITHMETIC.has(family)) emitX86ArithmeticFlags(ctx, family, left, right, result, destination.widthBits);
    else emitX86LogicalFlags(ctx, family, left, right, result, destination.widthBits);
    return ctx.finish({ family:'integer', metadata:{ operation:family, widthBits:destination.widthBits } });
  }

  if (family === 'cmp' || family === 'test') {
    const left = ctx.readOperand(destination, destination?.widthBits);
    const right = ctx.readOperand(source, destination?.widthBits);
    if (!left || !right || !destination?.widthBits) return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['registers','flags']);
    const result = ctx.valueOp(family === 'cmp' ? 'sub' : 'and', [left,right], destination.widthBits, { compareOnly:true, widthBits:destination.widthBits });
    if (family === 'cmp') emitX86ArithmeticFlags(ctx, family, left, right, result, destination.widthBits);
    else emitX86LogicalFlags(ctx, family, left, right, result, destination.widthBits);
    return ctx.finish({ family:'flags', metadata:{ operation:family, destinationWrite:false, widthBits:destination.widthBits } });
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
