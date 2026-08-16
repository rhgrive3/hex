import {
  ARM64_INSTRUCTION_BYTES,
  createArm64EffectContext,
  directTargetOf,
  immediateOf,
  instructionBits,
} from './common.js';
import { emitArm64Condition } from './flags.js';

const DIRECT_BRANCH = new Set(['b','bl']);
const INDIRECT_BRANCH = new Set(['br','blr']);
const COMPARE_BRANCH = new Set(['cbz','cbnz']);
const TEST_BRANCH = new Set(['tbz','tbnz']);

export function isArm64ControlEffectMnemonic(mnemonic) {
  const base = String(mnemonic || '').toLowerCase();
  return DIRECT_BRANCH.has(base) || INDIRECT_BRANCH.has(base) || COMPARE_BRANCH.has(base)
    || TEST_BRANCH.has(base) || base === 'ret' || /^b\.(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/.test(base);
}

function addressRef(address) {
  return { kind: 'absolute-address', value: BigInt(address).toString(), widthBits: 64 };
}

function instructionAddress(instruction) {
  try { return instruction?.address == null ? null : BigInt(instruction.address); }
  catch { return null; }
}

function fallthroughRef(instruction) {
  const address = instructionAddress(instruction);
  return address == null ? null : addressRef(address + ARM64_INSTRUCTION_BYTES);
}

function sameAbsoluteTarget(target, reference) {
  if (target == null || reference?.kind !== 'absolute-address' || reference.value == null) return false;
  try { return BigInt(target) === BigInt(reference.value); }
  catch { return false; }
}

/**
 * Preserve condition-evaluation operations even when both control outcomes land
 * in the same basic block, but canonicalize the externally visible control edge
 * to one unconditional branch. Semantic IR forbids duplicate node targets, and
 * two identical successors carry no conditional control distinction.
 */
function conditionalControlEffect(target, fallthrough, condition) {
  if (sameAbsoluteTarget(target, fallthrough)) {
    return { kind:'branch', target:addressRef(target), degenerateCondition:condition };
  }
  return { kind:'conditional-branch', target:addressRef(target), fallthrough, condition };
}

function targetAlignmentFault() {
  return {
    kind: 'pc-alignment-fault',
    condition: { kind: 'target-misaligned', alignmentBytes: 4 },
    detail: { architecture: 'arm64', instructionSet: 'a64' },
  };
}

function gpRegister(num) {
  return { k: 'reg', cls: 'gp', num, bits: 64, text: `x${num}` };
}

export function liftArm64ControlEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  if (!isArm64ControlEffectMnemonic(mnemonic)) return null;
  const ctx = createArm64EffectContext(instruction, options);
  const ops = instruction?.ops || [];

  if (mnemonic === 'b') {
    const target = directTargetOf(instruction, 'branch');
    if (target == null) return ctx.partial('arm64-b-target-unavailable', ['control'], undefined, { kind: 'unknown', reason: 'arm64-b-target-unavailable' });
    return ctx.finish({
      controlEffect: { kind: 'branch', target: addressRef(target) },
      metadata: { family: 'control', operation: 'b', direct: true },
    });
  }

  if (mnemonic === 'br') {
    const target = ctx.readRegister(ops[0]);
    if (!target || instructionBits(ops[0]) !== 64) {
      return ctx.partial('arm64-br-target-register-unmodelled', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-br-target-register-unmodelled' });
    }
    return ctx.finish({
      controlEffect: { kind: 'indirect', target },
      possibleFaults: [targetAlignmentFault()],
      metadata: { family: 'control', operation: 'br', indirect: true },
    });
  }

  if (mnemonic === 'bl') {
    const target = directTargetOf(instruction, 'call');
    if (target == null) return ctx.partial('arm64-bl-target-unavailable', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-bl-target-unavailable' });
    const fallthrough = fallthroughRef(instruction);
    const address = instructionAddress(instruction);
    if (address == null) {
      return ctx.partial('arm64-bl-link-address-unavailable', ['registers'], undefined, { kind: 'call', target: addressRef(target) });
    }
    ctx.writeRegister(gpRegister(30), ctx.constant(64, address + ARM64_INSTRUCTION_BYTES));
    return ctx.finish({
      controlEffect: { kind: 'call', target: addressRef(target), ...(fallthrough ? { fallthrough } : {}) },
      metadata: { family: 'control', operation: 'bl', direct: true, abiSemantics: false },
    });
  }

  if (mnemonic === 'blr') {
    const target = ctx.readRegister(ops[0]);
    const address = instructionAddress(instruction);
    if (!target || instructionBits(ops[0]) !== 64) {
      return ctx.partial('arm64-blr-target-register-unmodelled', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-blr-target-register-unmodelled' });
    }
    if (address == null) {
      return ctx.partial('arm64-blr-link-address-unavailable', ['registers'], undefined, { kind: 'call', target });
    }
    ctx.writeRegister(gpRegister(30), ctx.constant(64, address + ARM64_INSTRUCTION_BYTES));
    return ctx.finish({
      controlEffect: { kind: 'call', target, ...(fallthroughRef(instruction) ? { fallthrough: fallthroughRef(instruction) } : {}) },
      possibleFaults: [targetAlignmentFault()],
      metadata: { family: 'control', operation: 'blr', indirect: true, abiSemantics: false },
    });
  }

  if (mnemonic === 'ret') {
    const operand = ops[0] || gpRegister(30);
    const target = ctx.readRegister(operand);
    if (!target || instructionBits(operand) !== 64) {
      return ctx.partial('arm64-ret-target-register-unmodelled', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-ret-target-register-unmodelled' });
    }
    return ctx.finish({
      controlEffect: { kind: 'return', target },
      possibleFaults: [targetAlignmentFault()],
      metadata: { family: 'control', operation: 'ret', abiSemantics: false },
    });
  }

  const target = directTargetOf(instruction, 'branch');
  const fallthrough = fallthroughRef(instruction);
  if (target == null || !fallthrough) {
    return ctx.partial(`arm64-${mnemonic}-targets-unavailable`, ['control'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-targets-unavailable` });
  }

  if (COMPARE_BRANCH.has(mnemonic)) {
    const widthBits = instructionBits(ops[0]);
    const value = ctx.readOperand(ops[0], widthBits);
    if (!value) return ctx.partial(`arm64-${mnemonic}-operand-unmodelled`, ['control','registers'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-operand-unmodelled` });
    let condition = ctx.valueOp('is-zero', [value], 1, { widthBits });
    if (mnemonic === 'cbnz') condition = ctx.valueOp('not-bool', [condition], 1);
    return ctx.finish({
      controlEffect: conditionalControlEffect(target, fallthrough, condition),
      metadata: { family: 'control', operation: mnemonic, conditionKind: mnemonic, ...(sameAbsoluteTarget(target, fallthrough) ? { degenerateConditional:true } : {}) },
    });
  }

  if (TEST_BRANCH.has(mnemonic)) {
    const widthBits = instructionBits(ops[0]);
    const value = ctx.readOperand(ops[0], widthBits);
    const bit = immediateOf(ops[1]);
    if (!value || bit == null || bit < 0n || bit >= BigInt(widthBits)) {
      return ctx.partial(`arm64-${mnemonic}-bit-test-unmodelled`, ['control','registers'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-bit-test-unmodelled` });
    }
    const tested = ctx.valueOp('extract-bit', [value], 1, { bit: Number(bit), widthBits });
    const condition = mnemonic === 'tbz' ? ctx.valueOp('is-zero', [tested], 1, { widthBits: 1 }) : tested;
    return ctx.finish({
      controlEffect: conditionalControlEffect(target, fallthrough, condition),
      metadata: { family: 'control', operation: mnemonic, bit: Number(bit), ...(sameAbsoluteTarget(target, fallthrough) ? { degenerateConditional:true } : {}) },
    });
  }

  const conditionCode = mnemonic.slice(2);
  const condition = emitArm64Condition(ctx, conditionCode);
  if (!condition) return ctx.partial(`arm64-${mnemonic}-condition-unmodelled`, ['control','flags'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-condition-unmodelled` });
  return ctx.finish({
    controlEffect: conditionalControlEffect(target, fallthrough, condition),
    metadata: { family: 'control', operation: mnemonic, conditionCode, ...(sameAbsoluteTarget(target, fallthrough) ? { degenerateConditional:true } : {}) },
  });
}