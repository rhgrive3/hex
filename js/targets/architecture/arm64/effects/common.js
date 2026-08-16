import {
  createBitVectorValue,
  createFlagValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

export const ARM64_ARCHITECTURE_ID = 'arm64';
export const ARM64_MODE = 'a64';
export const ARM64_INSTRUCTION_BYTES = 4n;

export function bitMask(widthBits) {
  return (1n << BigInt(widthBits)) - 1n;
}

export function asUnsigned(value, widthBits) {
  return BigInt.asUintN(widthBits, BigInt(value));
}

export function asSigned(value, widthBits) {
  return BigInt.asIntN(widthBits, BigInt(value));
}

export function rotateRight(value, amount, widthBits) {
  const width = BigInt(widthBits);
  const shift = ((BigInt(amount) % width) + width) % width;
  const masked = asUnsigned(value, widthBits);
  if (shift === 0n) return masked;
  return asUnsigned((masked >> shift) | (masked << (width - shift)), widthBits);
}

export function instructionMnemonic(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}

export function instructionBits(op, fallback = 64) {
  const bits = Number(op?.bits ?? fallback);
  return bits === 32 || bits === 64 ? bits : fallback;
}

export function immediateOf(op) {
  if (!op || op.k !== 'imm' || op.value == null) return null;
  try { return BigInt(op.value); } catch { return null; }
}

export function conditionOf(instruction) {
  const operand = (instruction?.ops || []).find((op) => op?.k === 'cond');
  if (operand?.text) return String(operand.text).toLowerCase();
  const mnemonic = instructionMnemonic(instruction);
  if (mnemonic.startsWith('b.')) return mnemonic.slice(2);
  return null;
}

export function directTargetOf(instruction, kind = 'branch') {
  const explicit = kind === 'call' ? instruction?.callTarget : instruction?.branchTarget;
  if (explicit != null) {
    try { return BigInt(explicit); } catch { return null; }
  }
  const ops = instruction?.ops || [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const value = immediateOf(ops[i]);
    if (value != null) return value;
  }
  return null;
}

function originInput(instruction, instructionId, operationIds) {
  const base = instruction?.origin && typeof instruction.origin === 'object' && !Array.isArray(instruction.origin)
    ? instruction.origin
    : {};
  return {
    byteRanges: base.byteRanges || [],
    virtualRanges: base.virtualRanges || [],
    instructionIds: [...new Set([...(base.instructionIds || []).map(String), instructionId])],
    operationIds: [...new Set([...(base.operationIds || base.bytecodeOperationIds || []).map(String), ...operationIds])],
    sourceLocations: base.sourceLocations || [],
    parentEntityIds: base.parentEntityIds || [],
    transforms: base.transforms || [],
  };
}

function registerDescriptor(op) {
  if (!op || op.k !== 'reg') return null;
  const bits = instructionBits(op);
  if (op.cls === 'zr') return { kind: 'zero', bits };
  if (op.cls === 'sp') {
    return { kind: 'register', registerId: 'sp', bits, view: bits === 32 ? 'wsp' : 'sp' };
  }
  if (op.cls === 'gp' && Number.isInteger(op.num) && op.num >= 0 && op.num <= 30) {
    return { kind: 'register', registerId: `x${op.num}`, bits, view: bits === 32 ? `w${op.num}` : `x${op.num}` };
  }
  return null;
}

export function createArm64EffectContext(instruction, options = {}) {
  const mnemonic = instructionMnemonic(instruction);
  const instructionId = String(instruction?.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('arm64-effects-instruction-id-required');
  const mode = String(instruction?.mode || ARM64_MODE);
  const operations = [];
  const operationIds = [];
  let tempCounter = 0;
  let operationCounter = 0;

  function temp(widthBits, label = 'tmp') {
    tempCounter += 1;
    return createTemporaryValue(`${instructionId}:${label}:${tempCounter}`, createBitVectorValue(widthBits));
  }

  function constant(widthBits, value) {
    return createBitVectorValue(widthBits, asUnsigned(value, widthBits));
  }

  function addOperation(input) {
    operationCounter += 1;
    const id = `${instructionId}:effect:${operationCounter}`;
    const metadata = {
      originInstructionId: instructionId,
      sourceMnemonic: mnemonic,
      ...(input.metadata || {}),
    };
    const operation = createMachineOperation({ ...input, id, metadata }, options);
    operations.push(operation);
    operationIds.push(id);
    return operation;
  }

  function valueOp(opcode, inputs, widthBits, metadata = {}) {
    const output = temp(widthBits, opcode.replace(/[^a-z0-9]+/gi, '-'));
    addOperation({ kind: 'value', opcode, inputs, outputs: [output], metadata });
    return output;
  }

  function valueOpMulti(opcode, inputs, widths, metadata = {}) {
    const outputs = widths.map((widthBits, index) => temp(widthBits, `${opcode}-${index}`));
    addOperation({ kind: 'value', opcode, inputs, outputs, metadata });
    return outputs;
  }

  function readRegister(op) {
    const descriptor = registerDescriptor(op);
    if (!descriptor) return null;
    if (descriptor.kind === 'zero') return constant(descriptor.bits, 0n);
    const register = createRegisterValue(descriptor.registerId, descriptor.bits, { view: descriptor.view });
    const output = temp(descriptor.bits, `read-${descriptor.view}`);
    addOperation({ kind: 'register-read', register, value: output });
    return output;
  }

  function writeRegister(op, value) {
    const descriptor = registerDescriptor(op);
    if (!descriptor) return false;
    if (descriptor.kind === 'zero') return true;
    let writeValue = value;
    let writeBits = descriptor.bits;
    let view = descriptor.view;
    if (descriptor.bits === 32) {
      writeValue = valueOp('zext', [value], 64, { fromBits: 32, toBits: 64, reason: 'a64-w-register-write-zeroes-upper-32' });
      writeBits = 64;
      view = descriptor.registerId === 'sp' ? 'sp' : descriptor.registerId;
    }
    const register = createRegisterValue(descriptor.registerId, writeBits, { view });
    addOperation({ kind: 'register-write', register, value: writeValue });
    return true;
  }

  function readFlag(name) {
    const flag = createFlagValue(`NZCV.${name}`, 1);
    const output = temp(1, `read-${name}`);
    addOperation({ kind: 'flag-read', flag, value: output });
    return output;
  }

  function writeFlag(name, value) {
    addOperation({ kind: 'flag-write', flag: createFlagValue(`NZCV.${name}`, 1), value });
  }

  function truncate(value, fromBits, toBits) {
    if (fromBits === toBits) return value;
    if (fromBits < toBits) throw new TypeError('arm64-effects-invalid-truncation');
    return valueOp('trunc', [value], toBits, { fromBits, toBits });
  }

  function zeroExtend(value, fromBits, toBits) {
    if (fromBits === toBits) return value;
    if (fromBits > toBits) return truncate(value, fromBits, toBits);
    return valueOp('zext', [value], toBits, { fromBits, toBits });
  }

  function signExtend(value, fromBits, toBits) {
    if (fromBits === toBits) return value;
    if (fromBits > toBits) return truncate(value, fromBits, toBits);
    return valueOp('sext', [value], toBits, { fromBits, toBits });
  }

  function shiftImmediate(value, widthBits, kind, amount) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0 || n >= widthBits) return null;
    return valueOp(kind, [value, constant(widthBits, BigInt(n))], widthBits, { widthBits, amount: n });
  }

  function applyModifier(value, sourceBits, modifier, targetBits) {
    if (!modifier) {
      if (sourceBits === targetBits) return value;
      return sourceBits < targetBits ? zeroExtend(value, sourceBits, targetBits) : truncate(value, sourceBits, targetBits);
    }
    const kind = String(modifier.op || '').toLowerCase();
    const amount = modifier.amount == null ? 0 : Number(modifier.amount);
    const extendBits = {
      uxtb: 8, uxth: 16, uxtw: 32, uxtx: 64,
      sxtb: 8, sxth: 16, sxtw: 32, sxtx: 64,
    }[kind];
    if (extendBits != null) {
      if (!Number.isInteger(amount) || amount < 0 || amount > 4 || extendBits > sourceBits) return null;
      let out = sourceBits === extendBits ? value : truncate(value, sourceBits, extendBits);
      out = kind[0] === 's' ? signExtend(out, extendBits, targetBits) : zeroExtend(out, extendBits, targetBits);
      return amount === 0 ? out : shiftImmediate(out, targetBits, 'shl', amount);
    }
    if (!['lsl', 'lsr', 'asr', 'ror'].includes(kind)) return null;
    let out = sourceBits === targetBits ? value : (sourceBits < targetBits ? zeroExtend(value, sourceBits, targetBits) : truncate(value, sourceBits, targetBits));
    return shiftImmediate(out, targetBits, kind === 'lsl' ? 'shl' : kind === 'lsr' ? 'lshr' : kind === 'asr' ? 'ashr' : 'ror', amount);
  }

  function readOperand(op, targetBits = instructionBits(op)) {
    if (!op) return null;
    if (op.k === 'imm') {
      const value = immediateOf(op);
      if (value == null) return null;
      const base = constant(targetBits, value);
      return applyModifier(base, targetBits, op.shift || null, targetBits);
    }
    if (op.k === 'reg') {
      const sourceBits = instructionBits(op, targetBits);
      const base = readRegister(op);
      if (!base) return null;
      return applyModifier(base, sourceBits, op.shift || null, targetBits);
    }
    return null;
  }

  function finish({
    controlEffect = { kind: 'fallthrough' },
    possibleFaults = [],
    completeness = 'exact',
    unknownEffects,
    metadata,
    statePreservation,
  } = {}) {
    const bundle = {
      instructionId,
      architectureId: ARM64_ARCHITECTURE_ID,
      mode,
      operations,
      controlEffect,
      possibleFaults,
      origin: originInput(instruction, instructionId, operationIds),
      completeness,
      ...(unknownEffects ? { unknownEffects } : {}),
      ...(metadata ? { metadata: { sourceMnemonic: mnemonic, ...metadata } } : {}),
      ...(statePreservation ? { statePreservation } : {}),
    };
    return createMachineEffectBundle(bundle, options);
  }

  function partial(reason, categories = ['other'], detail = undefined, controlEffect = { kind: 'fallthrough' }) {
    return finish({
      controlEffect,
      completeness: 'partial',
      unknownEffects: {
        categories,
        reason,
        ...(detail === undefined ? {} : { detail }),
      },
      metadata: { failClosed: true },
    });
  }

  return {
    instruction,
    instructionId,
    mnemonic,
    mode,
    operations,
    constant,
    temp,
    addOperation,
    valueOp,
    valueOpMulti,
    readRegister,
    writeRegister,
    readFlag,
    writeFlag,
    truncate,
    zeroExtend,
    signExtend,
    shiftImmediate,
    applyModifier,
    readOperand,
    finish,
    partial,
  };
}
