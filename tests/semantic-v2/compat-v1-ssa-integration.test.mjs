import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const functionId = 'function_compat_real_ssa';

function origin(id, address) {
  return {
    instructionIds: [`instruction_${id}`],
    virtualRanges: [{ imageId: 'image_compat_real_ssa', start: address, end: address + 4n }],
  };
}

const values = [
  { id: 'cond', kind: 'entry', machineType: bit1, sourceEntityId: functionId, origin: origin('cond', 0x1000n) },
  { id: 'left_value', kind: 'entry', machineType: bit32, sourceEntityId: functionId, origin: origin('left_value', 0x1004n) },
  { id: 'right_value', kind: 'entry', machineType: bit32, sourceEntityId: functionId, origin: origin('right_value', 0x1008n) },
  { id: 'merged_read', kind: 'definition', machineType: bit32, definitionNodeId: 'merge_read', sourceEntityId: 'merge_read', origin: origin('merged_read', 0x1030n) },
];

const stateX = { key: 'state:x', kind: 'logical-state', scope: 'function' };
const blocks = [
  { id: 'entry', nodeIds: ['entry_branch'], origin: origin('entry', 0x1000n) },
  { id: 'left', nodeIds: ['left_write', 'left_branch'], origin: origin('left', 0x1010n) },
  { id: 'right', nodeIds: ['right_write', 'right_branch'], origin: origin('right', 0x1020n) },
  { id: 'merge', nodeIds: ['merge_read', 'merge_return'], origin: origin('merge', 0x1030n) },
];
const nodes = [
  { id: 'entry_branch', kind: 'conditional-branch', blockId: 'entry', inputs: ['cond'], outputs: [], targets: ['left', 'right'], origin: origin('entry_branch', 0x1000n) },
  { id: 'left_write', kind: 'state-write', blockId: 'left', inputs: ['left_value'], outputs: [], variable: stateX, origin: origin('left_write', 0x1010n) },
  { id: 'left_branch', kind: 'branch', blockId: 'left', inputs: [], outputs: [], targets: ['merge'], origin: origin('left_branch', 0x1014n) },
  { id: 'right_write', kind: 'state-write', blockId: 'right', inputs: ['right_value'], outputs: [], variable: stateX, origin: origin('right_write', 0x1020n) },
  { id: 'right_branch', kind: 'branch', blockId: 'right', inputs: [], outputs: [], targets: ['merge'], origin: origin('right_branch', 0x1024n) },
  { id: 'merge_read', kind: 'state-read', blockId: 'merge', inputs: [], outputs: ['merged_read'], variable: stateX, origin: origin('merge_read', 0x1030n) },
  { id: 'merge_return', kind: 'return', blockId: 'merge', inputs: ['merged_read'], outputs: [], origin: origin('merge_return', 0x1034n) },
];

const ir = {
  schemaVersion: 2,
  contractVersion: '2.0.0',
  functionId,
  entryBlockId: 'entry',
  blocks,
  values,
  nodes,
  completeness: 'complete',
  unknowns: [],
  origin: origin('function', 0x1000n),
};
const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'entry',
  blocks: [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'merge', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'merge', kind: 'branch' }] },
    { id: 'merge', successors: [] },
  ],
});

const ssa = buildSemanticSsa(ir, cfg);
const phiDefinition = ssa.definitions.find((definition) => definition.kind === 'phi' && definition.variableKey === 'state:x');
assert.ok(phiDefinition, 'production SSA must create the state:x merge phi');
assert.notEqual(phiDefinition.valueId, 'merged_read', 'canonical SSA ValueId must remain distinct from Semantic IR value IDs');

const projected = projectSemanticIrV2ToLegacyV1(ir, { ssa });
const phi = projected.instructions.find((instruction) => instruction.extra?.semanticSsaDefinitionId === phiDefinition.definitionId);
assert.ok(phi, 'compat projection must preserve a phi produced by the real generic SSA builder');
assert.equal(phi.dst.semanticSsaValueId, phiDefinition.valueId);
assert.equal(phi.reg, 'state:x');
assert.equal(phi.incoming.length, 2);
assert.deepEqual(phi.incoming.map((incoming) => projected.blocks[incoming.from].semanticBlockId).sort(), ['left', 'right']);
assert.ok(phi.incoming.every((incoming) => incoming.value != null));
assert.equal(projected.compat.ssaValueToLegacyValueId[phiDefinition.valueId], phi.dst.id);

const stateRead = projected.instructions.find((instruction) => instruction.semanticNodeId === 'merge_read');
assert.ok(stateRead);
assert.ok(phi.dst.uses.includes(stateRead), 'production SSA use-def must connect the phi to the projected state read');

const mergeBlock = projected.blocks.find((block) => block.semanticBlockId === 'merge');
const leftBlock = projected.blocks.find((block) => block.semanticBlockId === 'left');
const rightBlock = projected.blocks.find((block) => block.semanticBlockId === 'right');
assert.deepEqual(mergeBlock.pred.slice().sort((a, b) => a - b), [leftBlock.index, rightBlock.index].sort((a, b) => a - b));
assert.equal(mergeBlock.idom, projected.entry, 'compat dominance must come from the canonical CFG implementation');

console.log('semantic-v2 real SSA -> v1 compat integration: PASS');
