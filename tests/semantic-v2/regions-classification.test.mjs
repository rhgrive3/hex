import assert from 'node:assert/strict';
import {
  classifySemanticMemoryRegion,
  deriveMemoryRegion,
  isPreciseMemoryRegion,
} from '../../js/analysis/alias/index-v2.js';

const origin = { instructionIds: ['instruction_region_fixture'] };
const functionId = 'function_region_fixture';
const binaryId = 'bin_region_fixture';

function region(memoryRegion, overrides = {}) {
  return deriveMemoryRegion({
    functionId,
    binaryId,
    memory: {
      addressSpace: 'memory',
      addressExpr: { valueId: overrides.addressValueId ?? 'value_addr' },
      widthBits: overrides.widthBits ?? 32,
    },
    origin: overrides.origin === undefined ? origin : overrides.origin,
    regionEvidence: memoryRegion,
    sourceEntityId: overrides.sourceEntityId ?? 'node_memory',
    unknownMetadata: overrides.unknownMetadata,
  });
}

{
  const stack = region({ kind: 'stack-fixed', offset: -16 });
  assert.equal(stack.kind, 'stack-fixed');
  assert.equal(stack.offset, '-16');
  assert.equal(stack.functionId, functionId);
  assert.ok(isPreciseMemoryRegion(stack));
}

{
  const global = region({ kind: 'global-absolute', address: 0x2000n });
  assert.equal(global.kind, 'global-absolute');
  assert.equal(global.address, '0x2000');
  assert.equal(global.binaryId, binaryId);
}

{
  const field = region({ kind: 'rooted-offset', rootEntityId: 'entity_object', offset: 24 });
  assert.equal(field.kind, 'rooted-offset');
  assert.equal(field.rootEntityId, 'entity_object');
  assert.equal(field.offset, '24');
}

{
  const tls = deriveMemoryRegion({
    functionId,
    binaryId,
    memory: { addressSpace: 'tls', addressExpr: { valueId: 'value_tls' }, widthBits: 64 },
    origin,
  });
  const io = deriveMemoryRegion({
    functionId,
    binaryId,
    memory: { addressSpace: 'io', addressExpr: { valueId: 'value_io' }, widthBits: 32 },
    origin,
  });
  assert.equal(tls.kind, 'tls');
  assert.equal(tls.addressSpace, 'tls');
  assert.equal(io.kind, 'io');
  assert.equal(io.addressSpace, 'io');
}

{
  const unknownIndexed = deriveMemoryRegion({
    functionId,
    binaryId,
    memory: { addressSpace: 'memory', addressExpr: { valueId: 'value_indexed' }, widthBits: 32 },
    origin,
    sourceEntityId: 'node_unknown_indexed',
  });
  assert.equal(unknownIndexed.kind, 'unknown');
  assert.equal(unknownIndexed.uncertaintyIdentity.addressValueId, 'value_indexed');
}

{
  const missingRoot = region({ kind: 'rooted-offset', offset: 8 });
  assert.equal(missingRoot.kind, 'unknown');
}

{
  const malformedAddress = region({ kind: 'global-absolute', address: 'not-an-address' });
  assert.equal(malformedAddress.kind, 'unknown');
}

{
  const missingProvenance = region({ kind: 'stack-fixed', offset: -8 }, { origin: null });
  assert.equal(missingProvenance.kind, 'unknown');
  assert.equal(isPreciseMemoryRegion(missingProvenance), false);
}

{
  const a = region({ kind: 'stack-fixed', offset: -32 });
  const b = region({ kind: 'stack-fixed', offset: '-32' });
  assert.equal(a.id, b.id, 'MemoryRegionId must be deterministic');
  const c = region({ kind: 'global-absolute', address: 8192 });
  const d = region({ kind: 'global-absolute', address: '0x2000' });
  assert.equal(c.id, d.id, 'global identity must canonicalize address spelling');
}

{
  const ir = {
    functionId,
    origin,
    values: [{
      id: 'value_addr',
      kind: 'definition',
      definitionNodeId: 'node_addr',
      origin,
      metadata: { provenance: { memoryRegion: { kind: 'rooted-offset', rootEntityId: 'entity_self', offset: 40 } } },
    }],
    nodes: [
      { id: 'node_addr', kind: 'address', blockId: 'block_entry', origin },
      {
        id: 'node_load',
        kind: 'load',
        blockId: 'block_entry',
        origin,
        memory: { addressSpace: 'memory', addressExpr: { valueId: 'value_addr' }, widthBits: 32 },
      },
    ],
  };
  const classified = classifySemanticMemoryRegion(ir, 'node_load', { binaryId });
  assert.equal(classified.kind, 'rooted-offset');
  assert.equal(classified.rootEntityId, 'entity_self');
  assert.equal(classified.offset, '40');
}

console.log('semantic-v2 region classification: PASS');
