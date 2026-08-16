import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
} from '../../js/semantics/effects/index.js';

export const TEST_SEMANTIC_VERSIONS = Object.freeze({
  machineEffects: 'machine-effects/v1',
  architecture: 'arm64-test/v1',
  compatibility: 'legacy-v1-test/v1',
});

export function instructionId(address = 0x1000n) {
  return createInstructionId({
    binaryId: 'bin_machine_effects_verification',
    sliceId: 'slice_arm64',
    virtualAddress: BigInt(address),
    decodeMode: 'a64',
    decoderSemanticVersion: 'decoder-test/v1',
  });
}

export function origin(address = 0x1000n) {
  const id = instructionId(address);
  return {
    instructionIds: [id],
    byteRanges: [{
      binaryId: 'bin_machine_effects_verification',
      start: BigInt(address),
      end: BigInt(address) + 4n,
    }],
  };
}

export function exactWriteBundle({
  address = 0x1000n,
  register = 'x0',
  widthBits = 64,
  value = 1n,
  metadata = undefined,
} = {}) {
  return createMachineEffectBundle({
    instructionId: instructionId(address),
    architectureId: 'arm64',
    mode: 'a64',
    operations: [createMachineOperation({
      kind: 'register-write',
      register: createRegisterValue(register, widthBits),
      value: createBitVectorValue(widthBits, BigInt(value)),
      ...(metadata === undefined ? {} : { metadata }),
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: origin(address),
    completeness: 'exact',
  });
}

export function provenNoopBundle({ address = 0x1000n, reason = 'architecturally defined no-op' } = {}) {
  return createMachineEffectBundle({
    instructionId: instructionId(address),
    architectureId: 'arm64',
    mode: 'a64',
    operations: [],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: origin(address),
    completeness: 'exact',
    statePreservation: { proven: true, reason },
  });
}

export function unknownBundle({ address = 0x1000n, reason = 'unsupported instruction semantics' } = {}) {
  return createMachineEffectBundle({
    instructionId: instructionId(address),
    architectureId: 'arm64',
    mode: 'a64',
    operations: [],
    controlEffect: { kind: 'unknown', reason },
    possibleFaults: [],
    origin: origin(address),
    completeness: 'unknown',
    unknownEffects: {
      categories: ['registers', 'flags', 'memory', 'control', 'faults'],
      reason,
    },
  });
}
