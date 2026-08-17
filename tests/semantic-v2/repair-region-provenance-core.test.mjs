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
const bit64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function value(id, definitionNodeId = null, machineType = bit64, extra = {}) {
  return {
    id,
    kind: definitionNodeId == null ? 'entry' : 'definition',
    machineType,
    definitionNodeId,
    sourceEntityId: null,
    variableKey: null,
    origin: origin(id),
    ...extra,
  };
}

function node(id, kind, extra = {}) {
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

function stateRead(id, outputId, key, extraVariable = {}) {
  return node(id, 'state-read', {
    outputs: [outputId],
    variable: { key, kind: 'logical-state', scope: 'function', ...extraVariable },
  });
}

function constant(id, outputId, integer, machineType = bit64) {
  const encoded = { kind: 'bitvector', widthBits: machineType.widthBits, value: String(integer) };
  return {
    node: node(id, 'const', { outputs: [outputId], attributes: { constant: encoded } }),
    value: value(outputId, id, machineType, { metadata: { constant: encoded } }),
  };
}

function operation(id, outputId, kind, operator, inputs, machineType = addr64) {
  return {
    node: node(id, kind, { operator, inputs, outputs: [outputId] }),
    value: value(outputId, id, machineType),
  };
}

function memoryNode(id, kind, addressValueId, widthBits = 32) {
  return node(id, kind, {
    inputs: [addressValueId],
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

function ir({ values, nodes, nodeIds = nodes.map((item) => item.id) }) {
  return {
    functionId,
    origin: origin('function'),
    blocks: [{ id: 'block.entry', nodeIds, origin: origin('block.entry') }],
    values,
    nodes,
  };
}

function classify(functionIr, nodeId, options = {}) {
  return classifySemanticMemoryRegion(functionIr, nodeId, { binaryId, ...options });
}

function rootLoad(key = 'root.a') {
  const read = stateRead('node.read.root', 'value.root', key);
  const load = memoryNode('node.load.root', 'load', 'value.root');
  return ir({ values: [value('value.root', read.id)], nodes: [read, load] });
}

// copy(root) retains the exact canonical root.
{
  const read = stateRead('node.copy.read', 'value.copy.root', 'root.a');
  const copy = operation('node.copy', 'value.copy', 'copy', 'copy', ['value.copy.root'], bit64);
  const directLoad = memoryNode('node.copy.direct', 'load', 'value.copy.root');
  const copiedLoad = memoryNode('node.copy.copied', 'load', 'value.copy');
  const functionIr = ir({ values: [value('value.copy.root', read.id), copy.value], nodes: [read, copy.node, directLoad, copiedLoad] });
  assert.equal(classify(functionIr, directLoad.id).id, classify(functionIr, copiedLoad.id).id);
}

// root + 0 retains identity.
{
  const read = stateRead('node.zero.read', 'value.zero.root', 'root.a');
  const zero = constant('node.zero.const', 'value.zero.const', 0);
  const add = operation('node.zero.add', 'value.zero.addr', 'address', 'add', ['value.zero.root', 'value.zero.const']);
  const directLoad = memoryNode('node.zero.direct', 'load', 'value.zero.root');
  const addLoad = memoryNode('node.zero.load', 'load', 'value.zero.addr');
  const functionIr = ir({ values: [value('value.zero.root', read.id), zero.value, add.value], nodes: [read, zero.node, add.node, directLoad, addLoad] });
  assert.equal(classify(functionIr, directLoad.id).id, classify(functionIr, addLoad.id).id);
}

// Constant and nested displacements canonicalize to one address proof.
{
  const read = stateRead('node.offset.read', 'value.offset.root', 'root.a');
  const c4 = constant('node.offset.c4', 'value.offset.c4', 4);
  const c8 = constant('node.offset.c8', 'value.offset.c8', 8);
  const c12 = constant('node.offset.c12', 'value.offset.c12', 12);
  const add4 = operation('node.offset.add4', 'value.offset.add4', 'address', 'add', ['value.offset.root', 'value.offset.c4']);
  const nested = operation('node.offset.nested', 'value.offset.nested', 'address', 'add', ['value.offset.add4', 'value.offset.c8']);
  const flat = operation('node.offset.flat', 'value.offset.flat', 'address', 'add', ['value.offset.root', 'value.offset.c12']);
  const nestedLoad = memoryNode('node.offset.nested.load', 'load', 'value.offset.nested');
  const flatLoad = memoryNode('node.offset.flat.load', 'load', 'value.offset.flat');
  const functionIr = ir({
    values: [value('value.offset.root', read.id), c4.value, c8.value, c12.value, add4.value, nested.value, flat.value],
    nodes: [read, c4.node, c8.node, c12.node, add4.node, nested.node, flat.node, nestedLoad, flatLoad],
  });
  const nestedProof = deriveCanonicalAddressProof(functionIr, 'value.offset.nested');
  const flatProof = deriveCanonicalAddressProof(functionIr, 'value.offset.flat');
  assert.equal(nestedProof.offset, 12n);
  assert.equal(flatProof.offset, 12n);
  assert.equal(sameCanonicalAddressProof(nestedProof, flatProof), true);
  assert.equal(classify(functionIr, nestedLoad.id).id, classify(functionIr, flatLoad.id).id);
}

function phiFixture(incomingKinds) {
  const read = stateRead('node.phi.read', 'value.phi.read', 'state.merge');
  const load = memoryNode('node.phi.load', 'load', 'value.phi.read');
  const c4 = constant('node.phi.c4', 'value.phi.c4', 4);
  const c8 = constant('node.phi.c8', 'value.phi.c8', 8);
  const a4 = operation('node.phi.a4', 'value.phi.a4', 'address', 'add', ['value.phi.root.a', 'value.phi.c4']);
  const a4b = operation('node.phi.a4b', 'value.phi.a4b', 'address', 'add', ['value.phi.root.a', 'value.phi.c4']);
  const a8 = operation('node.phi.a8', 'value.phi.a8', 'address', 'add', ['value.phi.root.a', 'value.phi.c8']);
  const b4 = operation('node.phi.b4', 'value.phi.b4', 'address', 'add', ['value.phi.root.b', 'value.phi.c4']);
  const functionIr = ir({
    values: [
      value('value.phi.root.a', null, bit64, { variableKey: 'root.a' }),
      value('value.phi.root.b', null, bit64, { variableKey: 'root.b' }),
      value('value.phi.read', read.id),
      c4.value, c8.value, a4.value, a4b.value, a8.value, b4.value,
    ],
    nodes: [c4.node, c8.node, a4.node, a4b.node, a8.node, b4.node, read, load],
  });
  const sourceByKind = { a4: 'value.phi.a4', a4b: 'value.phi.a4b', a8: 'value.phi.a8', b4: 'value.phi.b4' };
  const incoming = incomingKinds.map((kind, index) => ({
    definitionId: `def.in.${index}`,
    valueId: `ssa.in.${index}`,
    kind: kind === 'unknown' ? 'unknown' : 'definition',
    blockId: `pred.${index}`,
    variableKey: 'state.merge',
    sourceEntityId: null,
    incoming: [],
    origin: origin(`ssa.in.${index}`),
    proof: {
      variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' },
      ...(kind === 'unknown' ? {} : { sourceSemanticValueId: sourceByKind[kind] }),
    },
  }));
  const phi = {
    definitionId: 'def.phi',
    valueId: 'ssa.phi',
    kind: 'phi',
    blockId: 'block.entry',
    variableKey: 'state.merge',
    sourceEntityId: null,
    incoming: incoming.map((definition, index) => ({ predecessorBlockId: `pred.${index}`, valueId: definition.valueId })),
    origin: origin('ssa.phi'),
    proof: { variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' } },
  };
  const ssa = {
    functionId,
    definitions: [...incoming, phi],
    uses: [{
      useId: 'use.phi',
      valueId: phi.valueId,
      blockId: 'block.entry',
      sourceEntityId: read.id,
      origin: origin('ssa.use.phi'),
      proof: { kind: 'renamed-use', variableIdentity: { key: 'state.merge', kind: 'logical-state', scope: 'function' } },
    }],
  };
  return { functionIr, load, ssa };
}

// Same-root/same-offset PHI is exact; differing offsets retain root-only proof.
{
  const exact = phiFixture(['a4', 'a4b']);
  assert.equal(classify(exact.functionIr, exact.load.id, { ssa: exact.ssa }).kind, 'rooted-offset');
  const differingOffset = phiFixture(['a4', 'a8']);
  const region = classify(differingOffset.functionIr, differingOffset.load.id, { ssa: differingOffset.ssa });
  assert.equal(region.kind, 'unknown');
  assert.equal(region.metadata.canonicalAddressKind, 'root-only');
}

// Different roots or an unknown PHI input stay unknown/may.
{
  const roots = phiFixture(['a4', 'b4']);
  assert.equal(classify(roots.functionIr, roots.load.id, { ssa: roots.ssa }).kind, 'unknown');
  const unknownIncoming = phiFixture(['a4', 'unknown']);
  assert.equal(classify(unknownIncoming.functionIr, unknownIncoming.load.id, { ssa: unknownIncoming.ssa }).kind, 'unknown');
}

// A validated constant address expression creates deterministic global identity.
{
  const base = constant('node.global.base', 'value.global.base', 4096);
  const displacement = constant('node.global.disp', 'value.global.disp', 32);
  const address = operation('node.global.addr', 'value.global.addr', 'address', 'add', ['value.global.base', 'value.global.disp']);
  const load = memoryNode('node.global.load', 'load', 'value.global.addr');
  const functionIr = ir({ values: [base.value, displacement.value, address.value], nodes: [base.node, displacement.node, address.node, load] });
  const region = classify(functionIr, load.id);
  assert.equal(region.kind, 'global-absolute');
  assert.equal(region.address, '0x1020');
}

// Stack classification requires architecture-neutral supplied metadata/provider.
{
  const read = stateRead('node.stack.read', 'value.stack.root', 'state.stack');
  const c16 = constant('node.stack.c16', 'value.stack.c16', 16);
  const address = operation('node.stack.addr', 'value.stack.addr', 'address', 'add', ['value.stack.root', 'value.stack.c16']);
  const load = memoryNode('node.stack.load', 'load', 'value.stack.addr', 64);
  const functionIr = ir({ values: [value('value.stack.root', read.id), c16.value, address.value], nodes: [read, c16.node, address.node, load] });
  assert.equal(classify(functionIr, load.id).kind, 'rooted-offset');
  const stack = classify(functionIr, load.id, {
    rootDescriptorProvider(request) {
      return request.variable?.key === 'state.stack' ? { kind: 'stack-like', baseOffset: 0, linearOffsets: true } : null;
    },
  });
  assert.equal(stack.kind, 'stack-fixed');
  assert.equal(stack.offset, '16');
}

// Stack/rooted-object identities differ, but identity difference alone is not NoAlias.
{
  const stack = classify(rootLoad('state.stack'), 'node.load.root', {
    rootDescriptors: { 'state.stack': { kind: 'stack-like', baseOffset: 0 } },
  });
  const rooted = classify(rootLoad('root.object'), 'node.load.root', {
    rootDescriptors: { 'root.object': { kind: 'rooted-object', rootEntityId: 'object.a', linearOffsets: true } },
  });
  assert.equal(stack.kind, 'stack-fixed');
  assert.equal(rooted.kind, 'rooted-offset');
  assert.notEqual(stack.id, rooted.id);
  assert.notEqual(aliasMemoryRegions(stack, rooted), 'no');
}

// Proven linear rooted ranges preserve overlap width.
{
  const c0 = constant('node.overlap.c0', 'value.overlap.c0', 0);
  const c4 = constant('node.overlap.c4', 'value.overlap.c4', 4);
  const a0 = operation('node.overlap.a0', 'value.overlap.a0', 'address', 'add', ['value.overlap.root', 'value.overlap.c0']);
  const a4 = operation('node.overlap.a4', 'value.overlap.a4', 'address', 'add', ['value.overlap.root', 'value.overlap.c4']);
  const l0 = memoryNode('node.overlap.l0', 'load', 'value.overlap.a0', 64);
  const l4 = memoryNode('node.overlap.l4', 'load', 'value.overlap.a4', 64);
  const functionIr = ir({
    values: [value('value.overlap.root', null, bit64, { variableKey: 'root.overlap' }), c0.value, c4.value, a0.value, a4.value],
    nodes: [c0.node, c4.node, a0.node, a4.node, l0, l4],
  });
  const options = { rootDescriptors: { 'root.overlap': { kind: 'rooted-object', rootEntityId: 'object.overlap', linearOffsets: true } } };
  const r0 = classify(functionIr, l0.id, options);
  const r4 = classify(functionIr, l4.id, options);
  assert.equal(r0.offset, '0');
  assert.equal(r4.offset, '4');
  assert.equal(aliasMemoryRegions(r0, r4), 'may');
}

// Different pointer arguments remain conservative.
{
  const a = classify(rootLoad('root.a'), 'node.load.root');
  const b = classify(rootLoad('root.b'), 'node.load.root');
  assert.notEqual(a.id, b.id);
  assert.equal(aliasMemoryRegions(a, b), 'may');
}

// Nonconstant/indexed address is not promoted to a precise region.
{
  const readA = stateRead('node.index.a', 'value.index.a', 'root.a');
  const readB = stateRead('node.index.b', 'value.index.b', 'root.b');
  const address = operation('node.index.addr', 'value.index.addr', 'address', 'add', ['value.index.a', 'value.index.b']);
  const load = memoryNode('node.index.load', 'load', 'value.index.addr');
  const functionIr = ir({ values: [value('value.index.a', readA.id), value('value.index.b', readB.id), address.value], nodes: [readA, readB, address.node, load] });
  assert.equal(classify(functionIr, load.id).kind, 'unknown');
}

// Unknown store and unknown call summaries remain barriers.
{
  const known = classify(rootLoad('root.barrier'), 'node.load.root');
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

// A later unknown store does not travel backward and replace the reaching def of an earlier load.
{
  const knownRegion = createMemoryRegionRef({
    id: 'region.temporal.known',
    kind: 'rooted-offset',
    functionId,
    rootEntityId: 'root.temporal',
    offset: 0,
    widthBits: 32,
    origin: origin('region.temporal.known'),
  });
  const unknownRegion = createMemoryRegionRef({
    id: 'region.temporal.unknown',
    kind: 'unknown',
    functionId,
    uncertaintyIdentity: { source: 'later-indexed-store' },
    widthBits: 32,
    origin: origin('region.temporal.unknown'),
  });
  const memory = (addressValueId) => ({ addressSpace: 'memory', addressValueId, widthBits: 32, endian: 'little', volatility: false, atomic: false, ordering: 'unknown' });
  const nodes = [
    { id: 'node.temporal.store', kind: 'store', blockId: 'entry', inputs: [], outputs: [], memory: memory('addr.known'), origin: origin('node.temporal.store') },
    { id: 'node.temporal.load', kind: 'load', blockId: 'entry', inputs: [], outputs: [], memory: memory('addr.known'), origin: origin('node.temporal.load') },
    { id: 'node.temporal.unknown', kind: 'store', blockId: 'entry', inputs: [], outputs: [], memory: memory('addr.unknown'), origin: origin('node.temporal.unknown') },
  ];
  const functionIr = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((item) => item.id), origin: origin('temporal.block') }],
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
  const memorySsa = buildMemorySsa(functionIr, cfg, {
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
  assert.equal(reaching.kind, 'memory-def');
  assert.equal(reaching.sourceEntityId, 'node.temporal.store');
}

// Region IDs and descriptors are insertion-order deterministic.
{
  const firstIr = rootLoad('root.deterministic');
  const secondIr = { ...firstIr, values: firstIr.values.slice().reverse(), nodes: firstIr.nodes.slice().reverse() };
  const objectDescriptorA = {
    'root.deterministic': { kind: 'rooted-object', rootEntityId: 'object.deterministic', rootIdentity: { alpha: 1, beta: 2 }, linearOffsets: true },
  };
  const objectDescriptorB = new Map([[
    'root.deterministic',
    { linearOffsets: true, rootIdentity: { beta: 2, alpha: 1 }, rootEntityId: 'object.deterministic', kind: 'rooted-object' },
  ]]);
  const first = classify(firstIr, 'node.load.root', { rootDescriptors: objectDescriptorA });
  const second = classify(secondIr, 'node.load.root', { rootDescriptors: objectDescriptorB });
  assert.equal(first.id, second.id);
  assert.equal(stableStringify(first), stableStringify(second));
}

console.log('semantic-v2 region provenance repair: PASS');
