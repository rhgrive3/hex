import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86ArithmeticFlags, emitX86LogicalFlags } from './flags.js';

const MOVES = new Set(['mov','movabs','movzx','movsx','movsxd']);
const ARITHMETIC = new Set(['add','sub']);

function memoryOperand(operands) { return operands.find((operand) => operand?.type === 'memory') || null; }

export function liftX86MemoryEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (![...MOVES, ...ARITHMETIC, 'cmp','test','push','pop'].includes(family)) return null;
  const ctx = createX86EffectContext(instruction, context);

  if (family === 'push') {
    const source = ctx.operands[0];
    const value = ctx.readOperand(source, 64);
    const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
    if (!value || !oldRsp) return ctx.partial('x86-push-operand-unmodelled', ['registers','memory']);
    const nextRsp = ctx.valueOp('sub', [oldRsp,ctx.constant(64,8n)], 64, { stackDelta:-8 });
    ctx.writeMemory(nextRsp, 64, value, { metadata:{ stackAccess:true } });
    ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp);
    return ctx.finish({ family:'memory', possibleFaults:x86MemoryFaults('write',64), metadata:{ operation:'push', stackDelta:-8 } });
  }

  if (family === 'pop') {
    const destination = ctx.operands[0];
    const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
    if (!oldRsp || destination?.type !== 'register') return ctx.partial('x86-pop-operand-unmodelled', ['registers','memory']);
    const value = ctx.readMemory(oldRsp, destination.widthBits, { metadata:{ stackAccess:true } });
    const nextRsp = ctx.valueOp('add', [oldRsp,ctx.constant(64,8n)], 64, { stackDelta:8 });
    if (!ctx.writeRegister(destination, value) || !ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp)) {
      return ctx.partial('x86-pop-register-view-unmodelled', ['registers','memory']);
    }
    return ctx.finish({ family:'memory', possibleFaults:x86MemoryFaults('read',destination.widthBits), metadata:{ operation:'pop', stackDelta:8 } });
  }

  if ((ARITHMETIC.has(family) || family === 'cmp' || family === 'test') && memoryOperand(ctx.operands)) {
    const [destination, source] = ctx.operands;
    const memory = destination?.type === 'memory' ? destination : source?.type === 'memory' ? source : null;
    const address = memory == null ? null : x86EffectiveAddressExpression(ctx.instruction, memory);
    if (!address) return ctx.partial(`x86-${family}-memory-address-unmodelled`, ['memory','registers','flags']);
    const memoryValue = ctx.readMemory(address.expression, memory.widthBits, { space:address.space, metadata:address.metadata });
    if (family === 'cmp' || family === 'test') {
      if (destination?.type !== 'memory') return ctx.partial(`x86-${family}-memory-shape-unmodelled`, ['memory','registers','flags']);
      const right = ctx.readOperand(source, destination.widthBits);
      if (!right) return ctx.partial(`x86-${family}-memory-source-unmodelled`, ['memory','registers','flags']);
      const opcode = family === 'cmp' ? 'sub' : 'and';
      const result = ctx.valueOp(opcode, [memoryValue,right], destination.widthBits, { compareOnly:true, widthBits:destination.widthBits });
      if (family === 'cmp') emitX86ArithmeticFlags(ctx, family, memoryValue, right, result, destination.widthBits);
      else emitX86LogicalFlags(ctx, family, memoryValue, right, result, destination.widthBits);
      return ctx.finish({
        family:'flags',
        possibleFaults:x86MemoryFaults('read',destination.widthBits),
        metadata:{ operation:family, direction:'read-only', destinationWrite:false, address:address.metadata },
      });
    }
    if (destination?.type !== 'register' || source?.type !== 'memory') {
      return ctx.partial(`x86-${family}-memory-destination-unmodelled`, ['memory','registers','flags']);
    }
    const left = ctx.readRegister(destination);
    if (!left) return ctx.partial(`x86-${family}-register-destination-unmodelled`, ['memory','registers','flags']);
    const result = ctx.valueOp(family, [left,memoryValue], destination.widthBits, { widthBits:destination.widthBits });
    if (!ctx.writeRegister(destination, result)) return ctx.partial(`x86-${family}-register-write-unmodelled`, ['memory','registers','flags']);
    emitX86ArithmeticFlags(ctx, family, left, memoryValue, result, destination.widthBits);
    return ctx.finish({
      family:'integer',
      possibleFaults:x86MemoryFaults('read',source.widthBits),
      metadata:{ operation:family, direction:'load-source', address:address.metadata },
    });
  }

  if (!MOVES.has(family) || !memoryOperand(ctx.operands)) return null;
  const [destination, source] = ctx.operands;
  if (destination?.type === 'register' && source?.type === 'memory') {
    const address = x86EffectiveAddressExpression(ctx.instruction, source);
    if (!address) return ctx.partial(`x86-${family}-load-address-unmodelled`, ['memory','registers']);
    const raw = ctx.readMemory(address.expression, source.widthBits, { space:address.space, metadata:address.metadata });
    const signed = family === 'movsx' || family === 'movsxd';
    const value = ctx.coerce(raw, source.widthBits, destination.widthBits, signed);
    if (!ctx.writeRegister(destination, value)) return ctx.partial(`x86-${family}-load-destination-unmodelled`, ['memory','registers']);
    return ctx.finish({ family:'memory', possibleFaults:x86MemoryFaults('read',source.widthBits), metadata:{ operation:family, direction:'load', address:address.metadata } });
  }
  if (destination?.type === 'memory' && source && source.type !== 'memory') {
    const address = x86EffectiveAddressExpression(ctx.instruction, destination);
    const value = ctx.readOperand(source, destination.widthBits);
    if (!address || !value) return ctx.partial(`x86-${family}-store-source-unmodelled`, ['memory','registers']);
    ctx.writeMemory(address.expression, destination.widthBits, value, { space:address.space, metadata:address.metadata });
    return ctx.finish({ family:'memory', possibleFaults:x86MemoryFaults('write',destination.widthBits), metadata:{ operation:family, direction:'store', address:address.metadata } });
  }
  return ctx.partial(`x86-${family}-memory-shape-unmodelled`, ['memory','registers']);
}
