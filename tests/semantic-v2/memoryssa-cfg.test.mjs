import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { reachingConcreteStore, reachingMemoryDefinition } from '../../js/semantics/memoryssa/queries.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const functionId = 'function_memoryssa_cfg';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const access = (addressValueId) => ({
  addressSpace: 'memory',
  addressValueId,
  widthBits: 32,
  endian: 'little',
  volatility: false,
  atomic: false,
  ordering: 'unknown',
});
const makeNode = (id, kind, blockId, addressValueId) => ({
  id,
  kind,
  blockId,
  inputs: [],
  outputs: [],
  memory: access(addressValueId),
  origin: origin(id),
});
const regionA = createMemoryRegionRef({
  id: 'cfg_region_A', kind: 'rooted-offset', functionId, rootEntityId: 'cfg_root_A', offset: 0, widthBits: 32,
});
const regionMaybe = createMemoryRegionRef({
  id: 'cfg_region_maybe', kind: 'rooted-offset', functionId, rootEntityId: 'cfg_root_maybe', offset: 0, widthBits: 32,
});
const regionUnknown = createMemoryRegionRef({
  id: 'cfg_region_unknown', kind: 'unknown', functionId, uncertaintyIdentity: { fixture: 'cfg-unknown' },
});
const byAddress = new Map([
  ['addr_A', regionA],
  ['addr_maybe', regionMaybe],
  ['addr_unknown', regionUnknown],
]);
const providers = {
  resolveRegion(memory) { return byAddress.get(memory.addressExpr.valueId) ?? regionUnknown; },
  queryAlias(left, right) {
    if (left.id === regionUnknown.id || right.id === regionUnknown.id
      || left.metadata?.precision === 'conservative-default'
      || right.metadata?.precision === 'conservative-default') return 'unknown';
    if ((left.id === regionMaybe.id && right.id === regionA.id)
      || (left.id === regionA.id && right.id === regionMaybe.id)) return 'may';
    return left.id === right.id ? 'must' : 'no';
  },
};
function build(blocks, nodes, options = {}) {
  const addressIds = [...new Set(nodes.map((item) => item.memory?.addressValueId).filter(Boolean))].sort();
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: blocks.map((block) => ({ id: block.id, nodeIds: nodes.filter((item) => item.blockId === block.id).map((item) => item.id), origin: origin(block.id) })),
    values: addressIds.map((id) => ({ id, kind: 'entry', machineType: addressType, origin: origin(id) })),
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: blocks.map((block) => ({ id: block.id, successors: block.successors ?? [] })),
  });
  return { ir, cfg, memorySsa: buildMemorySsa(ir, cfg, { ...providers, ...options }) };
}
function loadUse(memorySsa, nodeId) {
  return memorySsa.uses.find((use) => use.sourceEntityId === nodeId && use.regionId === regionA.id);
}
function phi(memorySsa, blockId) {
  return memorySsa.definitions.find((definition) => definition.kind === 'memory-phi'
    && definition.blockId === blockId && definition.regionId === regionA.id);
}

{
  const blocks = [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ];
  const nodes = [
    makeNode('left_store', 'store', 'left', 'addr_A'),
    makeNode('right_store', 'store', 'right', 'addr_A'),
    makeNode('join_load', 'load', 'join', 'addr_A'),
  ];
  const { memorySsa, cfg } = build(blocks, nodes);
  const merge = phi(memorySsa, 'join');
  assert.ok(merge);
  assert.deepEqual(merge.incoming.map((item) => item.predecessorBlockId), ['left', 'right']);
  assert.equal(reachingMemoryDefinition(memorySsa, loadUse(memorySsa, 'join_load')).id, merge.id);
  assert.equal(reachingConcreteStore(memorySsa, loadUse(memorySsa, 'join_load')), null);
  assert.doesNotThrow(() => validateMemorySsa(memorySsa, { cfg }));
}

{
  const blocks = [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ];
  const nodes = [
    makeNode('left_store', 'store', 'left', 'addr_A'),
    makeNode('right_may', 'store', 'right', 'addr_maybe'),
    makeNode('join_load', 'load', 'join', 'addr_A'),
  ];
  const { memorySsa } = build(blocks, nodes);
  const merge = phi(memorySsa, 'join');
  assert.ok(merge);
  const incomingKinds = merge.incoming.map((item) => memorySsa.definitions.find((definition) => definition.id === item.definitionId).kind).sort();
  assert.deepEqual(incomingKinds, ['may-alias-clobber', 'memory-def']);
}

{
  const blocks = [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ];
  const nodes = [
    makeNode('left_store', 'store', 'left', 'addr_A'),
    makeNode('right_unknown', 'store', 'right', 'addr_unknown'),
    makeNode('join_load', 'load', 'join', 'addr_A'),
  ];
  const { memorySsa } = build(blocks, nodes);
  const merge = phi(memorySsa, 'join');
  assert.ok(merge);
  const incomingKinds = merge.incoming.map((item) => memorySsa.definitions.find((definition) => definition.id === item.definitionId).kind).sort();
  assert.deepEqual(incomingKinds, ['memory-def', 'unknown-clobber']);
}

{
  const blocks = [
    { id: 'entry', successors: [{ to: 'header', kind: 'branch' }] },
    { id: 'header', successors: [{ to: 'body', kind: 'conditional-true' }, { to: 'exit', kind: 'conditional-false' }] },
    { id: 'body', successors: [{ to: 'header', kind: 'branch' }] },
    { id: 'exit', successors: [] },
  ];
  const nodes = [
    makeNode('body_store', 'store', 'body', 'addr_A'),
    makeNode('exit_load', 'load', 'exit', 'addr_A'),
  ];
  const { memorySsa, cfg } = build(blocks, nodes);
  const loopPhi = phi(memorySsa, 'header');
  assert.ok(loopPhi);
  assert.deepEqual(loopPhi.incoming.map((item) => item.predecessorBlockId), ['body', 'entry']);
  assert.equal(reachingMemoryDefinition(memorySsa, loadUse(memorySsa, 'exit_load')).id, loopPhi.id);
  assert.doesNotThrow(() => validateMemorySsa(memorySsa, { cfg }));
}

{
  const blocks = [
    { id: 'entry', successors: [{ to: 'outer_header', kind: 'branch' }] },
    { id: 'outer_header', successors: [{ to: 'inner_header', kind: 'conditional-true' }, { to: 'exit', kind: 'conditional-false' }] },
    { id: 'inner_header', successors: [{ to: 'inner_body', kind: 'conditional-true' }, { to: 'outer_latch', kind: 'conditional-false' }] },
    { id: 'inner_body', successors: [{ to: 'inner_header', kind: 'branch' }] },
    { id: 'outer_latch', successors: [{ to: 'outer_header', kind: 'branch' }] },
    { id: 'exit', successors: [] },
  ];
  const nodes = [
    makeNode('inner_store', 'store', 'inner_body', 'addr_A'),
    makeNode('outer_store', 'store', 'outer_latch', 'addr_A'),
    makeNode('exit_load', 'load', 'exit', 'addr_A'),
  ];
  const { memorySsa, cfg } = build(blocks, nodes);
  assert.ok(phi(memorySsa, 'outer_header'));
  assert.ok(phi(memorySsa, 'inner_header'));
  assert.doesNotThrow(() => validateMemorySsa(memorySsa, { cfg }));
}

{
  const blocks = [
    { id: 'entry', successors: [{ to: 'exit', kind: 'branch' }] },
    { id: 'exit', successors: [] },
    { id: 'dead', successors: [{ to: 'dead', kind: 'branch' }] },
  ];
  const nodes = [
    makeNode('live_store', 'store', 'entry', 'addr_A'),
    makeNode('live_load', 'load', 'exit', 'addr_A'),
    makeNode('dead_store', 'store', 'dead', 'addr_A'),
  ];
  const { memorySsa, cfg } = build(blocks, nodes);
  assert.equal(reachingMemoryDefinition(memorySsa, loadUse(memorySsa, 'live_load')).sourceEntityId, 'live_store');
  const deadPhi = phi(memorySsa, 'dead');
  assert.ok(deadPhi);
  assert.deepEqual(deadPhi.incoming.map((item) => item.predecessorBlockId), ['dead']);
  assert.ok(deadPhi.previousDefinitionIds.length === 1);
  assert.doesNotThrow(() => validateMemorySsa(memorySsa, { cfg }));
}

{
  const blocks = [{ id: 'entry', successors: [] }];
  const nodes = [
    makeNode('store_without_provider', 'store', 'entry', 'addr_A'),
    makeNode('load_without_provider', 'load', 'entry', 'addr_A'),
  ];
  const { ir, cfg } = build(blocks, nodes);
  const conservative = buildMemorySsa(ir, cfg);
  const use = conservative.uses.find((item) => item.sourceEntityId === 'load_without_provider');
  assert.equal(reachingMemoryDefinition(conservative, use).kind, 'unknown-clobber');
  assert.equal(reachingConcreteStore(conservative, use), null);
}

console.log('semantic-v2 MemorySSA CFG/loop tests: PASS');
