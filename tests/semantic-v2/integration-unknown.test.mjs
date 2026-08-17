import assert from 'node:assert/strict';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const plugin = Object.freeze({
  id: 'test-unknown-architecture',
  semanticVersion: '1',
  fixedInstructionSize: 4,
  liftExact() { return null; },
});

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'test-unknown-decoder-1',
  binaryId: 'binary_unknown_integration',
  sliceId: 'slice_unknown_integration',
  addressWidthBits: 64,
  blocks: [{
    key: 'body', startAddress: 0x4000n,
    instructions: [{ decoded: { address: 0x4000n, mode: 'test', testKind: 'unsupported' } }],
    successors: [],
  }],
});

assert.equal(result.instrumentation.v2Executed, true);
assert.equal(result.instrumentation.unsupportedInstructionCount, 1);
assert.equal(result.machineEffects[0].completeness, 'unknown');
assert.equal(result.machineEffects[0].unknownEffects.preservation, 'not-assumed');
assert.equal(result.semanticIr.completeness, 'unknown');
assert.equal(result.legacyV1.instructions.some((instruction) => instruction.op === 'unknown'), true);
assert.equal(Object.hasOwn(result, 'legacyFallback'), false);

assert.throws(() => buildSemanticV2CompatibilityPipeline({
  architecturePlugin: { id: 'no-lifter', semanticVersion: '1' },
  decoderSemanticVersion: 'test-unknown-decoder-1',
  binaryId: 'binary_unknown_integration', sliceId: 'slice_unknown_integration',
  blocks: [{ key: 'body', startAddress: 0x5000n, instructions: [], successors: [] }],
}), /semantic-v2-lift-exact-required/);
console.log('Phase 3 explicit unknown/no-fallback integration: PASS');
