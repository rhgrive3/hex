import { x86RegisterOperand } from './common.js';

function bitvector(value, widthBits = 64) { return { kind:'bitvector', widthBits, value:BigInt(value) }; }
function registerExpr(descriptor) {
  return { kind:'register', registerId:descriptor.physicalId, widthBits:descriptor.physicalBits, view:descriptor.id };
}
function add(left, right) { return left == null ? right : right == null ? left : { kind:'add', left, right, widthBits:64 }; }

export function x86EffectiveAddressExpression(instruction, memoryOperand) {
  const memory = memoryOperand?.memory;
  if (!memory) return null;
  let expression = null;
  if (memory.base) {
    if (memory.base.physicalId === 'rip') {
      expression = bitvector(BigInt(instruction.address) + BigInt(instruction.length));
    } else {
      expression = registerExpr(memory.base);
    }
  }
  if (memory.index) {
    let index = registerExpr(memory.index);
    if (memory.scale !== 1) index = { kind:'shift-left', value:index, amount:Math.log2(memory.scale), widthBits:64 };
    expression = add(expression, index);
  }
  if (memory.displacement !== 0n || expression == null) expression = add(expression, bitvector(memory.displacement));
  return Object.freeze({
    expression,
    space:memory.segment === 'fs' || memory.segment === 'gs' ? 'tls' : 'memory',
    metadata:Object.freeze({
      base:memory.base?.id ?? null,
      index:memory.index?.id ?? null,
      scale:memory.scale,
      displacement:memory.displacement,
      segment:memory.segment,
      ripRelative:memory.base?.physicalId === 'rip',
    }),
  });
}

export function materializeX86Address(ctx, memoryOperand) {
  const memory = memoryOperand?.memory;
  if (!memory) return null;
  let value = null;
  if (memory.base) {
    value = memory.base.physicalId === 'rip'
      ? ctx.constant(64, BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length))
      : ctx.readRegister(x86RegisterOperand(memory.base.id));
  }
  if (memory.index) {
    let index = ctx.readRegister(x86RegisterOperand(memory.index.id));
    if (!index) return null;
    if (memory.scale !== 1) index = ctx.valueOp('shl', [index, ctx.constant(64, BigInt(Math.log2(memory.scale)))], 64, { scale:memory.scale });
    value = value == null ? index : ctx.valueOp('add', [value,index], 64, { addressComponent:'index' });
  }
  if (memory.displacement !== 0n || value == null) {
    const displacement = ctx.constant(64, memory.displacement);
    value = value == null ? displacement : ctx.valueOp('add', [value,displacement], 64, { addressComponent:'displacement' });
  }
  return value;
}
