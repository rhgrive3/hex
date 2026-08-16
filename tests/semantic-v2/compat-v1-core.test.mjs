import assert from 'node:assert/strict';
import { OP, VK, MK } from '../../js/ir-core.js';
import { projectSemanticIrV2ToLegacyV1, SEMANTIC_IR_V2_V1_COMPAT } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const bit64 = { kind: 'bitvector', widthBits: 64 };

function origin(id, address = 0x1000n) {
  return { instructionIds: [id], virtualRanges: [{ start: address, end: address + 4n }] };
}
function entryValue(id, machineType = bit64, variableKey = null, at = 0x1000n) {
  return { id, kind: 'entry', machineType, sourceEntityId: 'fn', variableKey, origin: origin(`ins_${id}`, at) };
}
function defValue(id, definitionNodeId, machineType = bit64, variableKey = null, at = 0x1000n) {
  return { id, kind: 'definition', machineType, definitionNodeId, sourceEntityId: definitionNodeId, variableKey, origin: origin(`ins_${id}`, at) };
}
function semanticFunction({ id = 'fn', blocks, values, nodes, completeness = 'complete', unknowns = [], at = 0x1000n }) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: id,
    entryBlockId: blocks[0].id,
    blocks,
    values,
    nodes,
    completeness,
    unknowns,
    origin: origin(`function_${id}`, at),
  };
}
function oneBlock(nodes, values, options = {}) {
  return semanticFunction({
    ...options,
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin: origin('block_b0') }],
    values,
    nodes,
  });
}
function callSummary({ args = [], returns = [], memoryWrite = 'none', completeness = 'complete', unknown = null } = {}) {
  const unresolved = completeness !== 'complete';
  return {
    targetValueIds: [], targetEntityIds: ['callee'], arguments: args, returns,
    stateReads: [], stateWrites: [],
    memoryRead: unresolved ? { scope: 'unknown', detail: { reason: 'unknown callee read' } } : { scope: 'none' },
    memoryWrite: memoryWrite === 'unknown' ? { scope: 'unknown', detail: { reason: 'unknown callee write' } } : { scope: memoryWrite },
    controlEffects: [{ kind: 'call' }],
    determinism: unresolved ? 'unknown' : 'deterministic',
    noreturn: unresolved ? 'unknown' : false,
    mayThrow: unresolved ? 'unknown' : false,
    summarySource: unresolved ? 'conservative-unknown-call' : 'synthetic-known-call',
    completeness,
    unknownEffects: unresolved ? (unknown || { reason: 'callee unavailable', categories: ['memory', 'state', 'control'] }) : null,
  };
}

// Arithmetic + exact widths + current v1 public shape.
{
  const a = entryValue('a', bit32, 'state:a');
  const b = entryValue('b', bit32, 'state:b');
  const sum = defValue('sum', 'n_add', bit32, 'state:sum', 0x1004n);
  const ir = oneBlock([
    { id: 'n_add', kind: 'binary', blockId: 'b0', inputs: ['a', 'b'], outputs: ['sum'], operator: 'add', origin: origin('ins_add', 0x1004n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['sum'], outputs: [], origin: origin('ins_ret', 0x1008n) },
  ], [a, b, sum]);
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const add = out.instructions.find((inst) => inst.semanticNodeId === 'n_add');
  assert.equal(add.op, OP.BIN);
  assert.equal(add.sub, 'add');
  assert.equal(add.dst.bits, 32);
  assert.deepEqual(add.args.map((arg) => arg.bits), [32, 32]);
  assert.equal(add.dst.kind, VK.DEF);
  assert.ok(out.locations instanceof Map);
  assert.ok(out.byRow instanceof Map);
  assert.ok(out.args instanceof Map);
  assert.equal(out.blocks[0].index, 0);
  assert.ok(Array.isArray(out.blocks[0].phis));
  assert.ok(Array.isArray(out.blocks[0].memPhis));
  assert.equal(typeof out.defUse, 'function');
  assert.equal(out.defUse(), out.values);
}

// Comparison.
{
  const a = entryValue('a', bit32);
  const b = entryValue('b', bit32);
  const pred = defValue('pred', 'n_cmp', bit1, null, 0x1100n);
  const ir = oneBlock([
    { id: 'n_cmp', kind: 'compare', blockId: 'b0', inputs: ['a', 'b'], outputs: ['pred'], operator: '<', attributes: { signed: true }, origin: origin('ins_cmp', 0x1100n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['pred'], outputs: [], origin: origin('ins_ret_cmp', 0x1104n) },
  ], [a, b, pred], { at: 0x1100n });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const cmp = out.instructions.find((inst) => inst.semanticNodeId === 'n_cmp');
  assert.equal(cmp.op, OP.CMP);
  assert.equal(cmp.extra.comparison, '<');
  assert.equal(cmp.extra.signed, true);
  assert.equal(cmp.dst.bits, 1);
}

// Select and generic flag/state relationships are preserved without architecture names.
{
  const cond = entryValue('cond_select', bit1, 'state:condition');
  const yes = entryValue('yes', bit32);
  const no = entryValue('no', bit32);
  const selected = defValue('selected', 'n_select', bit32, 'state:selected', 0x1200n);
  const ir = oneBlock([
    { id: 'n_select', kind: 'select', blockId: 'b0', inputs: ['cond_select', 'yes', 'no'], outputs: ['selected'], operator: 'sel', origin: origin('ins_select', 0x1200n) },
    { id: 'n_state_write', kind: 'state-write', blockId: 'b0', inputs: ['selected'], outputs: [], variable: { key: 'flags:generic-condition', kind: 'physical-state', scope: 'function' }, origin: origin('ins_state_write', 0x1204n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['selected'], outputs: [], origin: origin('ins_select_ret', 0x1208n) },
  ], [cond, yes, no, selected], { at: 0x1200n });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const select = out.instructions.find((inst) => inst.semanticNodeId === 'n_select');
  const stateWrite = out.instructions.find((inst) => inst.semanticNodeId === 'n_state_write');
  assert.equal(select.op, OP.SEL);
  assert.deepEqual(select.args.map((arg) => arg.value.semanticValueId), ['yes', 'no']);
  assert.equal(select.conditionValue.semanticValueId, 'cond_select');
  assert.equal(stateWrite.op, OP.CLOBBER);
  assert.deepEqual(stateWrite.clobbers, ['flags:generic-condition']);
}

// Scalar SSA phi + branch relationships.
{
  const cond = entryValue('cond', bit1, 'state:cond');
  const left = entryValue('left', bit32, 'state:x');
  const right = entryValue('right', bit32, 'state:x');
  const merged = entryValue('merged', bit32, 'state:x');
  const blocks = [
    { id: 'entry', nodeIds: ['n_cbr'], origin: origin('block_entry', 0x2000n) },
    { id: 'left', nodeIds: ['n_left_br'], origin: origin('block_left', 0x2010n) },
    { id: 'right', nodeIds: ['n_right_br'], origin: origin('block_right', 0x2020n) },
    { id: 'merge', nodeIds: ['n_ret'], origin: origin('block_merge', 0x2030n) },
  ];
  const nodes = [
    { id: 'n_cbr', kind: 'conditional-branch', blockId: 'entry', inputs: ['cond'], outputs: [], targets: ['left', 'right'], origin: origin('ins_cbr', 0x2000n) },
    { id: 'n_left_br', kind: 'branch', blockId: 'left', inputs: [], outputs: [], targets: ['merge'], origin: origin('ins_lbr', 0x2010n) },
    { id: 'n_right_br', kind: 'branch', blockId: 'right', inputs: [], outputs: [], targets: ['merge'], origin: origin('ins_rbr', 0x2020n) },
    { id: 'n_ret', kind: 'return', blockId: 'merge', inputs: ['merged'], outputs: [], origin: origin('ins_phi_ret', 0x2030n) },
  ];
  const ir = semanticFunction({ blocks, values: [cond, left, right, merged], nodes, at: 0x2000n });
  const ssa = {
    contractVersion: '2.0.0', functionId: 'fn',
    definitions: [
      { definitionId: 'd_cond', valueId: 'cond', kind: 'entry', blockId: null, variableKey: 'state:cond', sourceEntityId: 'fn', incoming: [], origin: cond.origin },
      { definitionId: 'd_left', valueId: 'left', kind: 'entry', blockId: null, variableKey: 'state:x', sourceEntityId: 'fn', incoming: [], origin: left.origin },
      { definitionId: 'd_right', valueId: 'right', kind: 'entry', blockId: null, variableKey: 'state:x', sourceEntityId: 'fn', incoming: [], origin: right.origin },
      { definitionId: 'd_phi', valueId: 'merged', kind: 'phi', blockId: 'merge', variableKey: 'state:x', sourceEntityId: null,
        incoming: [{ predecessorBlockId: 'left', valueId: 'left' }, { predecessorBlockId: 'right', valueId: 'right' }], origin: origin('ssa_phi', 0x2030n) },
    ],
    uses: [{ useId: 'u_ret', valueId: 'merged', blockId: 'merge', sourceEntityId: 'n_ret', origin: origin('ssa_use_ret', 0x2030n) }],
  };
  const out = projectSemanticIrV2ToLegacyV1(ir, { ssa });
  const phi = out.instructions.find((inst) => inst.op === OP.PHI);
  assert.ok(phi);
  assert.equal(phi.dst.kind, VK.PHI);
  assert.equal(phi.reg, 'state:x');
  assert.deepEqual(phi.incoming.map((item) => item.value.semanticValueId).sort(), ['left', 'right']);
  const entry = out.blocks.find((block) => block.semanticBlockId === 'entry');
  const leftBlock = out.blocks.find((block) => block.semanticBlockId === 'left');
  const rightBlock = out.blocks.find((block) => block.semanticBlockId === 'right');
  const merge = out.blocks.find((block) => block.semanticBlockId === 'merge');
  assert.deepEqual(entry.succ.slice().sort((a, b) => a - b), [leftBlock.index, rightBlock.index].sort((a, b) => a - b));
  assert.ok(merge.pred.includes(leftBlock.index));
  assert.ok(merge.pred.includes(rightBlock.index));
  const cbr = out.instructions.find((inst) => inst.semanticNodeId === 'n_cbr');
  assert.equal(cbr.op, OP.CBR);
  assert.equal(cbr.extra.targetBlockId, 'left');
  assert.equal(cbr.extra.fallthroughBlockId, 'right');
}

// Partial/unknown semantics stay explicit and preserve provenance.
{
  const unknown = defValue('u', 'n_unknown', bit32, null, 0x6000n);
  const ir = oneBlock([
    { id: 'n_unknown', kind: 'unknown-value', blockId: 'b0', inputs: [], outputs: ['u'], completeness: 'unknown', unknown: { reason: 'operation not modeled', categories: ['value'] }, origin: origin('ins_unknown_value', 0x6000n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['u'], outputs: [], origin: origin('ins_unknown_ret', 0x6004n) },
  ], [unknown], { completeness: 'partial', unknowns: [{ reason: 'one operation unknown', categories: ['value'] }], at: 0x6000n });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = out.instructions.find((candidate) => candidate.semanticNodeId === 'n_unknown');
  assert.equal(inst.op, OP.UNKNOWN);
  assert.equal(inst.extra.reason, 'operation not modeled');
  assert.deepEqual(inst.sourceInstructionIds, ['ins_unknown_value']);
  assert.equal(inst.origin.instructionIds[0], 'ins_unknown_value');
  assert.equal(out.compat.origins.nodes.n_unknown.instructionIds[0], 'ins_unknown_value');
  assert.equal(inst.dst.origin.instructionIds[0], 'ins_u');
  const functionUnknown = out.instructions.find((candidate) => candidate.extra?.functionUnknown === true);
  assert.ok(functionUnknown);
  assert.equal(functionUnknown.op, OP.UNKNOWN);
  assert.equal(functionUnknown.extra.reason, 'one operation unknown');
  assert.equal(functionUnknown.sourceEntityId, 'fn');
}

// Injected ABI adapter is honored without architecture knowledge in the projector.
{
  const arg = entryValue('arg', bit64, 'state:arg');
  const ret = defValue('retv', 'n_call', bit64, 'state:ret', 0x7000n);
  const ir = oneBlock([
    { id: 'n_call', kind: 'call', blockId: 'b0', inputs: ['arg'], outputs: ['retv'], call: callSummary({ args: ['arg'], returns: ['retv'] }), origin: origin('ins_known_call', 0x7000n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['retv'], outputs: [], origin: origin('ins_known_ret', 0x7004n) },
  ], [arg, ret], { at: 0x7000n });
  const abiAdapter = {
    classifyCall() {
      return {
        callArguments: [{ index: 0, location: 'register', reg: 'opaque_arg_bank_0' }],
        stackArguments: [], stackArgsUnknown: false, stackArgsMayContainPointers: false,
        argumentEvidence: 'synthetic-abi', clobbers: ['opaque_caller_saved'], returnReg: 'opaque_return', returnBits: 64,
      };
    },
  };
  const withAbi = projectSemanticIrV2ToLegacyV1(ir, { abiAdapter });
  const call = withAbi.instructions.find((inst) => inst.semanticNodeId === 'n_call');
  assert.equal(call.callArguments[0].reg, 'opaque_arg_bank_0');
  assert.deepEqual(call.clobbers, ['opaque_caller_saved']);
  assert.equal(call.argumentEvidence, 'synthetic-abi');
  assert.equal(call.returnReg, 'opaque_return');
  assert.equal(call.returnBits, 64);

  const withoutAbi = projectSemanticIrV2ToLegacyV1(ir);
  const conservative = withoutAbi.instructions.find((inst) => inst.semanticNodeId === 'n_call');
  assert.equal(conservative.callArguments, null);
  assert.equal(conservative.stackArguments, null);
  assert.equal(conservative.stackArgsUnknown, true);
  assert.equal(conservative.stackArgsMayContainPointers, true);
  assert.equal(conservative.argumentEvidence, 'semantic-ir-v2-no-abi-adapter');
  assert.ok(!JSON.stringify(conservative.extra).includes('x0'));
  assert.ok(!JSON.stringify(conservative.extra).includes('v0'));
}

assert.equal(SEMANTIC_IR_V2_V1_COMPAT.legacyOps.BIN, OP.BIN);
assert.equal(SEMANTIC_IR_V2_V1_COMPAT.legacyValueKinds.PHI, VK.PHI);
assert.equal(SEMANTIC_IR_V2_V1_COMPAT.legacyMemoryKinds.UNKNOWN, MK.UNKNOWN);
console.log('semantic-v2 legacy v1 core compatibility projection: PASS');
