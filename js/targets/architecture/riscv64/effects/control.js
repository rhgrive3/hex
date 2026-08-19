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
 *  - `jal`/`jalr` write a link value to rd. rd == x0 means no link is created,
 *    so the transfer is a plain (possibly indirect) jump.
 *  - For `jalr` with rd == x0, the ISA's own return-address-stack prediction
 *    table treats rs1 in {x1, x5} as a *return*. That hint is part of the
 *    unprivileged ISA, so using it here does not import psABI knowledge. Which
 *    register a calling convention actually designates as the return address is
 *    left to the ABI plugin.
 */

const BRANCH_PREDICATE = Object.freeze({
  beq: { predicate: 'eq', signed: null },
  bne: { predicate: 'ne', signed: null },
  blt: { predicate: 'slt', signed: true },
  bge: { predicate: 'sge', signed: true },
  bltu: { predicate: 'ult', signed: false },
  bgeu: { predicate: 'uge', signed: false },
});

/** ISA "Control Transfer Instructions": link registers used by the RAS hint. */
const RETURN_ADDRESS_HINT_REGISTERS = Object.freeze(['x1', 'x5']);

function addressRef(value) {
  return { kind: 'absolute-address', value: BigInt(value) };
}

function targetAlignmentFault(instructionAlignment) {
  // IALIGN=16 (2 bytes) makes every architecturally representable branch/JAL
  // immediate target aligned, while JALR clears bit 0. Therefore an
  // instruction-address-misaligned exception is impossible for the frozen C
  // profile. Keep the helper profile-driven so an IALIGN=32 profile can opt in
  // without reintroducing a hard-coded mode test.
  const alignmentBytes = Number(instructionAlignment);
  if (alignmentBytes <= 2) return null;
  return {
    kind: 'pc-alignment-fault',
    condition: { kind: 'riscv64-target-misaligned', alignmentBytes },
    detail: { architecture: 'riscv64', instructionAlignment: alignmentBytes },
  };
}

function targetAlignmentFaults(ctx) {
  const fault = targetAlignmentFault(ctx.instructionAlignment);
  return fault == null ? [] : [fault];
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
      // A branch whose taken target is the fallthrough is architecturally still
      // a conditional branch, but it has one successor. Report it honestly
      // rather than inventing a second edge.
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
      possibleFaults: targetAlignmentFaults(ctx),
      family: 'control',
      metadata: { operation: op, predicate, flagsRegisterUsed: false, conditionKind: 'direct-register-comparison' },
    });
  }

  if (op === 'jal') {
    const target = address + BigInt(fields.imm);
    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));
    return ctx.finish({
      controlEffect: linked
        ? { kind: 'call', target: addressRef(target), fallthrough: addressRef(next) }
        : { kind: 'branch', target: addressRef(target) },
      possibleFaults: targetAlignmentFaults(ctx),
      family: 'control',
      metadata: { operation: op, direct: true, linkRegister: linked ? fields.rd : null, abiSemantics: false },
    });
  }

  if (op === 'jalr') {
    // target = (rs1 + imm) with bit 0 cleared, per the ISA definition of JALR.
    const base = ctx.readRegister(fields.rs1);
    const sum = ctx.valueOp('add', [base, ctx.constant(RISCV64_XLEN, fields.imm)], RISCV64_XLEN, { addressArithmetic: 'jalr-target' });
    const target = ctx.valueOp('and', [sum, ctx.constant(RISCV64_XLEN, -2n)], RISCV64_XLEN, { targetLowBitCleared: true });
    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));
    const isReturnHint = !linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rs1);
    const kind = linked ? 'call' : isReturnHint ? 'return' : 'indirect';
    return ctx.finish({
      controlEffect: {
        kind,
        target,
        ...(kind === 'call' ? { fallthrough: addressRef(next) } : {}),
      },
      possibleFaults: targetAlignmentFaults(ctx),
      family: 'control',
      metadata: {
        operation: op,
        indirect: true,
        linkRegister: linked ? fields.rd : null,
        returnAddressStackHint: isReturnHint ? fields.rs1 : null,
        abiSemantics: false,
      },
    });
  }

  return null;
}
