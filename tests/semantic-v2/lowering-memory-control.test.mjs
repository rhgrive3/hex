import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createFlagValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

let address = 0x5000n;
function fixture(overrides = {}) {
  const instructionId = createInstructionId({
    binaryId: 'bin_lowering_control',
    sliceId: 'slice_lowering_control',
    virtualAddress: address,
    decodeMode: 'opaque-mode',
    decoderSemanticVersion: '1',
  });
  address += 4n;
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'opaque-test-target',
    mode: 'opaque-mode',
    operations: [],
    controlEffect: { kind: 'branch', target: { kind: 'bitvector', widthBits: 64, value: '24576' } },
    possibleFaults: [],
    origin: { instructionIds: [instructionId], virtualRanges: [{ imageId: 'image_fixture', start: address - 4n, end: address }] },
    completeness: 'exact',
    ...overrides,
  });
}
function context(suffix) {
  return { functionId: `function_${suffix}`, blockId: `block_${suffix}`, addressWidthBits: 64 };
}
const bv = (bits, value) => createBitVectorValue(bits, value);
const tmp = (id, bits) => createTemporaryValue(id, bv(bits));

{
  const base = tmp('base', 64);
  const loaded = tmp('loaded', 32);
  const addressExpr = {
    kind: 'add',
    widthBits: 64,
    left: { kind: 'temporary', temporaryId: 'base', widthBits: 64 },
    right: { kind: 'bitvector', widthBits: 64, value: '16' },
  };
  const read = createMemoryAccess({
    space: 'memory', addressExpr, widthBits: 32, alignment: 4, endian: 'little',
    volatility: true, atomic: true, ordering: 'acquire',
  });
  const write = createMemoryAccess({
    space: 'memory',
    addressExpr: { ...addressExpr, right: { kind: 'bitvector', widthBits: 64, value: '20' } },
    widthBits: 32, alignment: 4, endian: 'little', volatility: false, atomic: true, ordering: 'release',
  });
  const bundle = fixture({
    operations: [
      createMachineOperation({ kind: 'register-read', id: 'effect.base', register: createRegisterValue('base-state', 64), value: base }),
      createMachineOperation({ kind: 'memory-read', id: 'effect.load', access: read, value: loaded }),
      createMachineOperation({ kind: 'memory-write', id: 'effect.store', access: write, value: loaded }),
      createMachineOperation({ kind: 'barrier', id: 'effect.barrier', scope: { domain: 'memory', ordering: 'seq-cst' } }),
    ],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [{ kind: 'translation-fault', condition: { kind: 'mapped', required: true }, detail: { recoverable: true } }],
  });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, context('memory'));
  assert.equal(ir.completeness, 'complete');
  const load = ir.nodes.find((node) => node.kind === 'load');
  const store = ir.nodes.find((node) => node.kind === 'store');
  const barrier = ir.nodes.find((node) => node.kind === 'barrier');
  assert.ok(load && store && barrier);
  assert.equal(load.memory.widthBits, 32);
  assert.equal(load.memory.alignment, 4);
  assert.equal(load.memory.volatility, true);
  assert.equal(load.memory.atomic, true);
  assert.equal(load.memory.ordering, 'acquire');
  assert.equal(load.memory.faults[0].kind, 'translation-fault');
  assert.equal(store.memory.ordering, 'release');
  assert.equal(store.memory.volatility, false);
  assert.ok(ir.nodes.some((node) => node.kind === 'address' && node.operator === 'add'));
  assert.deepEqual(barrier.attributes.scope, { domain: 'memory', ordering: 'seq-cst' });
}

{
  const condition = createFlagValue('opaque-condition', 1);
  const bundle = fixture({
    operations: [],
    controlEffect: {
      kind: 'conditional-branch',
      condition,
      target: { kind: 'bitvector', widthBits: 64, value: '28672' },
      fallthrough: { kind: 'bitvector', widthBits: 64, value: '28676' },
    },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, context('conditional'));
  const branch = ir.nodes.find((node) => node.kind === 'conditional-branch');
  assert.ok(branch);
  assert.equal(branch.inputs.length, 1);
  assert.equal(branch.targets.length, 2);
  assert.equal(ir.blocks.length, 3, 'branch target placeholders must remain explicit blocks');
  assert.ok(ir.nodes.some((node) => node.kind === 'state-read' && node.variable.physicalIdentity.flagId === 'opaque-condition'));
}

{
  const bundle = fixture({ controlEffect: { kind: 'call', target: { kind: 'bitvector', widthBits: 64, value: '32768' } } });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, context('call'));
  const call = ir.nodes.find((node) => node.kind === 'call');
  assert.ok(call);
  assert.equal(ir.completeness, 'partial', 'ABI-neutral calls must not be treated as fully summarized');
  assert.deepEqual(call.call.arguments, []);
  assert.deepEqual(call.call.returns, []);
  assert.equal(call.call.memoryRead.scope, 'unknown');
  assert.equal(call.call.memoryWrite.scope, 'unknown');
  assert.equal(call.call.determinism, 'unknown');
  assert.equal(call.call.completeness, 'unknown');
  assert.ok(call.call.unknownEffects.categories.includes('state'));
  assert.ok(!JSON.stringify(ir).includes('x0'));
}

{
  const ret = lowerMachineEffectBundleToSemanticIr(fixture({ controlEffect: { kind: 'return' } }), context('return'));
  assert.ok(ret.nodes.some((node) => node.kind === 'return'));
  const trap = lowerMachineEffectBundleToSemanticIr(fixture({ controlEffect: { kind: 'trap', reason: 'synthetic-trap' } }), context('trap'));
  assert.ok(trap.nodes.some((node) => node.kind === 'trap'));
}

{
  const bundle = fixture({ controlEffect: { kind: 'indirect', target: { kind: 'register', registerId: 'dynamic-target', widthBits: 64 } } });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, context('indirect'));
  assert.equal(ir.completeness, 'partial');
  assert.ok(ir.nodes.some((node) => node.kind === 'unknown-control-effect'));
  assert.ok(!ir.nodes.some((node) => node.kind === 'branch'), 'unresolved indirect control must not become a guessed branch/fallthrough');
}

{
  const malformedAddress = createMemoryAccess({
    space: 'memory', addressExpr: { kind: 'opaque-address-form', token: 'unresolved' }, widthBits: 8, endian: 'little',
  });
  const bundle = fixture({
    operations: [createMachineOperation({ kind: 'memory-read', id: 'effect.opaque.load', access: malformedAddress, value: tmp('opaque-load', 8) })],
    controlEffect: { kind: 'fallthrough' },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, context('opaque-address'));
  assert.equal(ir.completeness, 'partial');
  const unknown = ir.nodes.find((node) => node.kind === 'unknown-memory-effect');
  assert.ok(unknown);
  assert.equal(unknown.unknown.knownParts.access.addressExpr.kind, 'opaque-address-form');
}

console.log('semantic-v2 MachineEffects lowering memory/control: PASS');
