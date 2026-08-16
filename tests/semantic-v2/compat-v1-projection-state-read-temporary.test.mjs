import assert from 'node:assert/strict';
import { OP } from '../../js/ir-core.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const bit64 = { kind: 'bitvector', widthBits: 64 };

function origin(role, address = 0x1000n, instructionId = 'i:same-op') {
  return {
    instructionIds: [instructionId],
    operationIds: [`op:${role}`],
    virtualRanges: [{ start: address, end: address + 4n }],
    parentEntityIds: [`parent:${role}`],
  };
}

function stateVar(key, publicId) {
  return {
    key,
    kind: 'physical-state',
    scope: 'function',
    physicalIdentity: { kind: 'register', registerId: publicId },
  };
}

function stateProof(kind, variableIdentity, sourceSemanticValueId, machineType) {
  return { kind, variableIdentity, sourceSemanticValueId, machineType };
}

const leftKey = 'physical-state:left-digest';
const rightKey = 'physical-state:right-digest';
const leftState = stateVar(leftKey, 'generic-left');
const rightState = stateVar(rightKey, 'generic-right');

const values = [
  { id:'condition', kind:'entry', machineType:bit1, sourceEntityId:'fn', variableKey:null, origin:origin('condition',0x0ffcn,'i:entry') },
  { id:'left-read', kind:'definition', machineType:bit32, definitionNodeId:'read-left', sourceEntityId:'read-left', variableKey:leftKey, origin:origin('left-read') },
  { id:'right-read', kind:'definition', machineType:bit32, definitionNodeId:'read-right', sourceEntityId:'read-right', variableKey:rightKey, origin:origin('right-read') },
  { id:'selected', kind:'definition', machineType:bit32, definitionNodeId:'select', sourceEntityId:'select', variableKey:null, origin:origin('selected') },
];

const nodes = [
  { id:'read-left', kind:'state-read', blockId:'b0', inputs:[], outputs:['left-read'], variable:leftState, origin:origin('read-left') },
  { id:'read-right', kind:'state-read', blockId:'b0', inputs:[], outputs:['right-read'], variable:rightState, origin:origin('read-right') },
  { id:'select', kind:'select', blockId:'b0', inputs:['condition','left-read','right-read'], outputs:['selected'],
    attributes:{ machineEffects:{ bundleMetadata:{ conditionCode:'gt' } } }, origin:origin('select') },
  { id:'write-left', kind:'state-write', blockId:'b0', inputs:['selected'], outputs:[], variable:leftState, origin:origin('write-left') },
  { id:'ret', kind:'return', blockId:'b0', inputs:[], outputs:[], origin:origin('ret',0x1004n,'i:ret') },
];

const ir = {
  schemaVersion:2,
  contractVersion:'2.0.0',
  functionId:'fn',
  entryBlockId:'b0',
  blocks:[{ id:'b0', nodeIds:nodes.map((node) => node.id), origin:origin('block') }],
  values,
  nodes,
  completeness:'complete',
  unknowns:[],
  origin:origin('fn',0x1000n,'i:fn'),
};

const ssa = {
  contractVersion:'2.0.0',
  functionId:'fn',
  definitions:[
    { definitionId:'left-entry', valueId:'left-v0', kind:'entry', blockId:null, variableKey:leftKey, sourceEntityId:'fn', incoming:[],
      origin:origin('left-entry',0x1000n,'i:entry'), proof:stateProof('entry-seed',leftState,null,bit64) },
    { definitionId:'right-entry', valueId:'right-v0', kind:'entry', blockId:null, variableKey:rightKey, sourceEntityId:'fn', incoming:[],
      origin:origin('right-entry',0x1000n,'i:entry'), proof:stateProof('entry-seed',rightState,null,bit64) },
    { definitionId:'scalar-left', valueId:'ssa-left', kind:'definition', blockId:'b0', variableKey:null, sourceEntityId:'left-read', incoming:[],
      origin:origin('scalar-left'), proof:{ kind:'semantic-value-definition', sourceSemanticValueId:'left-read', machineType:bit32 } },
    { definitionId:'scalar-right', valueId:'ssa-right', kind:'definition', blockId:'b0', variableKey:null, sourceEntityId:'right-read', incoming:[],
      origin:origin('scalar-right'), proof:{ kind:'semantic-value-definition', sourceSemanticValueId:'right-read', machineType:bit32 } },
    { definitionId:'scalar-selected', valueId:'ssa-selected', kind:'definition', blockId:'b0', variableKey:null, sourceEntityId:'selected', incoming:[],
      origin:origin('scalar-selected'), proof:{ kind:'semantic-value-definition', sourceSemanticValueId:'selected', machineType:bit32 } },
    { definitionId:'left-write', valueId:'left-v1', kind:'definition', blockId:'b0', variableKey:leftKey, sourceEntityId:'write-left', incoming:[],
      origin:origin('left-write'), proof:stateProof('renamed-definition',leftState,'selected',bit32) },
  ],
  uses:[
    { useId:'left-use', valueId:'left-v0', blockId:'b0', sourceEntityId:'read-left', origin:origin('left-use'),
      proof:stateProof('renamed-use',leftState,'left-read',bit32) },
    { useId:'right-use', valueId:'right-v0', blockId:'b0', sourceEntityId:'read-right', origin:origin('right-use'),
      proof:stateProof('renamed-use',rightState,'right-read',bit32) },
  ],
};

const out = projectSemanticIrV2ToLegacyV1(ir, { ssa });
const leftRead = out.instructions.find((inst) => inst.semanticNodeId === 'read-left');
const rightRead = out.instructions.find((inst) => inst.semanticNodeId === 'read-right');
const select = out.instructions.find((inst) => inst.semanticNodeId === 'select');
const write = out.instructions.find((inst) => inst.semanticNodeId === 'write-left');

assert.equal(leftRead.op, OP.MOV);
assert.equal(leftRead.extra.publicStateIdentity, 'generic-left');
assert.equal(leftRead.dst.reg, null, 'same-operation read result is a temporary value, not a second public state definition');
assert.equal(leftRead.args[0].value.reg, 'generic-left', 'physical state identity remains on the reaching state value');
assert.equal(rightRead.dst.reg, 'generic-right', 'unrelated physical state remains publicly identifiable');
assert.equal(select.op, OP.SEL);
assert.equal(select.cond, 'gt');
assert.equal(select.args[0].value, leftRead.dst);
assert.equal(write.op, OP.MOV);
assert.equal(write.dst.reg, 'generic-left');
assert.equal(write.args[0].value.semanticValueId, 'selected');
assert.notEqual(write.dst.stateKey, write.dst.reg, 'internal state key must not leak into public state identity');

console.log('semantic-v2 same-operation state read/write projection: PASS');
