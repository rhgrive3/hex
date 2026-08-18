import {
  createBitVectorValue,
  createFlagValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';
import { createX86DecodedInstruction } from '../decoded-instruction.js';
import { x86RegisterDescriptor } from '../registers.js';

export const X86_64_ARCHITECTURE_ID = 'x86_64';
export const X86_64_MODE = 'long-64';
export const X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION = '5.1.0-phase5-integrated';

const X86_ATOMIC_ORDERING_AUTHORITY = 'Intel SDM Vol.3 locked-instruction total-order/no-reordering rules';
const X86_ATOMIC_ORDERING_CONTRACT = 'x86-locked-rmw-seq-cst/v1';
const X86_MXCSR_CONTRACT = 'x86-mxcsr/v1';

function mask(bits) { return (1n << BigInt(bits)) - 1n; }
function unsigned(value, bits) { return BigInt(value) & mask(bits); }

function valueWidth(value) {
  if (value?.kind === 'temporary') return Number(value.valueType?.widthBits || 0);
  return Number(value?.widthBits || 0);
}

function registerOperand(value) {
  if (value?.type === 'register' && value.register) return value;
  const register = x86RegisterDescriptor(value);
  return register ? Object.freeze({ type:'register', register, widthBits:register.viewBits, access:'unknown' }) : null;
}

export function normalizeX86Instruction(decoded, context = {}) {
  return createX86DecodedInstruction({
    ...decoded,
    ...(decoded?.instructionId == null && context.instructionId != null ? { instructionId:context.instructionId } : {}),
    ...(decoded?.mode == null && context.mode != null ? { mode:context.mode } : {}),
    ...(decoded?.origin == null && context.origin != null ? { origin:context.origin } : {}),
  });
}

export function createX86EffectContext(decoded, context = {}) {
  const instruction = normalizeX86Instruction(decoded, context);
  const instructionId = String(instruction.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('x86-effects-instruction-id-required');
  const mode = String(instruction.mode || X86_64_MODE);
  const options = context.machineEffectsOptions ?? context.options ?? {};
  const family = String(instruction.instructionFamily || '').toLowerCase();
  const operands = instruction.detail.operands;
  const operations = [];
  let operationCounter = 0;
  let temporaryCounter = 0;
  let hasIntrinsic = false;

  function temporary(widthBits, label = 'tmp') {
    temporaryCounter++;
    return createTemporaryValue(`${instructionId}:${label}:${temporaryCounter}`, createBitVectorValue(widthBits));
  }

  function constant(widthBits, value) { return createBitVectorValue(widthBits, unsigned(value, widthBits)); }

  function addOperation(input) {
    operationCounter++;
    const operation = createMachineOperation({
      ...input,
      id:`${instructionId}:effect:${operationCounter}`,
      metadata:{ sourceInstructionFamily:family, originInstructionId:instructionId, ...(input.metadata || {}) },
    }, options);
    if (operation.kind === 'intrinsic') hasIntrinsic = true;
    operations.push(operation);
    return operation;
  }

  function valueOp(opcode, inputs, widthBits, metadata = {}) {
    const output = temporary(widthBits, opcode.replace(/[^a-z0-9]+/gi, '-'));
    addOperation({ kind:'value', opcode, inputs, outputs:[output], metadata });
    return output;
  }

  function intrinsic(intrinsicId, inputs, outputWidths, config = {}) {
    const fpEnvironmentDependency = String(config.metadata?.fpEnvironmentDependency || '');
    const usesMxcsr = fpEnvironmentDependency.includes('MXCSR');
    let effectiveInputs = [...inputs];
    let effectiveOutputWidths = [...outputWidths];
    let registersRead = [...(config.registersRead ?? [])];
    let registersWritten = [...(config.registersWritten ?? [])];
    let mxcsrOperand = null;

    if (usesMxcsr) {
      mxcsrOperand = registerOperand('mxcsr');
      const currentMxcsr = mxcsrOperand ? readRegister(mxcsrOperand) : null;
      if (!currentMxcsr) throw new TypeError('x86-mxcsr-physical-state-unavailable');
      effectiveInputs.push(currentMxcsr);
      effectiveOutputWidths.push(32);
      registersRead = [...new Set([...registersRead, 'mxcsr'])].sort();
      registersWritten = [...new Set([...registersWritten, 'mxcsr'])].sort();
    }

    const outputs = effectiveOutputWidths.map((widthBits, index) => temporary(widthBits, `${intrinsicId}-${index}`));
    addOperation({
      kind:'intrinsic',
      intrinsicId,
      effectSummary:createIntrinsicEffectSummary({
        inputs:effectiveInputs,
        outputs,
        registersRead,
        registersWritten,
        memoryRead:config.memoryRead ?? { scope:'none' },
        memoryWrite:config.memoryWrite ?? { scope:'none' },
        controlEffects:config.controlEffects ?? [],
        determinism:usesMxcsr ? 'input-dependent' : (config.determinism ?? 'input-dependent'),
        symbolicDetail:config.symbolicDetail ?? 'summary-only',
      }, options),
      metadata:{
        summaryContractVersion:'x86-intrinsic-summary/v1',
        ...(config.metadata || {}),
        ...(usesMxcsr ? {
          fpEnvironmentModeled:true,
          fpEnvironmentContract:X86_MXCSR_CONTRACT,
          exactArchitecturalSummary:true,
          mxcsrState:Object.freeze({
            exceptionStatusBits:'5:0',
            denormalsAreZeroBit:6,
            exceptionMaskBits:'12:7',
            roundingControlBits:'14:13',
            flushToZeroBit:15,
            reservedBitsPreserved:true,
            output:'next-mxcsr',
          }),
        } : {}),
      },
    });

    if (usesMxcsr) {
      const nextMxcsr = outputs[outputs.length - 1];
      if (!writeRegister(mxcsrOperand, nextMxcsr)) throw new TypeError('x86-mxcsr-physical-state-write-failed');
      return outputs.slice(0, outputWidths.length);
    }
    return outputs;
  }

  function readRegister(input) {
    const operand = registerOperand(input);
    if (!operand) return null;
    const descriptor = operand.register;
    const physical = createRegisterValue(descriptor.physicalId, descriptor.physicalBits, { view:descriptor.id });
    const full = temporary(descriptor.physicalBits, `read-${descriptor.id}`);
    addOperation({ kind:'register-read', register:physical, value:full, metadata:{ view:descriptor.id } });
    if (descriptor.viewBits === descriptor.physicalBits && descriptor.lsb === 0) return full;
    return valueOp('extract', [full], descriptor.viewBits, {
      lsb:descriptor.lsb,
      widthBits:descriptor.viewBits,
      physicalBits:descriptor.physicalBits,
      physicalId:descriptor.physicalId,
      view:descriptor.id,
    });
  }

  function coerce(value, fromBits, toBits, signed = false) {
    if (fromBits === toBits) return value;
    if (fromBits > toBits) return valueOp('trunc', [value], toBits, { fromBits, toBits });
    return valueOp(signed ? 'sext' : 'zext', [value], toBits, { fromBits, toBits });
  }

  function writeRegister(input, value) {
    const operand = registerOperand(input);
    if (!operand) return false;
    const descriptor = operand.register;
    let source = value;
    let bits = valueWidth(source) || descriptor.viewBits;
    source = coerce(source, bits, descriptor.viewBits, false);
    bits = descriptor.viewBits;
    if (descriptor.kind === 'vector' && descriptor.viewBits !== descriptor.physicalBits) return false;
    if (descriptor.writePolicy === 'zero-extend-32') {
      source = coerce(source, bits, descriptor.physicalBits, false);
    } else if (descriptor.viewBits !== descriptor.physicalBits || descriptor.lsb !== 0) {
      const old = readRegister(descriptor.physicalId);
      source = valueOp('insert', [old, source], descriptor.physicalBits, {
        lsb:descriptor.lsb,
        widthBits:descriptor.viewBits,
        physicalBits:descriptor.physicalBits,
        physicalId:descriptor.physicalId,
        view:descriptor.id,
        writePolicy:'preserve-unaffected',
      });
    }
    const physical = createRegisterValue(descriptor.physicalId, descriptor.physicalBits, { view:descriptor.id });
    addOperation({ kind:'register-write', register:physical, value:source, metadata:{ view:descriptor.id, writePolicy:descriptor.writePolicy } });
    return true;
  }

  function readFlag(name) {
    const normalized = String(name).toUpperCase();
    const flag = createFlagValue(`RFLAGS.${normalized}`, 1);
    const output = temporary(1, `read-${normalized}`);
    addOperation({ kind:'flag-read', flag, value:output });
    return output;
  }

  function writeFlag(name, value, metadata = {}) {
    addOperation({ kind:'flag-write', flag:createFlagValue(`RFLAGS.${String(name).toUpperCase()}`, 1), value, metadata });
  }

  function memoryAccess(addressExpr, widthBits, config = {}) {
    return createMemoryAccess({
      space:config.space ?? 'memory',
      addressExpr,
      widthBits,
      endian:'little',
      ...(config.alignment == null ? {} : { alignment:config.alignment }),
      ...(config.atomic == null ? {} : { atomic:config.atomic }),
      ...(config.ordering == null ? {} : { ordering:config.ordering }),
      ...(config.volatility == null ? {} : { volatility:config.volatility }),
    }, options);
  }

  function readMemory(addressExpr, widthBits, config = {}) {
    const value = temporary(widthBits, 'memory-read');
    addOperation({ kind:'memory-read', access:memoryAccess(addressExpr, widthBits, config), value, metadata:config.metadata });
    return value;
  }

  function writeMemory(addressExpr, widthBits, value, config = {}) {
    addOperation({ kind:'memory-write', access:memoryAccess(addressExpr, widthBits, config), value, metadata:config.metadata });
  }

  function readOperand(operand, targetBits = operand?.widthBits, config = {}) {
    if (!operand) return null;
    if (operand.type === 'register') {
      const value = readRegister(operand);
      return value ? coerce(value, operand.widthBits, targetBits, config.signed === true) : null;
    }
    if (operand.type === 'immediate') return constant(targetBits, operand.value);
    return null;
  }

  function integratedAtomicOrdering(operation) {
    if (!['memory-read','memory-write'].includes(operation.kind) || operation.access?.atomic !== true || operation.access.ordering != null) return operation;
    return createMachineOperation({
      ...operation,
      access:createMemoryAccess({ ...operation.access, ordering:'seq-cst' }, options),
      metadata:{ ...(operation.metadata || {}), orderingContract:X86_ATOMIC_ORDERING_CONTRACT },
    }, options);
  }

  function integratedMxcsrFault(fault) {
    if (fault?.condition?.kind !== 'mxcsr-exception-state-unmodelled') return fault;
    return Object.freeze({
      ...fault,
      condition:Object.freeze({
        ...fault.condition,
        kind:'mxcsr-unmasked-floating-point-exception',
        maskBits:'MXCSR[12:7]',
        statusBits:'MXCSR[5:0]',
      }),
      detail:Object.freeze({ ...(fault.detail || {}), environmentContract:X86_MXCSR_CONTRACT }),
    });
  }

  function finish(config = {}) {
    const integratedOperations = operations.map(integratedAtomicOrdering);
    const hasMappedAtomicOrdering = integratedOperations.some((operation) =>
      ['memory-read','memory-write'].includes(operation.kind)
      && operation.access?.atomic === true
      && operation.access.ordering === 'seq-cst');
    const hasMxcsrIntrinsic = integratedOperations.some((operation) =>
      operation.kind === 'intrinsic' && operation.metadata?.fpEnvironmentContract === X86_MXCSR_CONTRACT);

    let completeness = config.completeness ?? (hasIntrinsic ? 'exact-with-intrinsic' : 'exact');
    let unknownEffects = config.unknownEffects;
    let possibleFaults = config.possibleFaults ?? [];
    let metadata = { family:config.family ?? 'foundation', instructionFamily:family, decoderContractVersion:instruction.contractVersion, ...(config.metadata || {}) };

    if (hasMappedAtomicOrdering) {
      metadata = {
        ...metadata,
        orderingMapping:'seq-cst',
        orderingAuthority:X86_ATOMIC_ORDERING_AUTHORITY,
        orderingContract:X86_ATOMIC_ORDERING_CONTRACT,
        orderingScope:'proven-atomic-rmw-only',
      };
      if (unknownEffects?.reason === 'x86-locked-memory-ordering-not-representable-by-frozen-p5-0-contract'
        || unknownEffects?.reason === 'x86-atomic-ordering-not-mapped-by-frozen-p5-0-contract') {
        unknownEffects = undefined;
        completeness = hasIntrinsic ? 'exact-with-intrinsic' : 'exact';
      } else if (unknownEffects?.reason === 'x86-cmpxchg-conditional-store-and-atomic-ordering-not-fully-representable') {
        unknownEffects = {
          ...unknownEffects,
          reason:'x86-cmpxchg-conditional-store-not-fully-representable',
          detail:{ ...(unknownEffects.detail || {}), ordering:'seq-cst-mapped', orderingContract:X86_ATOMIC_ORDERING_CONTRACT },
        };
        completeness = 'partial';
      }
    }

    if (hasMxcsrIntrinsic && unknownEffects?.reason === 'x86-fp-environment-state-unmodelled') {
      unknownEffects = undefined;
      possibleFaults = possibleFaults.map(integratedMxcsrFault);
      completeness = 'exact-with-intrinsic';
      const { failClosed:_legacyFailClosed, ...restMetadata } = metadata;
      metadata = {
        ...restMetadata,
        fpEnvironmentModeled:true,
        fpEnvironmentContract:X86_MXCSR_CONTRACT,
        environmentEffect:'intrinsic-consumes-and-produces-canonical-mxcsr',
      };
    }

    return createMachineEffectBundle({
      instructionId,
      architectureId:X86_64_ARCHITECTURE_ID,
      mode,
      operations:integratedOperations,
      controlEffect:config.controlEffect ?? { kind:'fallthrough' },
      possibleFaults,
      origin:instruction.origin ?? { instructionIds:[instructionId] },
      completeness,
      ...(unknownEffects == null ? {} : { unknownEffects }),
      ...(config.statePreservation == null ? {} : { statePreservation:config.statePreservation }),
      metadata,
    }, options);
  }

  function partial(reason, categories = ['other'], config = {}) {
    return finish({
      ...config,
      completeness:'partial',
      unknownEffects:{ categories, reason, preservation:'not-assumed', ...(config.detail == null ? {} : { detail:config.detail }) },
      metadata:{ failClosed:true, ...(config.metadata || {}) },
    });
  }

  return {
    instruction,
    instructionId,
    family,
    operands,
    operations,
    constant,
    temporary,
    addOperation,
    valueOp,
    intrinsic,
    readRegister,
    writeRegister,
    readFlag,
    writeFlag,
    coerce,
    readOperand,
    readMemory,
    writeMemory,
    finish,
    partial,
  };
}

export function x86RegisterOperand(name) { return registerOperand(name); }
export function x86MemoryFaults(direction, widthBits) {
  return Object.freeze([{
    kind:'memory-access-fault',
    condition:{ kind:'x86-memory-fault', direction, widthBits },
    detail:{ causes:['segment','non-canonical-address','page','protection','alignment-check'] },
  }]);
}
