import assert from 'node:assert/strict';
import {
  ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  liftArm64MachineEffects,
} from '../../js/targets/architecture/arm64/effects/index.js';
import { ARM64_EXCLUSIVE_MONITOR_STATE } from '../../js/targets/architecture/arm64/effects/exclusive-monitor-state.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { getDefinitionForUse, getSsaUsesForSourceEntity } from '../../js/semantics/ssa/index.js';

const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const other = (text) => ({ k:'other', text });
const mem = (base) => ({ k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset', disp:null, addressDisp:null, writebackDisp:null });

const plugin = Object.freeze({
  id:'arm64',
  semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  fixedInstructionSize:4,
  registerFile:()=>Object.freeze([]),
  liftExact:liftArm64MachineEffects,
});

function decoded(mnemonic, ops, address) {
  return { address, size:4, mode:'a64', mnemonic, ops };
}

function build(instructions, binaryId) {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin:plugin,
    decoderSemanticVersion:'issue-929-decoder-1',
    binaryId,
    sliceId:'slice',
    addressWidthBits:64,
    entryBlockKey:'entry',
    blocks:[{
      key:'entry',
      startAddress:instructions[0].address,
      instructions:instructions.map((item) => ({ decoded:item })),
      successors:[],
    }],
  });
}

function instructionIds(result) {
  return result.instrumentation.instructions.map((item) => item.instructionId);
}

function stateNode(result, instructionId, kind, stateDefinition) {
  return result.semanticIr.nodes.find((node) =>
    node.kind === kind
    && node.attributes?.machineEffects?.instructionId === instructionId
    && node.variable?.physicalIdentity?.registerId === stateDefinition.registerId);
}

function reachingDefinition(result, readNode) {
  const uses = getSsaUsesForSourceEntity(result.ssa, readNode.id);
  assert.equal(uses.length, 1, `expected exactly one SSA use for ${readNode.id}`);
  return getDefinitionForUse(result.ssa, uses[0]);
}

// ldxr; stxr: STXR must consume the canonical local-monitor state established
// by LDXR rather than an unrelated bundle-local temporary.
{
  const result = build([
    decoded('ldxr', [x(0), mem(x(1))], 0x1000n),
    decoded('stxr', [w(2), x(3), mem(x(1))], 0x1004n),
  ], 'issue_929_basic');
  const [loadId, storeId] = instructionIds(result);
  const loadValidWrite = stateNode(result, loadId, 'state-write', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  const loadAddressWrite = stateNode(result, loadId, 'state-write', ARM64_EXCLUSIVE_MONITOR_STATE.address);
  const storeValidRead = stateNode(result, storeId, 'state-read', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  const storeAddressRead = stateNode(result, storeId, 'state-read', ARM64_EXCLUSIVE_MONITOR_STATE.address);
  assert.ok(loadValidWrite && loadAddressWrite && storeValidRead && storeAddressRead);
  assert.equal(reachingDefinition(result, storeValidRead)?.sourceEntityId, loadValidWrite.id);
  assert.equal(reachingDefinition(result, storeAddressRead)?.sourceEntityId, loadAddressWrite.id);

  const storeIntrinsic = result.semanticIr.nodes.find((node) =>
    node.kind === 'intrinsic'
    && node.attributes?.machineEffects?.instructionId === storeId
    && node.operator === 'arm64.exclusive-store-conditional');
  assert.ok(storeIntrinsic);
  assert.ok(storeIntrinsic.inputs.length >= 5, 'STXR intrinsic must include data, monitor state, and current address');
  assert.equal(storeIntrinsic.attributes.machineEffects.operationMetadata.monitorState.address.registerId,
    ARM64_EXCLUSIVE_MONITOR_STATE.address.registerId);
  assert.equal(storeIntrinsic.attributes.machineEffects.operationMetadata.monitorState.reservationGranule.relation,
    'unknown-until-proven');

  const consumedWrite = stateNode(result, storeId, 'state-write', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  assert.ok(consumedWrite, 'STXR must define the post-attempt invalid monitor state');
}

// ldxr; clrex; stxr: CLREX versions `valid`, so STXR reaches the cleared state.
{
  const result = build([
    decoded('ldxr', [x(0), mem(x(1))], 0x2000n),
    decoded('clrex', [], 0x2004n),
    decoded('stxr', [w(2), x(3), mem(x(1))], 0x2008n),
  ], 'issue_929_clear');
  const [, clearId, storeId] = instructionIds(result);
  const clearValidWrite = stateNode(result, clearId, 'state-write', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  const storeValidRead = stateNode(result, storeId, 'state-read', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  assert.ok(clearValidWrite && storeValidRead);
  assert.equal(reachingDefinition(result, storeValidRead)?.sourceEntityId, clearValidWrite.id);
}

// Reservation address and current store address are distinct explicit inputs.
{
  const result = build([
    decoded('ldxr', [x(0), mem(x(1))], 0x3000n),
    decoded('stxr', [w(2), x(3), mem(x(4))], 0x3004n),
  ], 'issue_929_address_relation');
  const [, storeId] = instructionIds(result);
  const storeIntrinsic = result.semanticIr.nodes.find((node) =>
    node.kind === 'intrinsic'
    && node.attributes?.machineEffects?.instructionId === storeId
    && node.operator === 'arm64.exclusive-store-conditional');
  assert.ok(storeIntrinsic);
  assert.deepEqual(
    storeIntrinsic.attributes.machineEffects.operationMetadata.monitorInputOrder,
    ['valid','reservation-address','reservation-width','current-address'],
  );
  assert.equal(
    storeIntrinsic.attributes.machineEffects.operationMetadata.reservationAddressRelation,
    'must-be-compatible-with-current-exclusive-reservation-granule',
  );
}

// A later LDXR dominates an earlier reservation.
{
  const result = build([
    decoded('ldxr', [x(0), mem(x(1))], 0x4000n),
    decoded('ldxr', [x(5), mem(x(4))], 0x4004n),
    decoded('stxr', [w(2), x(3), mem(x(4))], 0x4008n),
  ], 'issue_929_second_load');
  const [, secondLoadId, storeId] = instructionIds(result);
  const secondAddressWrite = stateNode(result, secondLoadId, 'state-write', ARM64_EXCLUSIVE_MONITOR_STATE.address);
  const storeAddressRead = stateNode(result, storeId, 'state-read', ARM64_EXCLUSIVE_MONITOR_STATE.address);
  assert.ok(secondAddressWrite && storeAddressRead);
  assert.equal(reachingDefinition(result, storeAddressRead)?.sourceEntityId, secondAddressWrite.id);
}

// DMB/DSB do not masquerade as exclusive-monitor invalidation.
{
  const result = build([
    decoded('ldxr', [x(0), mem(x(1))], 0x5000n),
    decoded('dmb', [other('ish')], 0x5004n),
    decoded('dsb', [other('ish')], 0x5008n),
    decoded('stxr', [w(2), x(3), mem(x(1))], 0x500cn),
  ], 'issue_929_barriers');
  const [loadId,,, storeId] = instructionIds(result);
  const loadValidWrite = stateNode(result, loadId, 'state-write', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  const storeValidRead = stateNode(result, storeId, 'state-read', ARM64_EXCLUSIVE_MONITOR_STATE.valid);
  assert.ok(loadValidWrite && storeValidRead);
  assert.equal(reachingDefinition(result, storeValidRead)?.sourceEntityId, loadValidWrite.id);
}

console.log('issue #929 exclusive monitor MachineEffects -> Semantic IR -> SSA: PASS');
