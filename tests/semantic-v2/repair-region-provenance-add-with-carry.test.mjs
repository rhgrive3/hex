import assert from 'node:assert/strict';
import { classifySemanticMemoryRegion } from '../../js/analysis/alias/index-v2.js';

const functionId = 'function_region_add_with_carry_fixture';
const binaryId = 'binary_region_add_with_carry_fixture';
const bit64 = { kind: 'bitvector', widthBits: 64 };
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function constantNode(id, valueId, integer, widthBits) {
  const constant = { kind: 'bitvector', widthBits, value: String(integer) };
  return {
    node: {
      id,
      kind: 'const',
      blockId: 'block.entry',
      inputs: [],
      outputs: [valueId],
      attributes: { constant },
      completeness: 'complete',
      origin: origin(id),
    },
    value: {
      id: valueId,
      kind: 'definition',
      machineType: { kind: 'bitvector', widthBits },
      definitionNodeId: id,
      sourceEntityId: null,
      variableKey: null,
      origin: origin(valueId),
      metadata: { constant },
    },
  };
}

function fixture(carryIn) {
  const rootNode = {
    id: 'node.root.read',
    kind: 'state-read',
    blockId: 'block.entry',
    inputs: [],
    outputs: ['value.root'],
    variable: { key: 'root.a', kind: 'logical-state', scope: 'function' },
    attributes: {},
    completeness: 'complete',
    origin: origin('root.read'),
  };
  const rootValue = {
    id: 'value.root',
    kind: 'definition',
    machineType: bit64,
    definitionNodeId: rootNode.id,
    sourceEntityId: null,
    variableKey: 'root.a',
    origin: origin('root.value'),
  };
  const zero = constantNode('node.offset.zero', 'value.offset.zero', 0, 64);
  const carry = constantNode('node.carry', 'value.carry', carryIn, 1);
  const addNode = {
    id: 'node.add.with.carry',
    kind: 'intrinsic',
    blockId: 'block.entry',
    inputs: ['value.root', 'value.offset.zero', 'value.carry'],
    outputs: ['value.add.result', 'value.add.carry-out', 'value.add.overflow'],
    operator: 'add-with-carry',
    intrinsic: {
      inputs: ['value.root', 'value.offset.zero', 'value.carry'],
      outputs: ['value.add.result', 'value.add.carry-out', 'value.add.overflow'],
      stateReads: [],
      stateWrites: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'deterministic',
      symbolicDetail: 'summary-only',
    },
    attributes: {},
    completeness: 'complete',
    origin: origin('add.with.carry'),
  };
  const resultValue = {
    id: 'value.add.result',
    kind: 'definition',
    machineType: bit64,
    definitionNodeId: addNode.id,
    sourceEntityId: null,
    variableKey: null,
    origin: origin('add.result'),
  };
  const directLoad = {
    id: 'node.load.direct',
    kind: 'load',
    blockId: 'block.entry',
    inputs: ['value.root'],
    outputs: [],
    memory: {
      addressSpace: 'memory',
      addressExpr: { valueId: 'value.root' },
      widthBits: 32,
      endian: 'little',
      alignment: null,
      volatility: false,
      atomic: false,
      ordering: 'unknown',
      faults: [],
    },
    attributes: {},
    completeness: 'complete',
    origin: origin('load.direct'),
  };
  const addLoad = {
    ...directLoad,
    id: 'node.load.add',
    inputs: ['value.add.result'],
    memory: { ...directLoad.memory, addressExpr: { valueId: 'value.add.result' } },
    origin: origin('load.add'),
  };
  const nodes = [rootNode, zero.node, carry.node, addNode, directLoad, addLoad];
  return {
    functionId,
    origin: origin('function'),
    blocks: [{ id: 'block.entry', nodeIds: nodes.map((node) => node.id), origin: origin('block.entry') }],
    values: [rootValue, zero.value, carry.value, resultValue],
    nodes,
  };
}

{
  const ir = fixture(0);
  const direct = classifySemanticMemoryRegion(ir, 'node.load.direct', { binaryId });
  const throughExactAdd = classifySemanticMemoryRegion(ir, 'node.load.add', { binaryId });
  assert.equal(direct.kind, 'rooted-offset');
  assert.equal(throughExactAdd.kind, 'rooted-offset');
  assert.equal(throughExactAdd.id, direct.id, 'zero-carry semantic add with zero displacement preserves canonical root');
}

{
  const ir = fixture(1);
  const throughCarry = classifySemanticMemoryRegion(ir, 'node.load.add', { binaryId });
  assert.equal(throughCarry.kind, 'unknown', 'non-zero carry must not be normalized into root + constant');
}

console.log('semantic-v2 exact add-with-carry address repair: PASS');
