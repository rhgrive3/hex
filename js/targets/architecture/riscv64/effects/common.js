import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';
import { createRiscv64DecodedInstruction } from '../decoded-instruction.js';
import { riscv64RegisterDescriptor } from '../registers.js';

export const RISCV64_ARCHITECTURE_ID = 'riscv64';
export const RISCV64_MODE = 'rv64imc';
export const RISCV64_INSTRUCTION_ALIGNMENT = 2;
export const RISCV64_XLEN = 64;
export const RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION = '1.0.0-phase6-rv64imc';

/**
 * Effect-building context for RV64.
 *
 * Two RISC-V-specific rules are enforced here, once, so that no family lifter
 * can get them wrong:
 *
 *  - reading `x0` produces the constant 0 and emits no `register-read`, because
 *    `x0` is not storage;
 *  - writing `x0` is discarded and emits no `register-write`, because `x0` is
 *    architecturally immutable. Treating it as an ordinary register write would
 *    invent mutable state that the machine does not have.
 *
 * There is no `readFlag`/`writeFlag` here. RV64 has no condition-code register,
 * and Phase 6 deliberately does not synthesise one.
 */
export function createRiscv64EffectContext(decoded, context = {}) {
  const instruction = normalizeRiscv64Instruction(decoded, context);
  const instructionId = String(instruction.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('riscv64-effects-instruction-id-required');
  const mode = String(instruction.mode || RISCV64_MODE);
  const instructionAlignment = Number(context.instructionAlignment ?? instruction.instructionAlignment ?? RISCV64_INSTRUCTION_ALIGNMENT);
  if (!Number.isSafeInteger(instructionAlignment) || instructionAlignment < 2 || (instructionAlignment & (instructionAlignment - 1)) !== 0) {
    throw new TypeError('riscv64-invalid-instruction-alignment');
  }
  const options = context.machineEffectsOptions ?? context.options ?? {};
  const fields = instruction.fields;
  const operations = [];
  let operationCounter = 0;
  let temporaryCounter = 0;
  const discardedZeroWrites = [];

  function temporary(widthBits, label = 'tmp') {
    temporaryCounter += 1;
    return createTemporaryValue(`${instructionId}:${label}:${temporaryCounter}`, createBitVectorValue(widthBits));
  }

  function constant(widthBits, value) {
    return createBitVectorValue(widthBits, BigInt.asUintN(widthBits, BigInt(value)));
  }

  function addOperation(input) {
    operationCounter += 1;
    const operation = createMachineOperation({
      ...input,
      id: `${instructionId}:effect:${operationCounter}`,
      metadata: { sourceInstructionFamily: fields.op, originInstructionId: instructionId, ...(input.metadata || {}) },
    }, options);
    operations.push(operation);
    return operation;
  }

  function valueOp(opcode, inputs, widthBits, metadata = {}) {
    const output = temporary(widthBits, opcode.replace(/[^a-z0-9]+/gi, '-'));
    addOperation({ kind: 'value', opcode, inputs, outputs: [output], metadata });
    return output;
  }

  function readRegister(name) {
    const descriptor = riscv64RegisterDescriptor(name);
    if (!descriptor) throw new TypeError(`riscv64-effects-unknown-register:${name}`);
    if (descriptor.hardwiredZero) {
      // x0 is wired to zero. Emitting a register-read would model storage that
      // does not exist and would let SSA build a definition chain for it.
      return constant(RISCV64_XLEN, 0);
    }
    const physical = createRegisterValue(descriptor.physicalId, RISCV64_XLEN);
    const value = temporary(RISCV64_XLEN, `read-${descriptor.physicalId}`);
    addOperation({ kind: 'register-read', register: physical, value, metadata: { abiName: descriptor.abiName } });
    return value;
  }

  function writeRegister(name, value) {
    const descriptor = riscv64RegisterDescriptor(name);
    if (!descriptor) throw new TypeError(`riscv64-effects-unknown-register:${name}`);
    if (descriptor.hardwiredZero) {
      // Architecturally the result is discarded. Record that this happened so
      // the bundle metadata still explains the instruction's full behaviour.
      discardedZeroWrites.push(descriptor.physicalId);
      return false;
    }
    const physical = createRegisterValue(descriptor.physicalId, RISCV64_XLEN);
    addOperation({ kind: 'register-write', register: physical, value, metadata: { abiName: descriptor.abiName, writePolicy: 'replace' } });
    return true;
  }

  function memoryAccess(addressExpr, widthBits, config = {}) {
    return createMemoryAccess({
      space: 'memory',
      addressExpr,
      widthBits,
      endian: 'little',
      ...(config.alignment == null ? {} : { alignment: config.alignment }),
      ...(config.atomic == null ? {} : { atomic: config.atomic }),
      ...(config.ordering == null ? {} : { ordering: config.ordering }),
    }, options);
  }

  function readMemory(addressExpr, widthBits, config = {}) {
    const value = temporary(widthBits, 'memory-read');
    addOperation({ kind: 'memory-read', access: memoryAccess(addressExpr, widthBits, config), value, metadata: config.metadata });
    return value;
  }

  function writeMemory(addressExpr, widthBits, value, config = {}) {
    addOperation({ kind: 'memory-write', access: memoryAccess(addressExpr, widthBits, config), value, metadata: config.metadata });
  }

  /** trunc-to-32 then sign-extend-to-64: the RV64 `*W` result convention. */
  function signExtend32To64(value) {
    const narrow = valueOp('trunc', [value], 32, { fromBits: RISCV64_XLEN, toBits: 32 });
    return valueOp('sext', [narrow], RISCV64_XLEN, { fromBits: 32, toBits: RISCV64_XLEN });
  }

  function finish(config = {}) {
    const metadata = {
      family: config.family ?? 'integer',
      instructionFamily: fields.op,
      decoderContractVersion: instruction.contractVersion,
      compressed: fields.compressed === true,
      instructionAlignment,
      ...(instruction.isaIdentity == null ? {} : { isaIdentity:String(instruction.isaIdentity) }),
      ...(instruction.isaEvidence == null ? {} : { isaEvidence:String(instruction.isaEvidence) }),
      ...(instruction.compressedInstructions == null ? {} : { compressedInstructions:instruction.compressedInstructions === true }),
      ...(fields.expandedFrom == null ? {} : { compressedEncoding: fields.expandedFrom }),
      ...(discardedZeroWrites.length ? { discardedHardwiredZeroWrites: [...new Set(discardedZeroWrites)].sort() } : {}),
      ...(config.metadata || {}),
    };
    return createMachineEffectBundle({
      instructionId,
      architectureId: RISCV64_ARCHITECTURE_ID,
      mode,
      operations,
      controlEffect: config.controlEffect ?? { kind: 'fallthrough' },
      possibleFaults: config.possibleFaults ?? [],
      origin: instruction.origin ?? { instructionIds: [instructionId] },
      completeness: config.completeness ?? 'exact',
      ...(config.unknownEffects == null ? {} : { unknownEffects: config.unknownEffects }),
      ...(config.statePreservation == null ? {} : { statePreservation: config.statePreservation }),
      metadata,
    }, options);
  }

  function partial(reason, categories = ['other'], config = {}) {
    return finish({
      ...config,
      completeness: 'partial',
      unknownEffects: {
        categories,
        reason,
        preservation: 'not-assumed',
        ...(config.detail == null ? {} : { detail: config.detail }),
      },
      metadata: { failClosed: true, ...(config.metadata || {}) },
    });
  }

  return {
    instruction,
    instructionId,
    fields,
    mode,
    instructionAlignment,
    options,
    constant,
    temporary,
    addOperation,
    valueOp,
    readRegister,
    writeRegister,
    readMemory,
    writeMemory,
    signExtend32To64,
    finish,
    partial,
  };
}

export function normalizeRiscv64Instruction(decoded, context = {}) {
  if (decoded?.contractVersion === 'riscv64-decoded-instruction/v1' && decoded.instructionId && decoded.origin) return decoded;
  return createRiscv64DecodedInstruction({
    ...decoded,
    ...(decoded?.instructionId == null && context.instructionId != null ? { instructionId: context.instructionId } : {}),
    ...(decoded?.mode == null && context.mode != null ? { mode: context.mode } : {}),
    ...(decoded?.origin == null && context.origin != null ? { origin: context.origin } : {}),
  });
}

/**
 * RISC-V memory accesses may raise access, page, and misaligned-address
 * exceptions. The frozen Phase 6 profile does not model the privileged
 * architecture, so alignment cannot be proven and the fault stays explicit.
 */
export function riscv64MemoryFaults(direction, widthBits) {
  return Object.freeze([{
    kind: 'memory-access-fault',
    condition: { kind: 'riscv64-memory-fault', direction, widthBits },
    detail: { causes: ['access-fault', 'page-fault', 'address-misaligned'] },
  }]);
}
