import assert from 'node:assert/strict';
import { createOriginSet } from '../../js/core/identity/origin.js';
import {
  createMachineEffectBundle,
  createRegisterValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const target = createRegisterValue('x3', 64);
const bundle = createMachineEffectBundle({
  instructionId:'issue-949-br-x3',
  architectureId:'arm64',
  mode:'a64',
  operations:[],
  controlEffect:{ kind:'indirect', target },
  possibleFaults:[],
  origin:createOriginSet({ instructionIds:['issue-949-br-x3'] }),
  completeness:'exact',
});

const ir = lowerMachineEffectBundleToSemanticIr(bundle, {
  functionId:'issue-949-function',
  blockId:'issue-949-entry',
  entryBlockId:'issue-949-entry',
  addressWidthBits:64,
});

const control = ir.nodes.find((node) => node.kind === 'unknown-control-effect');
assert.ok(control, 'unresolved indirect branch must remain an explicit control node');
assert.equal(control.inputs.length, 1, 'computed target must be a typed control input');
assert.equal(control.targets.length, 1, 'unknown destination must not collapse to successor-less termination');
assert.equal(control.unknown.reason, 'unresolved-indirect-control-flow');
assert.equal(control.unknown.knownParts.targetValueId, control.inputs[0]);
assert.equal(control.attributes.unresolvedSuccessor, true);
assert.ok(ir.blocks.some((block) => block.id === control.targets[0]), 'unknown successor placeholder must exist in the IR block set');

const targetRead = ir.nodes.find((node) => node.kind === 'state-read'
  && node.variable?.physicalIdentity?.kind === 'register'
  && node.variable.physicalIdentity.registerId === 'x3');
assert.ok(targetRead, 'BR target register must remain visible as physical state');
assert.equal(control.inputs[0], targetRead.outputs[0], 'target producer/read must feed the control sink');
assert.equal(ir.completeness, 'partial');
assert.ok(ir.unknowns.some((unknown) => unknown.reason === 'unresolved-indirect-control-flow'));

console.log('issue #949 computed indirect-control target/provenance regression: PASS');
