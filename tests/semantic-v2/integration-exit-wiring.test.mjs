import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { reachingConcreteStore } from '../../js/semantics/memoryssa/index.js';

const stackRegisterId = 'frame-anchor';
const plugin = Object.freeze({
  id: 'neutral-stack-test-architecture',
  semanticVersion: '1',
  fixedInstructionSize: 4,
  registerFile() {
    return Object.freeze([
      Object.freeze({ id: stackRegisterId, bits: 64, kind: 'stack-pointer' }),
    ]);
  },
  liftExact(decoded) {
    const base = {
      instructionId: decoded.instructionId,
      architectureId: 'neutral-stack-test-architecture',
      mode: decoded.mode,
      possibleFaults: [],
      origin: decoded.origin,
    };
    const access = {
      space: 'memory',
      addressExpr: { kind: 'register', registerId: stackRegisterId, widthBits: 64 },
      widthBits: 32,
      endian: 'little',
    };
    if (decoded.testKind === 'store') return createMachineEffectBundle({
      ...base,
      operations: [{
        id: `${decoded.instructionId}:store`,
        kind: 'memory-write',
        access,
        value: { kind: 'bitvector', widthBits: 32, value: '7' },
      }],
      controlEffect: { kind: 'fallthrough' },
      completeness: 'exact',
    });
    if (decoded.testKind === 'load-return') return createMachineEffectBundle({
      ...base,
      operations: [{
        id: `${decoded.instructionId}:load`,
        kind: 'memory-read',
        access,
        value: { kind: 'bitvector', widthBits: 32 },
      }],
      controlEffect: { kind: 'return' },
      completeness: 'exact',
    });
    return null;
  },
});

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'neutral-stack-test-decoder-1',
  binaryId: 'binary_exit_wiring_fixture',
  sliceId: 'slice_exit_wiring_fixture',
  addressWidthBits: 64,
  entryBlockKey: 'entry',
  blocks: [
    {
      key: 'entry',
      startAddress: 0x1000n,
      instructions: [{ decoded: { address: 0x1000n, mode: 'test', testKind: 'store' } }],
      successors: [{ to: 'exit', kind: 'fallthrough' }],
    },
    {
      key: 'exit',
      startAddress: 0x1004n,
      instructions: [{ decoded: { address: 0x1004n, mode: 'test', testKind: 'load-return' } }],
      successors: [],
    },
  ],
});

const storeNode = result.semanticIr.nodes.find((node) => node.kind === 'store');
const loadNode = result.semanticIr.nodes.find((node) => node.kind === 'load');
assert.ok(storeNode && loadNode, 'fixture must lower one store and one load');

const storeRegion = result.regions.find((region) => region.kind === 'stack-fixed');
assert.ok(storeRegion, 'stack-pointer target metadata must derive a stack-fixed region without register-name matching');
assert.equal(result.regions.filter((region) => region.kind === 'stack-fixed').length, 1,
  'equivalent stack accesses must canonicalize to one region identity');

const loadUse = result.memorySsa.uses.find((use) => use.sourceEntityId === loadNode.id);
assert.ok(loadUse, 'MemorySSA must contain the load use');
const reachingStore = reachingConcreteStore(result.memorySsa, loadUse);
assert.ok(reachingStore, 'the canonical stack region must preserve the exact reaching store');
assert.equal(reachingStore.sourceEntityId, storeNode.id);

assert.equal(result.legacyV1.compat.canonicalCfg, true, 'canonical CFG must reach the v1 projector');
assert.deepEqual(result.legacyV1.blocks[0].succ, [1],
  'v1 projection must preserve a canonical successor that was supplied by the integration route');
assert.equal(result.legacyV1.blocks[1].pred.includes(0), true,
  'v1 projection must preserve the matching predecessor relationship');

console.log('Phase 3 exit integration wiring: PASS');
