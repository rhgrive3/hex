import assert from 'node:assert/strict';
import { stableStringify } from '../../js/core/identity/index.js';
import {
  aliasMemoryRegions,
  classifySemanticMemoryRegion,
  deriveCanonicalAddressProof,
  deriveMemoryRegion,
  effectSummaryAliasRelation,
  sameCanonicalAddressProof,
  unknownStoreAliasRelation,
} from '../../js/analysis/alias/index-v2.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { reachingMemoryDefinition } from '../../js/semantics/memoryssa/queries.js';

const functionId = 'function_region_repair_fixture';
const binaryId = 'binary_region_repair_fixture';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const bit64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };

function semanticValue(id, definitionNodeId, machineType = bit64, extra = {}) {
  return {
    id,
    kind: definitionNodeId == null ? 'entry' : 'definition',
    machineType,
    definitionNodeId: definitionNodeId ?? null,
    sourceEntityId: null,
    variableKey: null,
    origin: origin(id),
    ...extra,
  };
}

function semanticNode(id, kind, extra = {}) {
  return {
    id,
    kind,
    blockId: 'block.entry',
    inputs: [],
    outputs: [],
    targets: [],
    attributes: {},
    completeness: 'complete',
    origin: origin(id),
    ...extra,
  };
}

function stateRead(id, valueId, key) {
  return semanticNode(id, 'state-read', {
    outputs: [valueId],
    variable: { key, kind: 'logical-state', scope: 'function' },
  });
}

function constant(id, valueId, value, machineType = bit64) {
  return {
    node: semanticNode(id, 'const', {
      outputs: [valueId],
      attributes: { constant: { kind: 'bitvector', widthBits: machineType.widthBits, value: String(value) } },
    }),
    value: semanticValue(valueId, id, machineType, {
      metadata: { constant: { kind: 'bitvector', widthBits: machineType.widthBits, value: String(value) } },
    }),
  };
}

function op(id, valueId, kind, operator, inputs, machineType = addr64) {
  return {
    node: semanticNode(id, kind, { operator, inputs, outputs: [valueId] }),
    value: semanticValue(valueId, id, machineType),
  };
}

function memoryNode(id, kind, addressValueId, widthBits = 32) {
  return semanticNode(id, kind, {
    inputs: kind === 'store' ? [addressValueId] : [addressValueId],
    memory: {
      addressSpace: 'memory',
      addressExpr: { valueId: addressValueId },
      widthBits,
      endian: 'little',
      alignment: null,
      volatility: false,
      atomic: false,
      ordering: 'unknown',
      faults: [],
    },
  });
}

function rawIr({ values, nodes, nodeIds = nodes.map((node) => node.id) }) {
  return {
    functionId,
    origin: origin('function'),
    blocks: [{ id: 'block.entry', nodeIds, origin: origin('block') }],
    values,
    nodes,
  };
}

function classify(ir, nodeId, options = {}) {
  return classifySemanticMemoryRegion(ir, nodeId, { binaryId, ...options });
}

function basicRootIr(key = 'root.a') {
  const read = stateRead('node.read.root', 'value.root', key);
  const load = memoryNode('node.load.root', 'load', 'value.root');
  return rawIr({
    values: [semanticValue('value.root', read.id, bit64)],
    nodes: [read, load],
  });
}

// A semantic copy must preserve the canonical root.
{
  const read = stateRead('node.read.copy', 'value.root.copy', 'root.a');
  const copied = op('node.copy', 'value.copy', 'copy', 'copy', ['value.root.copy'], bit64);
  const directLoad = memoryNode('node.load.direct', 'load', 'value.root.copy');
  const copiedLoad = memoryNode('node.load.copy', 'load', 'value.copy');
  const ir = rawIr({
    values: [semanticValue('value.root.copy', read.id, bit64), copied.value],
    nodes: [read, copied.node, directLoad, copiedLoad],
  });
  const direct = classify(ir, directLoad.id);
  const throughCopy = classify(ir, copiedLoad.id);
  assert.equal(direct.kind, 'rooted-offset');
  assert.equal(throughCopy.id, direct.id, 'copy(root) must preserve one canonical memory identity');
}

// Adding zero must not create a new alias class.
{
  const read = stateRead('node.read.zero', 'value.root.zero', 'root.a');
  const zero = constant('node.const.zero', 'value.zero', 0);
  const plusZero = op('node.addr.zero', 'value.addr.zero', 'address', 'add', ['value.root.zero', 'value.zero']);
  const directLoad = memoryNode('node.load.zero.direct', 'load', 'value.root.zero');
  const zeroLoad = memoryNode('node.load.zero.add', 'load', 'value.addr.zero');
  const ir = rawIr({
    values: [semanticValue('value.root.zero', read.id, bit64), zero.value, plusZero.value],
    nodes: [read, zero.node, plusZero.node, directLoad, zeroLoad],
  });
  assert.equal(classify(ir, directLoad.id).id, classify(ir, zeroLoad.id).id);
}

// Constant displacements accumulate canonically, including nested additions.
{
  const read = stateRead('node.read.offset', 'value.root.offset', 'root.a');
  const c4 = constant('node.const.4', 'value.const.4', 4);
  const c8 = constant('node.const.8', 'value.const.8', 8);
  const c12 = constant('node.const.12', 'value.const.12', 12);
  const plus4 = op('node.addr.4', 'value.addr.4', 'address', 'add', ['value.root.offset', 'value.const.4']);
  const nested = op('node.addr.12.nested', 'value.addr.12.nested', 'address', 'add', ['value.addr.4', 'value.const.8']);
  const flat = op('node.addr.12.flat', 'value.addr.12.flat', 'address', 'add', ['value.root.offset', 'value.const.12']);
  const nestedLoad = memoryNode('node.load.12.nested', 'load', 'value.addr.12.nested');
  const flatLoad = memoryNode('node.load.12.flat', 'load', 'value.addr.12.flat');
  const ir = rawIr({
    values: [semanticValue('value.root.offset', read.id, bit64), c4.value, c8.value, c12.value, plus4.value, nested.value, flat.value],
    nodes: [read, c4.node, c8.node, c12.node, plus4.node, nested.node, flat.node, nestedLoad, flatLoad],
  });
  const nestedProof = deriveCanonicalAddressProof(ir, 'value.addr.12.nested');
  const flatProof = deriveCanonicalAddressProof(ir, 'value.addr.12.flat');
  assert.equal(nestedProof.offset, 12n);
  assert.equal(flatProof.offset, 12n);
  assert.equal(sameCanonicalAddressProof(nestedProof, flatProof), true);
  assert.equal(classify(ir, nestedLoad.id).id, classify(ir, flatLoad.id).id);
}

function phiFixture({ incomingKinds }) {
  const state = stateRead('node.read.merge', 'value.merge.read', 'state.merge');
  const load = memoryNode('node.load.merge', 'load', 'value.merge.read');
  const rootA = semanticValue('value.entry.a', null, bit64, { variableKey: 'root.a' });
  const rootB = semanticValue('value.entry.b', null, bit64, { variableKey: 'root.b' });
  const c4 = constant('node.phi.const.4', 'value.phi.const.4', 4);
  const c8 = constant('node.phi.const.8', 'value.phi.const.8', 8);
  const a4 = op('node.phi.a4', 'value.phi.a4', 'address', 'add', ['value.entry.a', 'value.phi.const.4']);
  const a4b = op('node.phi.a4b', 'value.phi.a4b', 'address', 'add', ['value.entry.a', 'value.phi.const.4']);
  const a8 = op('node.phi.a8', 'value.phi.a8', 'address', 'add', ['value.entry.a', 'value.phi.const.8']);
  const b4 = op('node.phi.b4', 'value.phi.b4', 'address', 'add', ['value.entry.b', 'value.phi.const.4']);
  const ir = rawIr({
    values: [rootA, rootB, semanticValue('value.merge.read', state.id, bit64), c4.value, c8.value, a4.value, a4b.value, a8.value, b4.value],
    nodes: [c4.node, c8.node, a4.node, a4b.node, a8.node, b4.node, state, load],
  });
  const sourceByKind = {
    a4: 'value.phi.a4',
    a4b: 'value.phi.a4b',
    a8: 'value.phi.a8',
    b4: 'value.phi.b4',
    unknown: null,
  };
  const definitions = incomingKinds.map((kind, index) => {
    const valueId = `ssa.in.${index}`;
    if (kind === 'unknown') {
      return { definitionId: `def.in.${index}`, valueId, kind: 'unknown', blockId: 'pred', variableKey: 'state.merge', sourceEntityId: null, incoming: [], origin: origin(`ssa.unknown.${index}`), proof: { variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' } } };
    }
    return { definitionId: `def.in.${index}`, valueId, kind: 'definition', blockId: 'pred', variableKey: 'state.merge', sourceEntityId: `source.${index}`, incoming: [], origin: origin(`ssa.in.${index}`), proof: { variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' }, sourceSemanticValueId: sourceByKind[kind] } };
  });
  const phi = {
    definitionId: 'def.phi',
    valueId: 'ssa.phi',
    kind: 'phi',
    blockId: 'block.entry',
    variableKey: 'state.merge',
    sourceEntityId: null,
    incoming: definitions.map((definition, index) => ({ predecessorBlockId: `pred.${index}`, valueId: definition.valueId })),
    origin: origin('ssa.phi'),
    proof: { variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' } },
  };
  const ssa = {
    functionId,
    definitions: [...definitions, phi],
    uses: [{
      useId: 'use.merge',
      valueId: 'ssa.phi',
      blockId: 'block.entry',
      sourceEntityId: state.id,
      origin: origin('ssa.use.merge'),
      proof: { kind: 'renamed-use', variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' } },
    }],
  };
  return { ir, load, ssa };
}

// Same-root, same-offset PHI keeps exact identity.
{
  const { ir, load, ssa } = phiFixture({ incomingKinds: ['a4', 'a4b'] });
  const region = classify(ir, load.id, { ssa });
  assert.equal(region.kind, 'rooted-offset');
}

// Same-root differing-offset PHI keeps only root knowledge and cannot mint an exact region.
{
  const { ir, load, ssa } = phiFixture({ incomingKinds: ['a4', 'a8'] });
  const region = classify(ir, load.id, { ssa });
  assert.equal(region.kind, 'unknown');
  assert.equal(region.metadata.canonicalAddressKind, 'root-only');
}

// Different-root and unknown incoming PHIs remain conservative.
{
  const differing = phiFixture({ incomingKinds: ['a4', 'b4'] });
  assert.equal(classify(differing.ir, differing.load.id, { ssa: differing.ssa }).kind, 'unknown');
  const unknownIncoming = phiFixture({ incomingKinds: ['a4', 'unknown'] });
  assert.equal(classify(unknownIncoming.ir, unknownIncoming.load.id, { ssa: unknownIncoming.ssa }).kind, 'unknown');
}

// An exact constant used as the validated memory address is a deterministic absolute/global address.
{
  const base = constant('node.global.base', 'value.global.base', 4096);
  const disp = constant('node.global.disp', 'value.global.disp', 32);
  const address = op('node.global.addr', 'value.global.addr', 'address', 'add', ['value.global.base', 'value.global.disp']);
  const load = memoryNode('node.global.load', 'load', 'value.global.addr');
  const ir = rawIr({ values: [base.value, disp.value, address.value], nodes: [base.node, disp.node, address.node, load] });
  const region = classify(ir, load.id);
  assert.equal(region.kind, 'global-absolute');
  assert.equal(region.address, '0x1020');
}

// Stack classification is accepted only from generic root metadata/provider, never from a state spelling heuristic.
{
  const read = stateRead('node.stack.read', 'value.stack.root', 'state.stack');
  const c16 = constant('node.stack.const', 'value.stack.const', 16);
  const address = op('node.stack.addr', 'value.stack.addr', 'address', 'add', ['value.stack.root', 'value.stack.const']);
  const load = memoryNode('node.stack.load', 'load', 'value.stack.addr', 64);
  const ir = rawIr({ values: [semanticValue('value.stack.root', read.id, bit64), c16.value, address.value], nodes: [read, c16.node, address.node, load] });
  const withoutProvider = classify(ir, load.id);
  assert.equal(withoutProvider.kind, 'rooted-offset');
  const withProvider = classify(ir, load.id, {
    rootDescriptorProvider(request) {
      return request.variable?.key === 'state.stack'
        ? { kind: 'stack-like', baseOffset: 0, linearOffsets: true }
        : null;
    },
  });
  assert.equal(withProvider.kind, 'stack-fixed');
  assert.equal(withProvider.offset, '16');
}

// Generic stack and rooted-object descriptors remain different identities without inventing NoAlias.
{
  const stackIr = basicRootIr('state.stack');
  const objectIr = basicRootIr('root.object');
  const stack = classify(stackIr, 'node.load.root', {
    rootDescriptors: { 'state.stack': { kind: 'stack-like', baseOffset: 0 } },
  });
  const rooted = classify(objectIr, 'node.load.root', {
    rootDescriptors: { 'root.object': { kind: 'rooted-object', rootEntityId: 'object.a', linearOffsets: true } },
  });
  assert.equal(stack.kind, 'stack-fixed');
  assert.equal(rooted.kind, 'rooted-offset');
  assert.notEqual(stack.id, rooted.id);
  assert.notEqual(aliasMemoryRegions(stack, rooted), 'no');
}

// Overlapping ranges on one proven linear root are MayAlias, not NoAlias.
{
  const root = semanticValue('value.overlap.root', null, bit64, { variableKey: 'root.overlap' });
  const c0 = constant('node.overlap.c0', 'value.overlap.c0', 0);
  const c4 = constant('node.overlap.c4', 'value.overlap.c4', 4);
  const a0 = op('node.overlap.a0', 'value.overlap.a0', 'address', 'add', ['value.overlap.root', 'value.overlap.c0']);
  const a4 = op('node.overlap.a4', 'value.overlap.a4', 'address', 'add', ['value.overlap.root', 'value.overlap.c4']);
  const l0 = memoryNode('node.overlap.l0', 'load', 'value.overlap.a0', 64);
  const l4 = memoryNode('node.overlap.l4', 'load', 'value.overlap.a4', 64);
  const ir = rawIr({ values: [root, c0.value, c4.value, a0.value, a4.value], nodes: [c0.node, c4.node, a0.node, a4.node, l0, l4] });
  const options = { rootDescriptors: { 'root.overlap': { kind: 'rooted-object', rootEntityId: 'object.overlap', linearOffsets: true } } };
  const r0 = classify(ir, l0.id, options);
  const r4 = classify(ir, l4.id, options);
  assert.equal(r0.offset, '0');
  assert.equal(r4.offset, '4');
  assert.equal(aliasMemoryRegions(r0, r4), 'may');
}

// Different pointer arguments are not disjoint merely because their root identities differ.
{
  const a = basicRootIr('root.a');
  const b = basicRootIr('root.b');
  const ra = classify(a, 'node.load.root');
  const rb = classify(b, 'node.load.root');
  assert.notEqual(ra.id, rb.id);
  assert.equal(aliasMemoryRegions(ra, rb), 'may');
}

// Indexed/nonconstant addressing remains unknown.
{
  const readA = stateRead('node.index.read.a', 'value.index.a', 'root.a');
  const readB = stateRead('node.index.read.b', 'value.index.b', 'root.b');
  const indexed = op('node.index.addr', 'value.index.addr', 'address', 'add', ['value.index.a', 'value.index.b']);
  const load = memoryNode('node.index.load', 'load', 'value.index.addr');
  const ir = rawIr({
    values: [semanticValue('value.index.a', readA.id, bit64), semanticValue('value.index.b', readB.id, bit64), indexed.value],
    nodes: [readA, readB, indexed.node, load],
  });
  assert.equal(classify(ir, load.id).kind, 'unknown');
}

// Unknown stores and calls remain barriers.
{
  const known = classify(basicRootIr('root.barrier'), 'node.load.root');
  const unknown = deriveMemoryRegion({
    functionId,
    binaryId,
    memory: { addressSpace: 'memory', addressExpr: { valueId: 'value.unknown' }, widthBits: 32 },
    origin: origin('unknown.region'),
    sourceEntityId: 'node.unknown.region',
  });
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknownStoreAliasRelation(unknown, known), 'may');
  assert.equal(effectSummaryAliasRelation({ scope: 'unknown' }, known, () => unknown), 'may');
}

// A later unknown store must not retroactively clobber an earlier load.
{
  const knownRegion = createMemoryRegionRef({
    id: 'region.temporal.known',
    kind: 'rooted-offset',
    functionId,
    rootEntityId: 'root.temporal',
    offset: 0,
    widthBits: 32,
  });
  const unknownRegion = createMemoryRegionRef({
    id: 'region.temporal.unknown',
    kind: 'unknown',
    functionId,
    uncertaintyIdentity: { source: 'later-indexed-store' },
    widthBits: 32,
  });
  const memory = (addressValueId) => ({ addressSpace: 'memory', addressValueId, widthBits: 32, endian: 'little', volatility: false, atomic: false, ordering: 'unknown' });
  const nodes = [
    { id: 'node.temporal.store', kind: 'store', blockId: 'entry', inputs: [], outputs: [], memory: memory('addr.known'), origin: origin('temporal.store') },
    { id: 'node.temporal.load', kind: 'load', blockId: 'entry', inputs: [], outputs: [], memory: memory('addr.known'), origin: origin('temporal.load') },
    { id: 'node.temporal.unknown', kind: 'store', blockId: 'entry', inputs: [], outputs: [], memory: memory('addr.unknown'), origin: origin('temporal.unknown') },
  ];
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('temporal.block') }],
    values: [
      { id: 'addr.known', kind: 'entry', machineType: addr64, origin: origin('addr.known') },
      { id: 'addr.unknown', kind: 'entry', machineType: addr64, origin: origin('addr.unknown') },
    ],
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('temporal.function'),
  });
  const cfg = createSemanticCfg({ functionId, entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  const memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion(access) {
      return access.addressExpr.valueId === 'addr.known' ? knownRegion : unknownRegion;
    },
    queryAlias(left, right) {
      return aliasMemoryRegions(left, right);
    },
  });
  const use = memorySsa.uses.find((item) => item.sourceEntityId === 'node.temporal.load' && item.regionId === knownRegion.id);
  assert.ok(use);
  const reaching = reachingMemoryDefinition(memorySsa, use);
  assert.equal(reaching.sourceEntityId, 'node.temporal.store');
  assert.equal(reaching.kind, 'memory-def');
}

// MemoryRegionId and canonical proofs must be deterministic across collection/object insertion order.
{
  const irA = basicRootIr('root.deterministic');
  const irB = {
    ...irA,
    values: irA.values.slice().reverse(),
    nodes: irA.nodes.slice().reverse(),
  };
  const descriptorsA = {
    'root.deterministic': {
      kind: 'rooted-object',
      rootEntityId: 'object.deterministic',
      rootIdentity: { alpha: 1, beta: 2 },
      linearOffsets: true,
    },
  };
  const descriptorsB = new Map([[
    'root.deterministic',
    {
      linearOffsets: true,
      rootIdentity: { beta: 2, alpha: 1 },
      rootEntityId: 'object.deterministic',
      kind: 'rooted-object',
    },
  ]]);
  const first = classify(irA, 'node.load.root', { rootDescriptors: descriptorsA });
  const second = classify(irB, 'node.load.root', { rootDescriptors: descriptorsB });
  assert.equal(first.id, second.id);
  assert.equal(stableStringify(first), stableStringify(second));
}

console.log('semantic-v2 region provenance repair: PASS');
