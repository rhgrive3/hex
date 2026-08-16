import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  deserializeMachineEffectBundle,
  serializeMachineEffectBundle,
  validateMachineEffectBundle,
} from '../../js/semantics/effects/index.js';

const INST = createInstructionId({ binaryId: 'bin_serialization', sliceId: 'slice_serialization', virtualAddress: 0x100n, decodeMode: 'a64', decoderSemanticVersion: '1' });
function makeBundle() {
  return createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [createMachineOperation({
      kind: 'register-write',
      register: createRegisterValue('x0', 64),
      value: createBitVectorValue(64, 0xffffffffffffffffn),
      metadata: { z: 2, a: 1 },
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: {
      instructionIds: [INST],
      byteRanges: [{ binaryId: 'bin_serialization', start: 0x100n, end: 0x104n }],
      parentEntityIds: ['entity_parent'],
    },
    completeness: 'exact',
  });
}

{
  const first = serializeMachineEffectBundle(makeBundle());
  const second = serializeMachineEffectBundle(makeBundle());
  assert.equal(first, second, 'serialization must be deterministic');
  const parsed = deserializeMachineEffectBundle(first);
  assert.equal(serializeMachineEffectBundle(parsed), first, 'roundtrip serialization must be stable');
  assert.deepEqual(parsed.origin.instructionIds, [INST]);
  assert.deepEqual(parsed.origin.parentEntityIds, ['entity_parent']);
  assert.equal(parsed.operations[0].value.value, '18446744073709551615', 'BigInt follows project string serialization convention');
}

{
  const bundle = makeBundle();
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.operations), true);
  assert.equal(Object.isFrozen(bundle.operations[0]), true);
  assert.equal(Object.isFrozen(bundle.origin), true);
  assert.throws(() => { bundle.operations.push({}); }, TypeError);
}

{
  const valid = JSON.parse(serializeMachineEffectBundle(makeBundle()));
  assert.throws(() => validateMachineEffectBundle({ ...valid, schemaVersion: 999 }), /unsupported-contract-version/);
  assert.throws(() => deserializeMachineEffectBundle('{not json'), /invalid-serialized-json/);
  assert.throws(() => createMachineEffectBundle({ ...valid, possibleFaults: null }), /possible-faults-required/);
  assert.throws(() => createMachineOperation({ kind: 'value', opcode: 'bad', inputs: [() => 1], outputs: [createBitVectorValue(1, 0n)] }), /invalid-value/);
}

console.log('machine-effects serialization: PASS');
