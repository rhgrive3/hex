import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86Condition } from './flags.js';

function addressRef(value) { return { kind:'absolute-address', value:BigInt(value).toString(), widthBits:64 }; }
function fallthrough(instruction) { return addressRef(BigInt(instruction.address) + BigInt(instruction.length)); }

function directTarget(operand) { return operand?.type === 'immediate' ? operand.value : null; }

export function liftX86ControlEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const conditional = /^j/.test(family) && family !== 'jmp';
  if (!conditional && !['jmp','call','ret','retq','nop'].includes(family)) return null;
  const ctx = createX86EffectContext(instruction, context);

  if (family === 'nop') {
    return ctx.finish({
      family:'control',
      statePreservation:{ proven:true, reason:'x86-nop-architectural-state-preservation' },
      metadata:{ operation:'nop' },
    });
  }

  if (conditional) {
    const target = directTarget(ctx.operands[0]);
    const code = ctx.instruction.detail.conditionCode ?? family.slice(1);
    const condition = emitX86Condition(ctx, code);
    if (target == null || !condition) return ctx.partial(`x86-${family}-condition-or-target-unmodelled`, ['control','flags'], { controlEffect:{ kind:'unknown', reason:`x86-${family}-condition-or-target-unmodelled` } });
    return ctx.finish({
      family:'control',
      controlEffect:{ kind:'conditional-branch', target:addressRef(target), fallthrough:fallthrough(ctx.instruction), condition },
      metadata:{ operation:family, conditionCode:code },
    });
  }

  if (family === 'jmp') {
    const operand = ctx.operands[0];
    const target = directTarget(operand);
    if (target != null) return ctx.finish({ family:'control', controlEffect:{ kind:'branch', target:addressRef(target) }, metadata:{ operation:'jmp', direct:true } });
    if (operand?.type === 'register') {
      const value = ctx.readRegister(operand);
      if (value) return ctx.finish({ family:'control', controlEffect:{ kind:'indirect', target:value }, metadata:{ operation:'jmp', direct:false } });
    }
    return ctx.partial('x86-jmp-target-unmodelled', ['control','registers','memory'], { controlEffect:{ kind:'unknown', reason:'x86-jmp-target-unmodelled' } });
  }

  if (family === 'call') {
    const operand = ctx.operands[0];
    const returnAddress = BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length);
    const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
    if (!oldRsp) return ctx.partial('x86-call-stack-state-unmodelled', ['control','registers','memory'], { controlEffect:{ kind:'unknown', reason:'x86-call-stack-state-unmodelled' } });
    const nextRsp = ctx.valueOp('sub', [oldRsp,ctx.constant(64,8n)], 64, { stackDelta:-8 });
    ctx.writeMemory(nextRsp, 64, ctx.constant(64,returnAddress), { metadata:{ stackAccess:true, returnAddress:true } });
    ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp);
    const direct = directTarget(operand);
    let target = direct == null ? null : addressRef(direct);
    if (target == null && operand?.type === 'register') target = ctx.readRegister(operand);
    if (target == null && operand?.type === 'memory') {
      const address = x86EffectiveAddressExpression(ctx.instruction, operand);
      if (address) target = ctx.readMemory(address.expression, 64, { space:address.space, metadata:address.metadata });
    }
    if (target == null) return ctx.partial('x86-call-target-unmodelled', ['control','registers','memory'], { controlEffect:{ kind:'unknown', reason:'x86-call-target-unmodelled' } });
    return ctx.finish({
      family:'control',
      controlEffect:{ kind:'call', target, fallthrough:addressRef(returnAddress) },
      possibleFaults:x86MemoryFaults('write',64),
      metadata:{ operation:'call', direct:direct != null, abiSemantics:false, stackDelta:-8 },
    });
  }

  const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
  if (!oldRsp) return ctx.partial('x86-ret-stack-state-unmodelled', ['control','registers','memory'], { controlEffect:{ kind:'unknown', reason:'x86-ret-stack-state-unmodelled' } });
  const target = ctx.readMemory(oldRsp, 64, { metadata:{ stackAccess:true, returnAddress:true } });
  const extra = ctx.operands[0]?.type === 'immediate' ? ctx.operands[0].value : 0n;
  const nextRsp = ctx.valueOp('add', [oldRsp,ctx.constant(64,8n + extra)], 64, { stackDelta:Number(8n + extra) });
  ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp);
  return ctx.finish({
    family:'control',
    controlEffect:{ kind:'return', target },
    possibleFaults:x86MemoryFaults('read',64),
    metadata:{ operation:'ret', abiSemantics:false, stackDelta:(8n + extra).toString() },
  });
}
