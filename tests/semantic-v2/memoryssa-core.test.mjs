import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import {
  explainMemoryPath,
  memoryAccessMetadata,
  memoryUsesOfDefinition,
  reachingConcreteStore,
  reachingMemoryDefinition,
} from '../../js/semantics/memoryssa/queries.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const functionId = 'function_memoryssa_fixture';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const machineType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const memory = (valueId, overrides = {}) => ({
  addressSpace: 'memory',
  addressValueId: valueId,
  widthBits: 32,
  endian: 'little',
  volatility: false,
  atomic: false,
  ordering: 'unknown',
  ...overrides,
});
const node = (id, kind, extra = {}) => ({
  id,
  kind,
  blockId: extra.blockId ?? 'entry',
  inputs: [],
  outputs: [],
  origin: origin(id),
  ...extra,
});
function callSummary({ completeness = 'complete', memoryRead = { scope: 'none' }, memoryWrite = { scope: 'none' } } = {}) {
  return {
    targetValueIds: [],
    targetEntityIds: [],
    arguments: [],
    returns: [],
    stateReads: [],
    stateWrites: [],
    memoryRead,
    memoryWrite,
    controlEffects: [],
    determinism: completeness === 'complete' ? 'deterministic' : 'unknown',
    noreturn: completeness === 'complete' ? false : 'unknown',
    mayThrow: completeness === 'complete' ? false : 'unknown',
    summarySource: 'fixture',
    completeness,
    unknownEffects: completeness === 'complete' ? null : { reason: 'unresolved-call', categories: ['memory'] },
  };
}
function intrinsicSummary({ memoryRead = { scope: 'none' }, memoryWrite = { scope: 'none' } } = {}) {
  return {
    inputs: [],
    outputs: [],
    stateReads: [],
    stateWrites: [],
    memoryRead,
    memoryWrite,
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  };
}
function makeFunction(blocks, nodes) {
  const addressIds = new Set();
  for (const item of nodes) {
    if (item.memory) addressIds.add(item.memory.addressExpr?.valueId ?? item.memory.addressValueId);
    for (const scope of [item.call?.memoryRead, item.call?.memoryWrite, item.intrinsic?.memoryRead, item.intrinsic?.memoryWrite]) {
      for (const access of scope?.accesses ?? []) addressIds.add(access.addressExpr?.valueId ?? access.addressValueId);
    }
  }
  const values = [...addressIds].filter(Boolean).sort().map((id) => ({
    id,
    kind: 'entry',
    machineType,
    origin: origin(id),
  }));
  return createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: blocks.map((block) => ({ id: block.id, nodeIds: block.nodeIds, origin: origin(block.id) })),
    values,
    nodes,
    completeness: nodes.some((item) => item.completeness && item.completeness !== 'complete') ? 'partial' : 'complete',
    unknowns: nodes.some((item) => item.completeness && item.completeness !== 'complete')
      ? [{ reason: 'fixture-unknown', categories: ['memory'] }]
      : [],
    origin: origin('function'),
  });
}
function makeCfg(blocks) {
  return createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: blocks.map((block) => ({ id: block.id, successors: block.successors ?? [] })),
  });
}

const regionA = createMemoryRegionRef({
  id: 'region_A',
  kind: 'rooted-offset',
  functionId,
  rootEntityId: 'root_A',
  offset: 0,
  widthBits: 32,
});
const regionB = createMemoryRegionRef({
  id: 'region_B',
  kind: 'rooted-offset',
  functionId,
  rootEntityId: 'root_B',
  offset: 0,
  widthBits: 32,
});
const regionMaybe = createMemoryRegionRef({
  id: 'region_maybe',
  kind: 'rooted-offset',
  functionId,
  rootEntityId: 'root_maybe',
  offset: 0,
  widthBits: 32,
});
const regionUnknown = createMemoryRegionRef({
  id: 'region_unknown_fixture',
  kind: 'unknown',
  functionId,
  uncertaintyIdentity: { fixture: 'unknown-pointer' },
});
const regionByAddress = new Map([
  ['addr_A', regionA],
  ['addr_B', regionB],
  ['addr_maybe', regionMaybe],
  ['addr_unknown', regionUnknown],
]);
function fixtureProviders({ unknownReadNoAlias = false, unknownRelation = 'unknown', maybeRelation = 'may' } = {}) {
  return {
    resolveRegion(access) {
      return regionByAddress.get(access.addressExpr.valueId) ?? regionUnknown;
    },
    queryAlias(left, right, context) {
      const leftAddress = context.left.descriptor?.memory?.addressExpr?.valueId;
      const rightAddress = context.right.descriptor?.memory?.addressExpr?.valueId;
      if (context.purpose === 'read-reaches-write'
        && unknownReadNoAlias
        && leftAddress === 'addr_A'
        && rightAddress === 'addr_unknown') return 'no';
      if (left.id === regionUnknown.id || right.id === regionUnknown.id
        || left.metadata?.precision === 'conservative-default'
        || right.metadata?.precision === 'conservative-default') return unknownRelation;
      if ((left.id === regionMaybe.id && right.id === regionA.id)
        || (left.id === regionA.id && right.id === regionMaybe.id)) return maybeRelation;
      return left.id === right.id ? 'must' : 'no';
    },
  };
}
function buildLinear(nodes, providerOptions = {}, buildOptions = {}) {
  const blocks = [{ id: 'entry', nodeIds: nodes.map((item) => item.id), successors: [] }];
  const ir = makeFunction(blocks, nodes);
  const cfg = makeCfg(blocks);
  const providers = fixtureProviders(providerOptions);
  return { ir, cfg, memorySsa: buildMemorySsa(ir, cfg, { ...providers, ...buildOptions }) };
}
function useFor(memorySsa, sourceEntityId) {
  return memorySsa.uses.find((use) => use.sourceEntityId === sourceEntityId && use.regionId === regionA.id);
}

{
  const { memorySsa, cfg } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  const use = useFor(memorySsa, 'load_A');
  const definition = reachingMemoryDefinition(memorySsa, use);
  assert.equal(definition.kind, 'memory-def');
  assert.equal(definition.sourceEntityId, 'store_A');
  assert.equal(use.aliasRelation, 'must');
  assert.equal(reachingConcreteStore(memorySsa, use)?.id, definition.id);
  assert.deepEqual(memoryUsesOfDefinition(memorySsa, definition).map((item) => item.id), [use.id]);
  assert.ok(explainMemoryPath(memorySsa, use).nodes.some((item) => item.kind === 'entry'));
  assert.doesNotThrow(() => validateMemorySsa(memorySsa, { cfg }));
}

{
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_B', 'store', { memory: memory('addr_B') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  assert.equal(reachingMemoryDefinition(memorySsa, useFor(memorySsa, 'load_A')).sourceEntityId, 'store_A');
}

{
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_maybe', 'store', { memory: memory('addr_maybe') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  const use = useFor(memorySsa, 'load_A');
  const definition = reachingMemoryDefinition(memorySsa, use);
  assert.equal(definition.kind, 'may-alias-clobber');
  assert.equal(definition.sourceEntityId, 'store_maybe');
  assert.equal(reachingConcreteStore(memorySsa, use), null);
}

{
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_maybe', 'store', { memory: memory('addr_maybe') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ], { maybeRelation: 'unknown' });
  const definition = reachingMemoryDefinition(memorySsa, useFor(memorySsa, 'load_A'));
  assert.equal(definition.kind, 'unknown-clobber');
  assert.equal(definition.sourceEntityId, 'store_maybe');
}

{
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_unknown', 'store', { memory: memory('addr_unknown') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  const use = useFor(memorySsa, 'load_A');
  const definition = reachingMemoryDefinition(memorySsa, use);
  assert.equal(definition.kind, 'unknown-clobber');
  assert.equal(definition.sourceEntityId, 'store_unknown');
  assert.equal(reachingConcreteStore(memorySsa, use), null);
}

{
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_unknown', 'store', { memory: memory('addr_unknown') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ], { unknownReadNoAlias: true });
  const use = useFor(memorySsa, 'load_A');
  const definition = reachingMemoryDefinition(memorySsa, use);
  assert.equal(definition.kind, 'memory-def');
  assert.equal(definition.sourceEntityId, 'store_A');
  assert.equal(reachingConcreteStore(memorySsa, use)?.sourceEntityId, 'store_A');
}

{
  const unknownCall = node('call_unknown', 'call', {
    call: callSummary({ completeness: 'unknown', memoryRead: { scope: 'unknown' }, memoryWrite: { scope: 'unknown' } }),
    completeness: 'unknown',
    unknown: { reason: 'unresolved-call', categories: ['memory'] },
  });
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    unknownCall,
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  const definition = reachingMemoryDefinition(memorySsa, useFor(memorySsa, 'load_A'));
  assert.equal(definition.kind, 'call-clobber');
  assert.equal(definition.sourceEntityId, 'call_unknown');
  assert.equal(reachingConcreteStore(memorySsa, useFor(memorySsa, 'load_A')), null);
}

{
  const allIntrinsic = node('intrinsic_all', 'intrinsic', {
    intrinsic: intrinsicSummary({ memoryWrite: { scope: 'all', addressSpaces: ['memory'] } }),
  });
  const { memorySsa } = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    allIntrinsic,
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  const definition = reachingMemoryDefinition(memorySsa, useFor(memorySsa, 'load_A'));
  assert.equal(definition.kind, 'intrinsic-clobber');
  assert.equal(definition.sourceEntityId, 'intrinsic_all');
}

{
  const orderedMemory = memory('addr_A', { volatility: true, atomic: true, ordering: 'seq-cst', alignment: 4 });
  const { memorySsa } = buildLinear([
    node('store_ordered', 'store', { memory: orderedMemory }),
    node('load_ordered', 'load', { memory: orderedMemory }),
  ]);
  const definition = memorySsa.definitions.find((item) => item.sourceEntityId === 'store_ordered' && item.regionId === regionA.id);
  const use = useFor(memorySsa, 'load_ordered');
  assert.deepEqual(definition.effectSummary.sequencing, {
    alignment: 4,
    atomic: true,
    ordering: 'seq-cst',
    volatility: true,
  });
  assert.deepEqual(memoryAccessMetadata(memorySsa, use.id).sequencing, {
    alignment: 4,
    atomic: true,
    ordering: 'seq-cst',
    volatility: true,
  });
}

{
  const first = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_B', 'store', { memory: memory('addr_B') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]).memorySsa;
  const second = buildLinear([
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('store_B', 'store', { memory: memory('addr_B') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]).memorySsa;
  assert.equal(stableStringify(first), stableStringify(second));
  assert.ok(first.regions.some((region) => region.id === regionA.id));
  assert.ok(first.regions.some((region) => region.id === regionB.id));
  for (const definition of first.definitions) {
    assert.ok(definition.origin.transforms.some((transform) => transform.passId === 'semantic-memoryssa'));
  }
  for (const use of first.uses) {
    assert.ok(use.origin.transforms.some((transform) => transform.passId === 'semantic-memoryssa'));
  }
}

{
  const controller = new AbortController();
  controller.abort();
  const blocks = [{ id: 'entry', nodeIds: ['load_A'], successors: [] }];
  const ir = makeFunction(blocks, [node('load_A', 'load', { memory: memory('addr_A') })]);
  const cfg = makeCfg(blocks);
  assert.throws(() => buildMemorySsa(ir, cfg, { ...fixtureProviders(), signal: controller.signal }), /cancelled/);
}

{
  const blocks = [{ id: 'entry', nodeIds: ['store_A', 'load_A'], successors: [] }];
  const ir = makeFunction(blocks, [
    node('store_A', 'store', { memory: memory('addr_A') }),
    node('load_A', 'load', { memory: memory('addr_A') }),
  ]);
  const cfg = makeCfg(blocks);
  assert.throws(
    () => buildMemorySsa(ir, cfg, { ...fixtureProviders(), budget: { maxAliasQueries: 1 } }),
    /budget-exceeded-maxAliasQueries/,
  );
}

{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../..');
  for (const relative of [
    'js/semantics/memoryssa/build.js',
    'js/semantics/memoryssa/queries.js',
    'js/semantics/memoryssa/validate.js',
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /\b(?:arm64|aapcs64|nzcv|rax|rflags|x0|w8|stack|global|field)\b/i, `${relative} must remain architecture/region neutral`);
  }
}

console.log('semantic-v2 generic MemorySSA core: PASS');
