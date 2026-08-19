import { RISCV64_XLEN, createRiscv64EffectContext } from './common.js';

/** RV64 control-transfer effects. */
const BRANCH_PREDICATE = Object.freeze({
  beq: { predicate: 'eq', signed: null },
  bne: { predicate: 'ne', signed: null },
  blt: { predicate: 'slt', signed: true },
  bge: { predicate: 'sge', signed: true },
  bltu: { predicate: 'ult', signed: false },
  bgeu: { predicate: 'uge', signed: false },
});
const RETURN_ADDRESS_HINT_REGISTERS = Object.freeze(['x1', 'x5']);
function addressRef(value) { return { kind: 'absolute-address', value: BigInt(value) }; }
function targetAlignmentFault(instructionAlignment) {
  const alignmentBytes = Number(instructionAlignment);
  if (alignmentBytes <= 2) return null;
  return { kind: 'pc-alignment-fault', condition: { kind: 'riscv64-target-misaligned', alignmentBytes }, detail: { architecture: 'riscv64', instructionAlignment: alignmentBytes } };
}
function targetAlignmentFaults(ctx) { const fault = targetAlignmentFault(ctx.instructionAlignment); return fault == null ? [] : [fault]; }

export function liftRiscv64ControlEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported) return null;
  const op = fields.op;
  const address = BigInt(ctx.instruction.address);
  const next = address + BigInt(ctx.instruction.size);

  if (BRANCH_PREDICATE[op]) {
    const { predicate, signed } = BRANCH_PREDICATE[op];
    const left = ctx.readRegister(fields.rs1);
    const right = ctx.readRegister(fields.rs2);
    const condition = ctx.valueOp(`icmp.${predicate}`, [left, right], 1, {
      predicate,
      ...(signed == null ? {} : { signed }),
      widthBits: RISCV64_XLEN,
      conditionSource: 'direct-register-comparison',
    });
    const target = address + BigInt(fields.imm);
    return ctx.finish({
      controlEffect: { kind: 'conditional-branch', target: addressRef(target), fallthrough: addressRef(next), condition },
      possibleFaults: target === next ? [] : targetAlignmentFaults(ctx),
      family: 'control',
      metadata: {
        operation: op,
        predicate,
        flagsRegisterUsed: false,
        conditionKind: 'direct-register-comparison',
        ...(target === next ? { degenerateConditional: true } : {}),
      },
    });
  }

  if (op === 'jal') {
    const target = address + BigInt(fields.imm);
    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));
    const isCallHint = linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rd);
    return ctx.finish({
      controlEffect: isCallHint ? { kind: 'call', target: addressRef(target), fallthrough: addressRef(next) } : { kind: 'branch', target: addressRef(target) },
      possibleFaults: targetAlignmentFaults(ctx),
      family: 'control',
      metadata: { operation: op, direct: true, linkRegister: linked ? fields.rd : null, jumpWithLinkage: linked && !isCallHint, abiSemantics: false },
    });
  }

  if (op === 'jalr') {
    const base = ctx.readRegister(fields.rs1);
    const sum = ctx.valueOp('add', [base, ctx.constant(RISCV64_XLEN, fields.imm)], RISCV64_XLEN, { addressArithmetic: 'jalr-target' });
    const target = ctx.valueOp('and', [sum, ctx.constant(RISCV64_XLEN, -2n)], RISCV64_XLEN, { targetLowBitCleared: true });
    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));
    const isCallHint = linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rd);
    const isReturnHint = !linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rs1);
    const kind = isCallHint ? 'call' : isReturnHint ? 'return' : 'indirect';
    return ctx.finish({
      controlEffect: { kind, target, ...(kind === 'call' ? { fallthrough: addressRef(next) } : {}) },
      possibleFaults: targetAlignmentFaults(ctx),
      family: 'control',
      metadata: { operation: op, indirect: true, linkRegister: linked ? fields.rd : null, returnAddressStackHint: isReturnHint ? fields.rs1 : null, jumpWithLinkage: linked && !isCallHint, abiSemantics: false },
    });
  }
  return null;
}
