import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const computedTarget = Object.freeze({
  kind:'temporary',
  temporaryId:'computed-target',
  valueType:{ kind:'bitvector', widthBits:64 },
});
const targetRegister = Object.freeze({ kind:'register', registerId:'target-reg', widthBits:64 });

function indirectBundle(decoded) {
  return createMachineEffectBundle({
    instructionId:decoded.instructionId,
    architectureId:'issue-949-test',
    mode:decoded.mode,
    operations:[{
      id:`${decoded.instructionId}:target-read`,
      kind:'register-read',
      register:targetRegister,
      value:computedTarget,
    }],
    controlEffect:{ kind:'indirect', target:computedTarget },
    possibleFaults:[],
    origin:decoded.origin,
    completeness:'exact',
  });
}

function returnBundle(decoded) {
  return createMachineEffectBundle({
    instructionId:decoded.instructionId,
    architectureId:'issue-949-test',
    mode:decoded.mode,
    operations:[],
    controlEffect:{ kind:'return' },
    possibleFaults:[],
    origin:decoded.origin,
    completeness:'exact',
  });
}

const plugin = Object.freeze({
  id:'issue-949-test',
  semanticVersion:'1',
  fixedInstructionSize:4,
  liftExact(decoded) {
    return decoded.testKind === 'indirect' ? indirectBundle(decoded) : returnBundle(decoded);
  },
});

function build({ candidates = false } = {}) {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin:plugin,
    decoderSemanticVersion:'issue-949-decoder-1',
    binaryId:candidates ? 'issue_949_candidates' : 'issue_949_unknown',
    sliceId:'slice',
    addressWidthBits:64,
    entryBlockKey:'entry',
    blocks:[
      {
        key:'entry', startAddress:0x1000n,
        instructions:[{
          decoded:{ address:0x1000n, size:4, mode:'test', testKind:'indirect' },
          ...(candidates ? { controlTargets:[
            { target:computedTarget, to:'left', role:'indirect' },
            { target:computedTarget, to:'right', role:'indirect' },
          ] } : {}),
        }],
        // No caller-supplied successor. The semantic lowering must not turn an
        // indirect branch into a successor-free terminal block.
        successors:[],
      },
      ...(candidates ? [
        {
          key:'left', startAddress:0x1010n,
          instructions:[{ decoded:{ address:0x1010n, size:4, mode:'test', testKind:'return' } }],
          successors:[],
        },
        {
          key:'right', startAddress:0x1020n,
          instructions:[{ decoded:{ address:0x1020n, size:4, mode:'test', testKind:'return' } }],
          successors:[],
        },
      ] : []),
    ],
  });
}

function indirectNode(result) {
  return result.semanticIr.nodes.find((node) =>
    node.kind === 'unknown-control-effect' && node.attributes?.indirectControl);
}

// Unknown destination: preserve the computed target dependency and a typed
// unknown successor. This is not fallthrough and not a real function return.
{
  const result = build();
  const node = indirectNode(result);
  assert.ok(node, 'indirect control must remain explicit in Semantic IR');
  assert.equal(node.inputs.length, 1, 'computed indirect target must remain an input');
  assert.equal(node.targets.length, 1, 'unknown destination still has an unknown successor');
  assert.equal(node.attributes.indirectControl.targetState, 'unknown');
  assert.equal(node.attributes.indirectControl.candidateCount, 0);

  const producer = result.semanticIr.nodes.find((candidate) => candidate.outputs.includes(node.inputs[0]));
  assert.ok(producer, 'target ValueId must retain its producer');
  assert.equal(producer.kind, 'state-read');

  // Semantic IR ids and canonical SSA ids are intentionally distinct identity
  // domains. Verify the actual cross-layer use-def proof rather than requiring
  // those two ids to be byte-for-byte equal.
  const targetUse = result.ssa.uses.find((use) =>
    use.sourceEntityId === node.id
    && use.proof?.kind === 'semantic-value-use'
    && use.proof?.sourceSemanticValueId === node.inputs[0]
    && use.proof?.roles?.includes('input'));
  assert.ok(targetUse, 'SSA must retain an input use for the computed target semantic ValueId');
  const targetDefinition = result.ssa.definitions.find((definition) => definition.valueId === targetUse.valueId);
  assert.ok(targetDefinition, 'computed target SSA use must resolve to a canonical SSA definition');
  assert.equal(targetDefinition.proof?.sourceSemanticValueId, node.inputs[0],
    'computed target SSA definition must preserve the source semantic ValueId');

  const entry = result.cfg.blocks.find((block) => block.id === result.semanticIr.entryBlockId);
  assert.ok(entry);
  assert.equal(entry.successors.length, 1);
  assert.equal(entry.successors[0].kind, 'unknown');
  assert.notEqual(entry.successors[0].kind, 'fallthrough');
}

// Later refinement may prove multiple targets. Preserve all of them as
// indirect candidates rather than replacing them with one guessed branch.
{
  const result = build({ candidates:true });
  const node = indirectNode(result);
  assert.ok(node);
  assert.equal(node.inputs.length, 1);
  assert.equal(node.targets.length, 2);
  assert.equal(node.attributes.indirectControl.targetState, 'candidate');
  assert.equal(node.attributes.indirectControl.candidateCount, 2);

  const entry = result.cfg.blocks.find((block) => block.id === result.semanticIr.entryBlockId);
  assert.ok(entry);
  assert.equal(entry.successors.length, 2);
  assert.deepEqual(new Set(entry.successors.map((edge) => edge.kind)), new Set(['indirect-candidate']));
}

console.log('issue #949 indirect control target/successor regression: PASS');
