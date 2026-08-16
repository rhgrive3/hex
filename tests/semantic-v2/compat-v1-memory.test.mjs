import assert from 'node:assert/strict';
import { OP, VK, MK } from '../../js/ir-core.js';
import { projectSemanticIrV2ToLegacyV1, SEMANTIC_IR_V2_V1_COMPAT } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const bit64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };

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
function memory(addressValueId, widthBits = 32) {
  return { addressSpace: 'memory', addressExpr: { valueId: addressValueId }, widthBits, endian: 'little', alignment: Math.max(1, widthBits / 8), volatility: false, atomic: false, ordering: 'unknown', faults: [] };
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


function memoryFixture({ includeUnknownStore = false, includeCall = false } = {}) {
  const addr = defValue('addr', 'n_addr', addr64, null, 0x3000n);
  const unknownAddr = entryValue('unknown_addr', addr64, 'ptr:unknown', 0x3004n);
  const stored = defValue('stored', 'n_value', bit32, null, 0x3008n);
  const loaded = defValue('loaded', 'n_load', bit32, null, 0x3020n);
  const values = [addr, unknownAddr, stored, loaded];
  const nodes = [
    { id: 'n_addr', kind: 'address', blockId: 'b0', inputs: [], outputs: ['addr'], attributes: { value: '0x4000' }, origin: origin('ins_addr', 0x3000n) },
    { id: 'n_value', kind: 'const', blockId: 'b0', inputs: [], outputs: ['stored'], attributes: { value: 7 }, origin: origin('ins_value', 0x3008n) },
    { id: 'n_store', kind: 'store', blockId: 'b0', inputs: ['addr', 'stored'], outputs: [], memory: memory('addr'), origin: origin('ins_store', 0x3010n) },
  ];
  if (includeUnknownStore) nodes.push({ id: 'n_unknown_store', kind: 'store', blockId: 'b0', inputs: ['unknown_addr', 'stored'], outputs: [], memory: memory('unknown_addr'), completeness: 'partial', unknown: { reason: 'pointer target unresolved', categories: ['memory'] }, origin: origin('ins_unknown_store', 0x3014n) });
  if (includeCall) {
    nodes.push({ id: 'n_call', kind: 'call', blockId: 'b0', inputs: [], outputs: [], call: callSummary({ memoryWrite: 'unknown', completeness: 'unknown' }), completeness: 'partial', unknown: { reason: 'callee unresolved', categories: ['memory', 'state', 'control'] }, origin: origin('ins_call', 0x3018n) });
  }
  nodes.push(
    { id: 'n_load', kind: 'load', blockId: 'b0', inputs: ['addr'], outputs: ['loaded'], memory: memory('addr'), origin: origin('ins_load', 0x3020n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['loaded'], outputs: [], origin: origin('ins_mem_ret', 0x3024n) },
  );
  const hasUnknown = includeUnknownStore || includeCall;
  return oneBlock(nodes, values, hasUnknown ? {
    at: 0x3000n,
    completeness: 'partial',
    unknowns: [{ reason: 'memory fixture has unresolved effects', categories: ['memory'] }],
  } : { at: 0x3000n });
}
function memorySsaFor({ barrierKind = null, barrierSource = null } = {}) {
  const definitions = [
    { id: 'm0', kind: 'entry', regionId: 'r_global', blockId: null, previousDefinitionIds: [], incoming: [], aliasRelation: null, sourceEntityId: null, origin: origin('m_entry', 0x3000n) },
    { id: 'm1', kind: 'memory-def', regionId: 'r_global', blockId: 'b0', previousDefinitionIds: ['m0'], incoming: [], aliasRelation: 'must', sourceEntityId: 'n_store', origin: origin('m_store', 0x3010n) },
  ];
  let reaching = 'm1';
  if (barrierKind) {
    definitions.push({ id: 'm2', kind: barrierKind, regionId: 'r_global', blockId: 'b0', previousDefinitionIds: ['m1'], incoming: [],
      aliasRelation: barrierKind === 'unknown-clobber' ? 'unknown' : 'may', sourceEntityId: barrierSource, origin: origin('m_barrier', 0x3018n) });
    reaching = 'm2';
  }
  return {
    contractVersion: '2.0.0', functionId: 'fn',
    regions: [{ id: 'r_global', kind: 'global-absolute', binaryId: 'binary', address: '0x4000', widthBits: 32, origin: origin('region_global', 0x4000n) }],
    definitions,
    uses: [{ id: 'mu_load', regionId: 'r_global', reachingDefinitionId: reaching, aliasRelation: barrierKind ? 'unknown' : 'must', blockId: 'b0', sourceEntityId: 'n_load', origin: origin('m_use', 0x3020n) }],
  };
}

// Load/store + exact reaching store.
{
  const out = projectSemanticIrV2ToLegacyV1(memoryFixture(), { memorySsa: memorySsaFor() });
  const store = out.instructions.find((inst) => inst.semanticNodeId === 'n_store');
  const load = out.instructions.find((inst) => inst.semanticNodeId === 'n_load');
  assert.equal(store.op, OP.STORE);
  assert.equal(load.op, OP.LOAD);
  assert.equal(store.loc.kind, MK.GLOBAL);
  assert.equal(load.loc.kind, MK.GLOBAL);
  assert.equal(load.reachingStore, store);
  assert.equal(load.memUse.kind, 'store');
  assert.equal(load.memoryAliasRelation, 'must');
}

// Unknown store barrier: no stale exact reachingStore is reconstructed.
{
  const ir = memoryFixture({ includeUnknownStore: true });
  const mssa = memorySsaFor({ barrierKind: 'unknown-clobber', barrierSource: 'n_unknown_store' });
  const out = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: mssa });
  const unknownStore = out.instructions.find((inst) => inst.semanticNodeId === 'n_unknown_store');
  const load = out.instructions.find((inst) => inst.semanticNodeId === 'n_load');
  assert.equal(unknownStore.op, OP.STORE);
  assert.equal(unknownStore.loc.kind, MK.UNKNOWN);
  assert.equal(load.reachingStore, null);
  assert.equal(load.memUse.kind, 'clobber');
  assert.equal(load.memUse.unknownAlias, true);
  assert.equal(load.unknownAliasBarrier, unknownStore);
  assert.equal(out.memorySafety.unknownStores, 1);
  assert.equal(out.memorySafety.blockedLoads, 1);
}

// Generic may-alias memory clobber also blocks an exact reaching store.
{
  const ir = memoryFixture({ includeUnknownStore: true });
  const mssa = memorySsaFor({ barrierKind: 'may-alias-clobber', barrierSource: 'n_unknown_store' });
  const out = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: mssa });
  const barrier = out.instructions.find((inst) => inst.semanticNodeId === 'n_unknown_store');
  const load = out.instructions.find((inst) => inst.semanticNodeId === 'n_load');
  assert.equal(barrier.memoryBarrier, true);
  assert.ok(barrier.memKills.some((loc) => loc.kind === MK.GLOBAL));
  assert.equal(load.reachingStore, null);
  assert.equal(load.memUse.kind, 'clobber');
  assert.equal(load.memUse.reason, 'may-alias-clobber');
}

// Unknown call + call-clobber MemorySSA barrier.
{
  const ir = memoryFixture({ includeCall: true });
  const mssa = memorySsaFor({ barrierKind: 'call-clobber', barrierSource: 'n_call' });
  const out = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: mssa });
  const call = out.instructions.find((inst) => inst.semanticNodeId === 'n_call');
  const load = out.instructions.find((inst) => inst.semanticNodeId === 'n_load');
  assert.equal(call.op, OP.CALL);
  assert.equal(call.memoryBarrier, true);
  assert.ok(call.memKills.length >= 1);
  assert.equal(call.callArguments, null);
  assert.equal(call.stackArgsUnknown, true);
  assert.equal(load.reachingStore, null);
  assert.equal(load.memUse.kind, 'clobber');
}

// Intrinsic with unresolved memory writes becomes an explicit clobber/barrier.
{
  const x = entryValue('x', bit32);
  const ir = oneBlock([
    { id: 'n_intrinsic', kind: 'intrinsic', blockId: 'b0', inputs: ['x'], outputs: [], operator: 'opaque-op',
      intrinsic: { inputs: ['x'], outputs: [], stateReads: [], stateWrites: [], memoryRead: { scope: 'none' }, memoryWrite: { scope: 'unknown', detail: { reason: 'intrinsic write set unresolved' } }, controlEffects: [], determinism: 'input-dependent', symbolicDetail: 'summary-only' },
      completeness: 'partial', unknown: { reason: 'intrinsic memory scope unresolved', categories: ['memory'] }, origin: origin('ins_intrinsic', 0x5000n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: [], outputs: [], origin: origin('ins_intrinsic_ret', 0x5004n) },
  ], [x], {
    at: 0x5000n,
    completeness: 'partial',
    unknowns: [{ reason: 'intrinsic memory scope unresolved', categories: ['memory'] }],
  });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const intrinsic = out.instructions.find((inst) => inst.semanticNodeId === 'n_intrinsic');
  assert.equal(intrinsic.op, OP.CLOBBER);
  assert.equal(intrinsic.memoryBarrier, true);
  assert.ok(intrinsic.memKills.some((loc) => loc.kind === MK.UNKNOWN));
}


// Deterministic projection for the data-bearing public shape.
{
  const ir = memoryFixture({ includeUnknownStore: true });
  const mssa = memorySsaFor({ barrierKind: 'unknown-clobber', barrierSource: 'n_unknown_store' });
  const snapshot = (out) => ({
    functionId: out.functionId,
    values: out.values.map((value) => ({ id: value.id, vid: value.vid, kind: value.kind, reg: value.reg, version: value.version, bits: value.bits, const: value.const == null ? null : value.const.toString(), semanticValueId: value.semanticValueId })),
    instructions: out.instructions.map((inst) => ({ id: inst.id, op: inst.op, sub: inst.sub, block: inst.block, row: inst.row, address: inst.address == null ? null : inst.address.toString(), semanticNodeId: inst.semanticNodeId, dst: inst.dst?.semanticValueId ?? null, args: inst.args.map((arg) => arg.value?.semanticValueId ?? null), loc: inst.loc ? { key: inst.loc.key, kind: inst.loc.kind } : null, reachingStore: inst.reachingStore?.semanticNodeId ?? null, memUse: inst.memUse ? { kind: inst.memUse.kind, definitionId: inst.memUse.definitionId } : null })),
    blocks: out.blocks.map((block) => ({ index: block.index, id: block.semanticBlockId, succ: block.succ, pred: block.pred, phis: block.phis.map((inst) => inst.id), memPhis: block.memPhis.map((node) => node.definitionId) })),
    locations: [...out.locations.entries()].map(([key, loc]) => [key, loc.kind]).sort(),
    memorySafety: out.memorySafety,
    compat: out.compat,
  });
  assert.deepEqual(snapshot(projectSemanticIrV2ToLegacyV1(ir, { memorySsa: mssa })), snapshot(projectSemanticIrV2ToLegacyV1(ir, { memorySsa: mssa })));
}


assert.equal(SEMANTIC_IR_V2_V1_COMPAT.legacyMemoryKinds.UNKNOWN, MK.UNKNOWN);
console.log('semantic-v2 legacy v1 memory compatibility projection: PASS');
