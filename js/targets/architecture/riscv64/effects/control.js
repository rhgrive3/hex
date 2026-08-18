import { RISCV64_XLEN, createRiscv64EffectContext } from './common.js';

/**
 * RV64 control-transfer effects.
 *
 * This file is the concrete answer to the Phase 6 exit condition "the generic
 * core handles an architecture without a flags register".
 *
 * A RISC-V conditional branch compares two registers *in the branch itself*.
 * There is no condition-code register to write beforehand and none to read.
 * So the branch's `condition` is an ordinary 1-bit comparison value produced by
 * this same instruction, handed to the generic conditional-branch contract.
 * Nothing here fabricates NZCV/RFLAGS-shaped state.
 *
 * Call/return classification is architectural, not psABI:
 *
 *  - writing a link value is distinct from proving an ABI call; only x1/x5 are
 *    the ISA return-address-stack hint registers used as instruction-local call
 *    evidence here;
 *  - for `jalr` with rd == x0, rs1 in {x1, x5} is a return hint.
 */

const BRANCH_PREDICATE = Object.freeze({
  beq: { predicate: 'eq', signed: null },
  bne: { predicate: 'ne', signed: null },
  blt: { predicate: 'slt', signed: true },
  bge: { predicate: 'sge', signed: true },
  bltu: { predicate: 'ult', signed: false },
  bgeu: { predicate: 'uge', signed: false },
});

const RETURN_ADDRESS_HINT_REGISTERS = Object.freeze(['x1', 'x5']);

function addressRef(value) {
  return { kind: 'absolute-address', value: BigInt(value) };
}

function targetAlignmentFault() {
  return {
    kind: 'pc-alignment-fault',
    condition: { kind: 'riscv64-target-misaligned', alignmentBytes: 2 },
    detail: { architecture: 'riscv64', profile: 'rv64imc' },
  };
}

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
    if (target === next) {
      return ctx.finish({
        controlEffect: { kind: 'branch', target: addressRef(target), condition },
        family: 'control',
        metadata: { operation: op, degenerateConditional: true, flagsRegisterUsed: false },
      });
    }
    return ctx.finish({
      controlEffect: {
        kind: 'conditional-branch',
        target: addressRef(target),
        fallthrough: addressRef(next),
        condition,
      },
      possibleFaults: [targetAlignmentFault()],
      family: 'control',
      metadata: { operation: op, predicate, flagsRegisterUsed: false, conditionKind: 'direct-register-comparison' },
    });
  }

  if (op === 'jal') {
    const target = address + BigInt(fields.imm);
    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));
    const isCallHint = linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rd);
    return ctx.finish({
      controlEffect: isCallHint
        ? { kind: 'call', target: addressRef(target), fallthrough: addressRef(next) }
        : { kind: 'branch', target: addressRef(target) },
      possibleFaults: [targetAlignmentFault()],
      family: 'control',
      metadata: {
        operation: op,
        direct: true,
        linkRegister: linked ? fields.rd : null,
        jumpWithLinkage: linked && !isCallHint,
        abiSemantics: false,
      },
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
      controlEffect: {
        kind,
        target,
        ...(kind === 'call' ? { fallthrough: addressRef(next) } : {}),
      },
      possibleFaults: [targetAlignmentFault()],
      family: 'control',
      metadata: {
        operation: op,
        indirect: true,
        linkRegister: linked ? fields.rd : null,
        returnAddressStackHint: isReturnHint ? fields.rs1 : null,
        jumpWithLinkage: linked && !isCallHint,
        abiSemantics: false,
      },
    });
  }

  return null;
}
