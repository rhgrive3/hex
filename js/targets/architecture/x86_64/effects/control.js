import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86Condition } from './flags.js';

const CONDITION_COUNT_BRANCHES = Object.freeze(new Map([
  ['jrcxz','rcx'],
  ['jecxz','ecx'],
  ['jcxz','cx'],
]));

function addressRef(value) { return Object.freeze({ kind:'absolute-address', value:BigInt(value).toString(), widthBits:64 }); }
function fallthrough(instruction) { return addressRef(BigInt(instruction.address) + BigInt(instruction.length)); }
function directTarget(operand) { return operand?.type === 'immediate' ? operand.value : null; }

function trapEffect(ctx, family) {
  if (family === 'ud2') {
    return ctx.finish({
      family:'control',
      controlEffect:{ kind:'trap', reason:'x86-ud2-invalid-opcode' },
      possibleFaults:[{
        kind:'invalid-opcode',
        condition:{ kind:'always' },
        detail:{ vector:'#UD', exceptionClass:'fault', operation:'ud2' },
      }],
      metadata:{ operation:'ud2', architecturalTrap:true },
    });
  }
  return ctx.finish({
    family:'control',
    controlEffect:{ kind:'trap', reason:'x86-int3-breakpoint' },
    possibleFaults:[{
      kind:'breakpoint-trap',
      condition:{ kind:'always' },
      detail:{ vector:'#BP', exceptionClass:'trap', operation:'int3' },
    }],
    metadata:{ operation:'int3', architecturalTrap:true },
  });
}

function resolveIndirectTarget(ctx, operand, operation) {
  if (operand?.type === 'register') {
    if (operand.widthBits !== 64) return null;
    const target = ctx.readRegister(operand);
    return target == null ? null : Object.freeze({ target, faults:[] });
  }
  if (operand?.type !== 'memory' || operand.widthBits !== 64) return null;
  const address = x86EffectiveAddressExpression(ctx.instruction, operand);
  if (!address) return null;
  const target = ctx.readMemory(address.expression, 64, {
    space:address.space,
    metadata:{ ...address.metadata, controlTarget:true, operation },
  });
  return Object.freeze({ target, faults:x86MemoryFaults('read',64) });
}

export function liftX86ControlEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const conditional = family.startsWith('j') && family !== 'jmp';
  if (!conditional && !['jmp','call','ret','retq','nop','ud2','int3'].includes(family)) return null;
  const ctx = createX86EffectContext(instruction, context);

  if (family === 'nop') {
    return ctx.finish({
      family:'control',
      statePreservation:{ proven:true, reason:'x86-nop-architectural-state-preservation' },
      metadata:{ operation:'nop' },
    });
  }

  if (family === 'ud2' || family === 'int3') return trapEffect(ctx, family);

  if (conditional) {
    const target = directTarget(ctx.operands[0]);
    if (target == null) {
      return ctx.partial(`x86-${family}-target-unmodelled`, ['control'], {
        controlEffect:{ kind:'unknown', reason:`x86-${family}-target-unmodelled` },
      });
    }

    const countRegister = CONDITION_COUNT_BRANCHES.get(family);
    let condition;
    let conditionKind = 'rflags';
    if (countRegister) {
      const count = ctx.readRegister(x86RegisterOperand(countRegister));
      if (!count) {
        return ctx.partial(`x86-${family}-count-register-unmodelled`, ['control','registers'], {
          controlEffect:{ kind:'unknown', reason:`x86-${family}-count-register-unmodelled` },
        });
      }
      condition = ctx.valueOp('is-zero', [count], 1, {
        widthBits:x86RegisterOperand(countRegister).widthBits,
        semantic:`${countRegister} == 0`,
      });
      conditionKind = 'count-register';
    } else {
      const code = ctx.instruction.detail.conditionCode ?? family.slice(1);
      condition = emitX86Condition(ctx, code);
      if (!condition) {
        return ctx.partial(`x86-${family}-condition-unmodelled`, ['control','flags'], {
          controlEffect:{ kind:'unknown', reason:`x86-${family}-condition-unmodelled` },
        });
      }
    }

    return ctx.finish({
      family:'control',
      controlEffect:{
        kind:'conditional-branch',
        target:addressRef(target),
        fallthrough:fallthrough(ctx.instruction),
        condition,
      },
      metadata:{
        operation:family,
        conditionKind,
        ...(conditionKind === 'rflags' ? { conditionCode:ctx.instruction.detail.conditionCode ?? family.slice(1) } : { countRegister }),
        instructionLength:ctx.instruction.length,
      },
    });
  }

  if (family === 'jmp') {
    const operand = ctx.operands[0];
    if (ctx.operands.length !== 1) {
      return ctx.partial('x86-jmp-operand-shape-unmodelled', ['control'], {
        controlEffect:{ kind:'unknown', reason:'x86-jmp-operand-shape-unmodelled' },
      });
    }
    const direct = directTarget(operand);
    if (direct != null) {
      return ctx.finish({
        family:'control',
        controlEffect:{ kind:'branch', target:addressRef(direct) },
        metadata:{ operation:'jmp', direct:true, instructionLength:ctx.instruction.length },
      });
    }
    const indirect = resolveIndirectTarget(ctx, operand, 'jmp');
    if (indirect) {
      return ctx.finish({
        family:'control',
        controlEffect:{ kind:'indirect', target:indirect.target },
        possibleFaults:indirect.faults,
        metadata:{ operation:'jmp', direct:false, memoryIndirect:operand?.type === 'memory', instructionLength:ctx.instruction.length },
      });
    }
    return ctx.partial('x86-jmp-target-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-jmp-target-unmodelled' },
    });
  }

  if (family === 'call') {
    if (ctx.operands.length !== 1) {
      return ctx.partial('x86-call-operand-shape-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-operand-shape-unmodelled' },
      });
    }
    const operand = ctx.operands[0];
    const returnAddress = BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length);

    const direct = directTarget(operand);
    let target = direct == null ? null : addressRef(direct);
    let targetFaults = [];
    if (target == null) {
      const indirect = resolveIndirectTarget(ctx, operand, 'call');
      if (indirect) {
        target = indirect.target;
        targetFaults = indirect.faults;
      }
    }
    if (target == null) {
      return ctx.partial('x86-call-target-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-target-unmodelled' },
      });
    }

    const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
    if (!oldRsp) {
      return ctx.partial('x86-call-stack-state-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-stack-state-unmodelled' },
      });
    }
    const nextRsp = ctx.valueOp('sub', [oldRsp,ctx.constant(64,8n)], 64, { stackDelta:-8, semantic:'x86-near-call-push-return-address' });
    ctx.writeMemory(nextRsp, 64, ctx.constant(64,returnAddress), { metadata:{ stackAccess:true, returnAddress:true } });
    if (!ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp)) {
      return ctx.partial('x86-call-rsp-write-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-rsp-write-unmodelled' },
      });
    }
    return ctx.finish({
      family:'control',
      controlEffect:{ kind:'call', target, fallthrough:addressRef(returnAddress) },
      possibleFaults:[...targetFaults,...x86MemoryFaults('write',64)],
      metadata:{
        operation:'call',
        direct:direct != null,
        memoryIndirect:operand?.type === 'memory',
        abiSemantics:false,
        stackDelta:-8,
        returnAddress:returnAddress.toString(),
        instructionLength:ctx.instruction.length,
      },
    });
  }

  if (ctx.operands.length > 1 || (ctx.operands[0] != null && ctx.operands[0].type !== 'immediate')) {
    return ctx.partial('x86-ret-operand-shape-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-operand-shape-unmodelled' },
    });
  }
  const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
  if (!oldRsp) {
    return ctx.partial('x86-ret-stack-state-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-stack-state-unmodelled' },
    });
  }
  const target = ctx.readMemory(oldRsp, 64, { metadata:{ stackAccess:true, returnAddress:true } });
  const extra = ctx.operands[0]?.type === 'immediate' ? BigInt(ctx.operands[0].value) : 0n;
  if (extra < 0n || extra > 0xffffn) {
    return ctx.partial('x86-ret-immediate-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-immediate-unmodelled' },
    });
  }
  const total = 8n + extra;
  const nextRsp = ctx.valueOp('add', [oldRsp,ctx.constant(64,total)], 64, { stackDelta:total.toString(), semantic:'x86-near-ret-pop-return-address' });
  if (!ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp)) {
    return ctx.partial('x86-ret-rsp-write-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-rsp-write-unmodelled' },
    });
  }
  return ctx.finish({
    family:'control',
    controlEffect:{ kind:'return', target },
    possibleFaults:x86MemoryFaults('read',64),
    metadata:{ operation:'ret', abiSemantics:false, stackDelta:total.toString(), immediateAdjustment:extra.toString(), instructionLength:ctx.instruction.length },
  });
}
