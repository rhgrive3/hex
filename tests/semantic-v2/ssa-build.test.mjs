import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import {
  createSsaQueryIndex,
  getDefinitionForUse,
  getDefinitionsForVariable,
  getPhiDefinitions,
  getSsaDefinitionForSemanticValue,
  getSsaUsesForSourceEntity,
  getUsesForDefinition,
} from '../../js/semantics/ssa/queries.js';
import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';

const bit32 = Object.freeze({ kind: 'bitvector', widthBits: 32 });
const bit64 = Object.freeze({ kind: 'bitvector', widthBits: 64 });
const address64 = Object.freeze({ kind: 'address', widthBits: 64, addressSpace: 'memory' });
const vec4x32 = Object.freeze({ kind: 'vector', laneCount: 4, elementType: bit32 });
const variable = (key) => ({ key, kind: 'logical-state', scope: 'function' });
const origin = (id) => ({ operationIds: [id] });

function entryValue(id, machineType, variableKey = null, kind = 'entry') {
  return { id, kind, machineType, sourceEntityId: `source:${id}`, variableKey, origin: origin(`value:${id}`) };
}
function definitionValue(id, definitionNodeId, machineType, variableKey = null) {
  return { id, kind: 'definition', machineType, definitionNodeId, sourceEntityId: `source:${id}`, variableKey, origin: origin(`value:${id}`) };
}
function stateRead(id, blockId, key, outputId) {
  return { id, kind: 'state-read', blockId, inputs: [], outputs: [outputId], variable: variable(key), origin: origin(`node:${id}`) };
}
function stateWrite(id, blockId, key, inputId) {
  return { id, kind: 'state-write', blockId, inputs: [inputId], outputs: [], variable: variable(key), origin: origin(`node:${id}`) };
}
function ret(id, blockId, inputIds = []) {
  return { id, kind: 'return', blockId, inputs: inputIds, outputs: [], origin: origin(`node:${id}`) };
}
function load(id, blockId, addressId, outputId, widthBits = 32) {
  return {
    id, kind: 'load', blockId, inputs: [addressId], outputs: [outputId],
    memory: { addressSpace: 'memory', addressExpr: { valueId: addressId }, widthBits, endian: 'little', atomic: false, volatility: false },
    origin: origin(`node:${id}`),
  };
}
function store(id, blockId, addressId, valueId, widthBits = 32) {
  return {
    id, kind: 'store', blockId, inputs: [addressId, valueId], outputs: [],
    memory: { addressSpace: 'memory', addressExpr: { valueId: addressId }, widthBits, endian: 'little', atomic: false, volatility: false },
    origin: origin(`node:${id}`),
  };
}
function unknownStateWrite(id, blockId) {
  return {
    id, kind: 'unknown-state-write', blockId, inputs: [], outputs: [],
    unknown: { reason: 'state effect unavailable', categories: ['state'] }, completeness: 'unknown', origin: origin(`node:${id}`),
  };
}
function semanticFunction({ functionId = 'function_opaque', entryBlockId = 'entry', blocks, nodes, values, completeness = 'complete', unknowns = [] }) {
  const nodeIdsByBlock = new Map(blocks.map((id) => [id, []]));
  for (const node of nodes) nodeIdsByBlock.get(node.blockId).push(node.id);
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId,
    blocks: blocks.map((id) => ({ id, nodeIds: nodeIdsByBlock.get(id), origin: origin(`block:${id}`) })),
    values,
    nodes,
    completeness,
    unknowns,
    origin: origin(`function:${functionId}`),
  };
}
function semanticCfg({ functionId = 'function_opaque', entryBlockId = 'entry', blocks, edges }) {
  const successors = new Map(blocks.map((id) => [id, []]));
  for (const [from, to, kind = 'branch'] of edges) successors.get(from).push({ to, kind });
  return {
    functionId,
    entryBlockId,
    blocks: blocks.map((id) => ({ id, successors: successors.get(id) })),
  };
}
function renamedUse(ssa, sourceEntityId) {
  return getSsaUsesForSourceEntity(ssa, sourceEntityId).find((use) => use.proof?.kind === 'renamed-use') ?? null;
}
function definitionAt(ssa, variableKey, blockId, kind = null) {
  return getDefinitionsForVariable(ssa, variableKey).find((definition) => definition.blockId === blockId && (kind == null || definition.kind === kind)) ?? null;
}

// Linear definitions/uses, repeated writes, multiple opaque variables, use-def and def-use.
{
  const blocks = ['entry'];
  const values = [
    entryValue('src_a1', bit32), entryValue('src_a2', bit32), entryValue('src_b', bit64),
    definitionValue('read_a1_value', 'read_a1', bit32), definitionValue('read_a2_value', 'read_a2', bit32), definitionValue('read_b_value', 'read_b', bit64),
  ];
  const nodes = [
    stateWrite('write_a1', 'entry', 'state.a', 'src_a1'), stateRead('read_a1', 'entry', 'state.a', 'read_a1_value'),
    stateWrite('write_b', 'entry', 'state.b', 'src_b'), stateRead('read_b', 'entry', 'state.b', 'read_b_value'),
    stateWrite('write_a2', 'entry', 'state.a', 'src_a2'), stateRead('read_a2', 'entry', 'state.a', 'read_a2_value'),
    ret('return', 'entry', ['read_a2_value', 'read_b_value']),
  ];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [] });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);

  const useA1 = renamedUse(ssa, 'read_a1');
  const useA2 = renamedUse(ssa, 'read_a2');
  const useB = renamedUse(ssa, 'read_b');
  assert.equal(getDefinitionForUse(ssa, useA1).sourceEntityId, 'write_a1');
  assert.equal(getDefinitionForUse(ssa, useA2).sourceEntityId, 'write_a2');
  assert.equal(getDefinitionForUse(ssa, useB).sourceEntityId, 'write_b');
  assert.equal(getDefinitionForUse(ssa, useA2).variableKey, 'state.a');
  assert.equal(getDefinitionForUse(ssa, useB).variableKey, 'state.b');
  assert.ok(getUsesForDefinition(ssa, getDefinitionForUse(ssa, useA2)).some((use) => use.useId === useA2.useId));
  const query = createSsaQueryIndex(ssa);
  assert.equal(query.definitionForUse(useA1.useId).sourceEntityId, 'write_a1');
  assert.equal(query.usesForValue(useB.valueId).some((use) => use.useId === useB.useId), true);
}

// Diamond merge requires one phi with the exact canonical predecessor set.
let diamond;
{
  const blocks = ['entry', 'left', 'right', 'join'];
  const values = [entryValue('left_source', bit32), entryValue('right_source', bit32), definitionValue('join_read_value', 'join_read', bit32)];
  const nodes = [stateWrite('left_write', 'left', 'state.a', 'left_source'), stateWrite('right_write', 'right', 'state.a', 'right_source'), stateRead('join_read', 'join', 'state.a', 'join_read_value')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'left', 'conditional-true'], ['entry', 'right', 'conditional-false'], ['left', 'join'], ['right', 'join']] });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const phi = getPhiDefinitions(ssa, 'join').find((definition) => definition.variableKey === 'state.a');
  assert.ok(phi);
  assert.deepEqual(phi.incoming.map((item) => item.predecessorBlockId), ['left', 'right']);
  assert.equal(getDefinitionForUse(ssa, renamedUse(ssa, 'join_read')).valueId, phi.valueId);
  diamond = { ir, cfg, ssa, phi };
}

// Loop-carried phi.
{
  const blocks = ['entry', 'header', 'body', 'exit'];
  const values = [entryValue('body_source', bit32), definitionValue('header_read_value', 'header_read', bit32), definitionValue('exit_read_value', 'exit_read', bit32)];
  const nodes = [stateRead('header_read', 'header', 'state.a', 'header_read_value'), stateWrite('body_write', 'body', 'state.a', 'body_source'), stateRead('exit_read', 'exit', 'state.a', 'exit_read_value')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'header'], ['header', 'body', 'conditional-true'], ['header', 'exit', 'conditional-false'], ['body', 'header']] });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const phi = definitionAt(ssa, 'state.a', 'header', 'phi');
  assert.ok(phi);
  assert.deepEqual(phi.incoming.map((item) => item.predecessorBlockId), ['body', 'entry']);
  assert.equal(getDefinitionForUse(ssa, renamedUse(ssa, 'header_read')).valueId, phi.valueId);
}

// Nested loops remain bounded and dominance-correct.
{
  const blocks = ['entry', 'outer_header', 'inner_header', 'inner_body', 'outer_latch', 'exit'];
  const values = [entryValue('inner_source', bit32), entryValue('outer_source', bit32), definitionValue('inner_read_value', 'inner_read', bit32), definitionValue('outer_read_value', 'outer_read', bit32)];
  const nodes = [
    stateRead('outer_read', 'outer_header', 'state.a', 'outer_read_value'),
    stateRead('inner_read', 'inner_header', 'state.a', 'inner_read_value'),
    stateWrite('inner_write', 'inner_body', 'state.a', 'inner_source'),
    stateWrite('outer_write', 'outer_latch', 'state.a', 'outer_source'),
  ];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [
    ['entry', 'outer_header'], ['outer_header', 'inner_header', 'conditional-true'], ['outer_header', 'exit', 'conditional-false'],
    ['inner_header', 'inner_body', 'conditional-true'], ['inner_header', 'outer_latch', 'conditional-false'], ['inner_body', 'inner_header'], ['outer_latch', 'outer_header'],
  ] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
  assert.ok(definitionAt(ssa, 'state.a', 'inner_header', 'phi'));
  assert.ok(definitionAt(ssa, 'state.a', 'outer_header', 'phi'));
}

// Irreducible control flow does not require architecture-specific rules.
{
  const blocks = ['entry', 'a', 'b', 'c', 'exit'];
  const values = [entryValue('a_source', bit32), entryValue('b_source', bit32), definitionValue('c_read_value', 'c_read', bit32)];
  const nodes = [stateWrite('a_write', 'a', 'state.a', 'a_source'), stateWrite('b_write', 'b', 'state.a', 'b_source'), stateRead('c_read', 'c', 'state.a', 'c_read_value')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [
    ['entry', 'a', 'conditional-true'], ['entry', 'b', 'conditional-false'], ['a', 'c'], ['b', 'c'],
    ['c', 'a', 'conditional-true'], ['c', 'b', 'conditional-false'], ['c', 'exit'],
  ] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
  for (const phi of getPhiDefinitions(ssa)) {
    const cfgBlock = createSemanticCfg(cfg).blocks.find((block) => block.id === phi.blockId);
    assert.deepEqual(phi.incoming.map((item) => item.predecessorBlockId), cfgBlock.predecessors);
  }
}

// Unreachable code starts from explicit local undef rather than borrowing a reachable value.
{
  const blocks = ['entry', 'exit', 'dead'];
  const values = [definitionValue('dead_read_value', 'dead_read', bit32)];
  const nodes = [stateRead('dead_read', 'dead', 'state.a', 'dead_read_value')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'exit']] });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = getDefinitionForUse(ssa, renamedUse(ssa, 'dead_read'));
  assert.equal(reaching.kind, 'undef');
  assert.equal(reaching.blockId, 'dead');
}

// Explicit entry undef is preserved; undefined is never rewritten to zero.
{
  const blocks = ['entry'];
  const values = [entryValue('state_a_undef', bit32, 'state.a', 'undef'), definitionValue('read_value', 'read_a', bit32)];
  const nodes = [stateRead('read_a', 'entry', 'state.a', 'read_value')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [] });
  const ssa = buildSemanticSsa(ir, cfg);
  const reaching = getDefinitionForUse(ssa, renamedUse(ssa, 'read_a'));
  assert.equal(reaching.kind, 'undef');
  assert.equal(reaching.proof.sourceSemanticValueId, 'state_a_undef');
  assert.doesNotMatch(stableStringify(reaching), /\bzero\b/i);
}

// Unknown state writes remain explicit unknown definitions.
{
  const blocks = ['entry'];
  const values = [entryValue('seed_a', bit32, 'state.a'), definitionValue('read_value', 'read_after_unknown', bit32)];
  const nodes = [unknownStateWrite('unknown_write', 'entry'), stateRead('read_after_unknown', 'entry', 'state.a', 'read_value')];
  const ir = semanticFunction({ blocks, nodes, values, completeness: 'partial', unknowns: [{ reason: 'state effect unavailable', categories: ['state'] }] });
  const cfg = semanticCfg({ blocks, edges: [] });
  const ssa = buildSemanticSsa(ir, cfg);
  const reaching = getDefinitionForUse(ssa, renamedUse(ssa, 'read_after_unknown'));
  assert.equal(reaching.kind, 'unknown');
  assert.equal(reaching.sourceEntityId, 'unknown_write');
}

// Exact machine type survives, and same-looking state identities do not merge across type/width domains.
{
  const blocks = ['entry'];
  const values = [entryValue('src32', bit32), entryValue('src64', bit64), entryValue('srcv', vec4x32)];
  const nodes = [stateWrite('write32', 'entry', 'state.a', 'src32'), stateWrite('write64', 'entry', 'state.a', 'src64'), stateWrite('writev', 'entry', 'state.a', 'srcv')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [] });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const stateDefs = ssa.definitions.filter((definition) => definition.variableKey?.startsWith('state.a'));
  const keys = [...new Set(stateDefs.map((definition) => definition.variableKey))].sort();
  assert.equal(keys.length, 3);
  assert.ok(keys.every((key) => key.startsWith('state.a::')));
  const machineTypes = keys.map((key) => getDefinitionsForVariable(ssa, key)[0].proof.machineType);
  assert.ok(machineTypes.some((type) => type.kind === 'bitvector' && type.widthBits === 32));
  assert.ok(machineTypes.some((type) => type.kind === 'bitvector' && type.widthBits === 64));
  assert.ok(machineTypes.some((type) => type.kind === 'vector' && type.laneCount === 4));
}

// Loads/stores participate only through scalar operands/results; no memory version is created here.
{
  const blocks = ['entry'];
  const values = [entryValue('address', address64), entryValue('store_data', bit32), definitionValue('loaded', 'load_value', bit32)];
  const nodes = [load('load_value', 'entry', 'address', 'loaded'), store('store_value', 'entry', 'address', 'store_data'), ret('return', 'entry', ['loaded'])];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [] });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const loaded = getSsaDefinitionForSemanticValue(ssa, 'loaded');
  assert.equal(loaded.proof.machineType.widthBits, 32);
  const returnUse = getSsaUsesForSourceEntity(ssa, 'return').find((use) => use.proof?.sourceSemanticValueId === 'loaded');
  assert.equal(getDefinitionForUse(ssa, returnUse).valueId, loaded.valueId);
  assert.equal(ssa.definitions.some((definition) => /memory-(?:phi|def)|clobber/i.test(definition.kind)), false);
}

// Multiple exits are ordinary CFG exits for scalar SSA.
{
  const blocks = ['entry', 'left_exit', 'right_exit'];
  const values = [definitionValue('left_value', 'left_read', bit32), definitionValue('right_value', 'right_read', bit32)];
  const nodes = [stateRead('left_read', 'left_exit', 'state.a', 'left_value'), stateRead('right_read', 'right_exit', 'state.a', 'right_value')];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'left_exit', 'conditional-true'], ['entry', 'right_exit', 'conditional-false']] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
}

// IDs/output are deterministic under irrelevant input object/array insertion ordering.
{
  const reorderedIr = {
    ...diamond.ir,
    blocks: diamond.ir.blocks.slice().reverse(),
    values: diamond.ir.values.slice().reverse(),
    nodes: diamond.ir.nodes.slice().reverse(),
  };
  const reorderedCfg = { ...diamond.cfg, blocks: diamond.cfg.blocks.slice().reverse() };
  const again = buildSemanticSsa(reorderedIr, reorderedCfg);
  assert.equal(stableStringify(again), stableStringify(diamond.ssa));
}

// Phi provenance contains the merge point and real contributing write origins plus deterministic transform metadata.
{
  const phi = diamond.phi;
  assert.ok(phi.origin.parentEntityIds.includes('join'));
  assert.ok(phi.origin.operationIds.includes('node:left_write'));
  assert.ok(phi.origin.operationIds.includes('node:right_write'));
  assert.ok(phi.origin.transforms.some((transform) => transform.passId === 'semantic-ssa' && transform.ruleId === 'phi-insertion' && transform.producedEntityIds.includes(phi.valueId)));
}

// Missing/duplicate predecessor inputs and non-dominating inputs fail closed.
{
  const malformed = JSON.parse(JSON.stringify(diamond.ssa));
  const phi = malformed.definitions.find((definition) => definition.valueId === diamond.phi.valueId);
  phi.incoming.pop();
  assert.throws(() => validateSemanticSsa(malformed, diamond.ir, diamond.cfg), /phi-predecessor-set-incomplete/);

  const duplicate = JSON.parse(JSON.stringify(diamond.ssa));
  const duplicatePhi = duplicate.definitions.find((definition) => definition.valueId === diamond.phi.valueId);
  duplicatePhi.incoming[1].predecessorBlockId = duplicatePhi.incoming[0].predecessorBlockId;
  assert.throws(() => validateSemanticSsa(duplicate, diamond.ir, diamond.cfg), /duplicate-phi-predecessor|phi-predecessor-set-incomplete/);
}

// Cancellation and budgets fail boundedly.
{
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => buildSemanticSsa(diamond.ir, diamond.cfg, { signal: controller.signal }), /cancelled/);
  assert.throws(() => validateSemanticSsa(diamond.ssa, diamond.ir, diamond.cfg, { signal: controller.signal }), /cancelled/);
  assert.throws(() => buildSemanticSsa(diamond.ir, diamond.cfg, { budget: { maxWorkItems: 1 } }), /budget-exceeded-maxWorkItems/);
  assert.throws(() => buildSemanticSsa(diamond.ir, diamond.cfg, { budget: { maxDefinitions: 1 } }), /budget-exceeded-maxDefinitions/);
}

// Malformed canonical CFG data is rejected rather than reinterpreted by SSA.
{
  const malformedCfg = {
    functionId: 'function_opaque', entryBlockId: 'entry',
    blocks: [
      { id: 'entry', predecessors: [], successors: [{ to: 'join', kind: 'branch' }] },
      { id: 'join', predecessors: [], successors: [] },
    ],
  };
  const ir = semanticFunction({ blocks: ['entry', 'join'], nodes: [], values: [] });
  assert.throws(() => buildSemanticSsa(ir, malformedCfg), /semantic-cfg-predecessor-mismatch/);
}

// Production SSA files stay architecture-neutral and do not import target/ABI or legacy semantic cores.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../..');
  const targetWords = ['arm' + '64', 'aa' + 'pcs64', 'nz' + 'cv', 'x' + '86', 'risc' + '-v'];
  const targetPattern = new RegExp(`\\b(?:${targetWords.join('|')})\\b`, 'i');
  const forbiddenImport = /targets\/(?:architecture|abi)|ir-core|legacy[^'"\n]*core/i;
  for (const relative of ['js/semantics/ssa/build.js', 'js/semantics/ssa/queries.js', 'js/semantics/ssa/validate.js']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, targetPattern, `${relative} must remain target-neutral`);
    assert.doesNotMatch(source, forbiddenImport, `${relative} must not import target/ABI/legacy cores`);
  }
  assert.ok(diamond.ssa.definitions.some((definition) => definition.variableKey === 'state.a'));
  assert.equal(targetPattern.test(stableStringify(diamond.ssa)), false);
}

console.log('semantic-v2 generic scalar SSA: PASS');
