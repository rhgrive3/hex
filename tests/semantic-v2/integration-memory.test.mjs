import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { reachingConcreteStore, reachingMemoryDefinition } from '../../js/semantics/memoryssa/index.js';

const plugin = Object.freeze({
  id: 'test-memory-architecture', semanticVersion: '1', fixedInstructionSize: 4,
  liftExact(decoded) {
    const base = {
      instructionId: decoded.instructionId, architectureId: 'test-memory-architecture', mode: decoded.mode,
      possibleFaults: [], origin: decoded.origin,
    };
    const access = {
      space: 'memory', addressExpr: { kind: 'bitvector', widthBits: 64, value: String(decoded.memoryAddress ?? 0x5000) },
      widthBits: 32, endian: 'little',
    };
    if (decoded.testKind === 'store') return createMachineEffectBundle({
      ...base,
      operations: [{ id: `${decoded.instructionId}:store`, kind: 'memory-write', access,
        value: { kind: 'bitvector', widthBits: 32, value: String(decoded.value ?? 1) } }],
      controlEffect: { kind: 'fallthrough' }, completeness: 'exact',
    });
    if (decoded.testKind === 'load') return createMachineEffectBundle({
      ...base,
      operations: [{ id: `${decoded.instructionId}:load`, kind: 'memory-read', access,
        value: { kind: 'bitvector', widthBits: 32 } }],
      controlEffect: { kind: 'fallthrough' }, completeness: 'exact',
    });
    if (decoded.testKind === 'unknown-store') return createMachineEffectBundle({
      ...base,
      operations: [{ id: `${decoded.instructionId}:unknown-store`, kind: 'unknown', reason: 'synthetic unknown store', categories: ['memory'] }],
      controlEffect: { kind: 'fallthrough' }, completeness: 'partial',
      unknownEffects: { categories: ['memory'], reason: 'synthetic unknown store', preservation: 'not-assumed' },
    });
    if (decoded.testKind === 'call') return createMachineEffectBundle({
      ...base, operations: [], controlEffect: { kind: 'call', target: { kind: 'absolute-address', value: '0x9000', widthBits: 64 } }, completeness: 'exact',
    });
    if (decoded.testKind === 'return') return createMachineEffectBundle({
      ...base, operations: [], controlEffect: { kind: 'return' }, completeness: 'exact',
    });
    return null;
  },
});

function run(address, instructions) {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin: plugin,
    decoderSemanticVersion: 'test-memory-decoder-1',
    binaryId: 'binary_memory_integration', sliceId: 'slice_memory_integration', addressWidthBits: 64,
    blocks: [{ key: 'body', startAddress: address, instructions, successors: [] }],
  });
}

let unknownStoreSafetyFailures = 0;
let unknownCallSafetyFailures = 0;

const unknownStore = run(0x2000n, [
  { decoded: { address: 0x2000n, mode: 'test', testKind: 'store', memoryAddress: 0x5000n, value: 7 } },
  { decoded: { address: 0x2004n, mode: 'test', testKind: 'unknown-store' } },
  { decoded: { address: 0x2008n, mode: 'test', testKind: 'load', memoryAddress: 0x5000n } },
  { decoded: { address: 0x200cn, mode: 'test', testKind: 'return' } },
]);
const loadNode = unknownStore.semanticIr.nodes.find((node) => node.kind === 'load');
const loadUse = unknownStore.memorySsa.uses.find((use) => use.sourceEntityId === loadNode.id);
assert.ok(loadUse);
if (reachingConcreteStore(unknownStore.memorySsa, loadUse) !== null) unknownStoreSafetyFailures += 1;
if (reachingMemoryDefinition(unknownStore.memorySsa, loadUse).kind === 'memory-def') unknownStoreSafetyFailures += 1;
assert.equal(unknownStoreSafetyFailures, 0, 'an unknown store must prevent stale reaching-store proof');
assert.equal(unknownStore.instrumentation.semanticUnknownCount > 0, true);

const unknownCall = run(0x3000n, [
  { decoded: { address: 0x3000n, mode: 'test', testKind: 'store', memoryAddress: 0x6000n, value: 9 } },
  { decoded: { address: 0x3004n, mode: 'test', testKind: 'call' } },
  { decoded: { address: 0x3008n, mode: 'test', testKind: 'load', memoryAddress: 0x6000n } },
  { decoded: { address: 0x300cn, mode: 'test', testKind: 'return' } },
]);
const callLoadNode = unknownCall.semanticIr.nodes.find((node) => node.kind === 'load');
const callLoadUse = unknownCall.memorySsa.uses.find((use) => use.sourceEntityId === callLoadNode.id);
assert.ok(callLoadUse);
if (reachingConcreteStore(unknownCall.memorySsa, callLoadUse) !== null) unknownCallSafetyFailures += 1;
if (!unknownCall.memorySsa.definitions.some((definition) => definition.kind === 'call-clobber')) unknownCallSafetyFailures += 1;
assert.equal(unknownCallSafetyFailures, 0, 'unknown call must not be treated as pure');

globalThis.__HEX_PHASE3_MEMORY_SAFETY__ = Object.freeze({
  unknownStoreSafetyFailures,
  unknownCallSafetyFailures,
});
console.log('Phase 3 MemorySSA integration safety: PASS');
