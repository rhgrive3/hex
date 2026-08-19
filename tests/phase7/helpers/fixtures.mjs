/**
 * Phase 7 synthetic semantic microfixtures (test pyramid level L1).
 *
 * These build real Semantic IR v2 / CFG / SSA / MemorySSA artifacts through the
 * canonical constructors — never hand-rolled look-alike objects. A fixture that
 * bypassed the contracts would prove nothing about the product, and the
 * negative corpus in particular only means something if the unsound case is
 * expressed in exactly the shape the real pipeline produces.
 */

import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

const ADDRESS_TYPE = Object.freeze({ kind: 'address', widthBits: 64, addressSpace: 'memory' });
const SCALAR_TYPE = Object.freeze({ kind: 'bitvector', widthBits: 64 });

/**
 * Edge kinds follow the successor count: one successor is a fallthrough, two
 * are the true/false arms of a conditional, more are switch cases. The CFG
 * contract rejects an unnamed edge kind, and guessing one per fixture would
 * make the fixtures disagree about what the same shape means.
 */
function edgesFor(successors) {
  if (successors.length === 1) return [{ to: successors[0], kind: 'fallthrough' }];
  if (successors.length === 2) {
    return [
      { to: successors[0], kind: 'conditional-true' },
      { to: successors[1], kind: 'conditional-false' },
    ];
  }
  return successors.map((to) => ({ to, kind: 'switch-case' }));
}

export function origin(id) {
  return { instructionIds: [`instruction_${id}`] };
}

/**
 * Tiny builder for one function. Blocks are declared in order; every value and
 * node carries a real origin so evidence links survive into the analyses.
 */
export class FunctionFixture {
  constructor(functionId, { binaryId = 'binary_phase7_fixture' } = {}) {
    this.functionId = functionId;
    this.binaryId = binaryId;
    this.blocks = [];
    this.blockOrder = new Map();
    this.nodes = [];
    this.values = [];
    this.successors = new Map();
  }

  block(id, successors = []) {
    this.blocks.push({ id, nodeIds: [], origin: origin(id) });
    this.blockOrder.set(id, this.blocks.length - 1);
    this.successors.set(id, successors);
    this.current = id;
    return this;
  }

  #push(node) {
    this.nodes.push(node);
    this.blocks[this.blockOrder.get(node.blockId)].nodeIds.push(node.id);
    return node;
  }

  #value(id, definitionNodeId, machineType, metadata) {
    this.values.push({
      id,
      kind: definitionNodeId == null ? 'entry' : 'definition',
      machineType,
      ...(definitionNodeId == null ? {} : { definitionNodeId }),
      origin: origin(id),
      ...(metadata == null ? {} : { metadata }),
    });
    return id;
  }

  /** An incoming value with no defining node (a function entry state value). */
  entryValue(id, { machineType = ADDRESS_TYPE } = {}) {
    return this.#value(id, null, machineType, null);
  }

  constant(id, value, { widthBits = 64, blockId = this.current } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'const', blockId, inputs: [], outputs: [id],
      attributes: { constant: { value: String(value), widthBits } }, origin: origin(nodeId),
    });
    return this.#value(id, nodeId, { kind: 'bitvector', widthBits }, { constant: { value: String(value), widthBits } });
  }

  /** Reads architectural/logical state (a register), producing a pointer value. */
  stateRead(id, variableKey, { blockId = this.current, machineType = ADDRESS_TYPE, kind = 'physical-state', scope = 'function' } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'state-read', blockId, inputs: [], outputs: [id],
      variable: { key: variableKey, kind, scope }, origin: origin(nodeId),
    });
    return this.#value(id, nodeId, machineType, null);
  }

  stateWrite(id, variableKey, valueId, { blockId = this.current, kind = 'physical-state', scope = 'function' } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'state-write', blockId, inputs: [valueId], outputs: [],
      variable: { key: variableKey, kind, scope }, origin: origin(nodeId),
    });
    return nodeId;
  }

  binary(id, operator, left, right, { blockId = this.current, machineType = ADDRESS_TYPE } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'binary', blockId, inputs: [left, right], outputs: [id], operator, origin: origin(nodeId),
    });
    return this.#value(id, nodeId, machineType, null);
  }

  cast(id, kind, input, { blockId = this.current, widthBits = 64 } = {}) {
    const nodeId = `node_${id}`;
    this.#push({ id: nodeId, kind, blockId, inputs: [input], outputs: [id], origin: origin(nodeId) });
    return this.#value(id, nodeId, { kind: 'bitvector', widthBits }, null);
  }

  select(id, condition, left, right, { blockId = this.current } = {}) {
    const nodeId = `node_${id}`;
    this.#push({ id: nodeId, kind: 'select', blockId, inputs: [condition, left, right], outputs: [id], origin: origin(nodeId) });
    return this.#value(id, nodeId, ADDRESS_TYPE, null);
  }

  load(id, addressValueId, { widthBits = 32, blockId = this.current, addressSpace = 'memory' } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'load', blockId, inputs: [addressValueId], outputs: [id],
      memory: { addressSpace, addressValueId, widthBits, endian: 'little', volatility: false, atomic: false },
      origin: origin(nodeId),
    });
    return this.#value(id, nodeId, { kind: 'bitvector', widthBits }, null);
  }

  store(id, addressValueId, valueId, { widthBits = 32, blockId = this.current, addressSpace = 'memory' } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'store', blockId, inputs: [addressValueId, valueId].filter(Boolean), outputs: [],
      memory: { addressSpace, addressValueId, widthBits, endian: 'little', volatility: false, atomic: false },
      origin: origin(nodeId),
    });
    return nodeId;
  }

  /** A call whose effects are entirely unknown — the conservative barrier case. */
  unknownCall(id, { blockId = this.current } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'call', blockId, inputs: [], outputs: [],
      call: {
        targetValueIds: [], targetEntityIds: [], arguments: [], returns: [], stateReads: [], stateWrites: [],
        memoryRead: { scope: 'unknown' }, memoryWrite: { scope: 'unknown' }, controlEffects: [],
        determinism: 'unknown', noreturn: 'unknown', mayThrow: 'unknown', summarySource: 'fixture',
        completeness: 'unknown', unknownEffects: { reason: 'unresolved-call', categories: ['memory', 'state'] },
      },
      completeness: 'unknown',
      unknown: { reason: 'unresolved-call', categories: ['memory', 'state'] },
      origin: origin(nodeId),
    });
    return nodeId;
  }

  /** A call with a fully known, empty effect summary. */
  pureCall(id, { blockId = this.current } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: 'call', blockId, inputs: [], outputs: [],
      call: {
        targetValueIds: [], targetEntityIds: [], arguments: [], returns: [], stateReads: [], stateWrites: [],
        memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, controlEffects: [],
        determinism: 'deterministic', noreturn: false, mayThrow: false, summarySource: 'fixture',
        completeness: 'complete',
      },
      origin: origin(nodeId),
    });
    return nodeId;
  }

  branch(id, targets, { blockId = this.current, conditional = false } = {}) {
    const nodeId = `node_${id}`;
    this.#push({
      id: nodeId, kind: conditional ? 'conditional-branch' : 'branch', blockId,
      inputs: [], outputs: [], targets, origin: origin(nodeId),
    });
    return nodeId;
  }

  ret(id, { blockId = this.current } = {}) {
    const nodeId = `node_${id}`;
    this.#push({ id: nodeId, kind: 'return', blockId, inputs: [], outputs: [], origin: origin(nodeId) });
    return nodeId;
  }

  ir() {
    const partial = this.nodes.some((node) => node.completeness && node.completeness !== 'complete');
    return createSemanticIrFunction({
      functionId: this.functionId,
      entryBlockId: this.blocks[0].id,
      blocks: this.blocks,
      values: this.values,
      nodes: this.nodes,
      completeness: partial ? 'partial' : 'complete',
      unknowns: partial ? [{ reason: 'fixture-unknown', categories: ['memory'] }] : [],
      origin: origin('function'),
    });
  }

  cfg() {
    return createSemanticCfg({
      functionId: this.functionId,
      entryBlockId: this.blocks[0].id,
      blocks: this.blocks.map((block) => ({
        id: block.id,
        successors: edgesFor(this.successors.get(block.id) ?? []),
      })),
    });
  }

  /**
   * Builds every canonical artifact. `queryAlias`/`rootDescriptors` are passed
   * straight through so a test can swap in the Phase 7 solver and compare it
   * against the conservative floor on the same fixture.
   */
  build({ queryAlias = null, queryAliasFactory = null, rootDescriptors = null, memorySsaOptions = {} } = {}) {
    const ir = this.ir();
    const cfg = this.cfg();
    const ssa = buildSemanticSsa(ir, cfg);
    // The Phase 7 solver needs the artifacts it is about to be wired into, so
    // providers are supplied as a factory rather than a prebuilt closure.
    const provider = queryAlias ?? (queryAliasFactory == null ? null : queryAliasFactory({ ir, cfg, ssa }));
    const resolveRegion = (memory, context) => classifySemanticMemoryRegion(ir, context.node, {
      binaryId: this.binaryId,
      ssa,
      ...(rootDescriptors == null ? {} : { rootDescriptors }),
    });
    const memorySsa = buildMemorySsa(ir, cfg, {
      resolveRegion,
      ...(provider == null ? {} : { queryAlias: provider }),
      ...memorySsaOptions,
    });
    return { ir, cfg, ssa, memorySsa, resolveRegion, binaryId: this.binaryId, functionId: this.functionId };
  }
}

export function fixture(functionId, options) {
  return new FunctionFixture(functionId, options);
}

/** Region for one memory node, via the canonical classification service. */
export function regionOf(built, nodeId) {
  const node = built.ir.nodes.find((item) => item.id === nodeId);
  const regions = built.resolveRegion(node.memory, { node });
  return Array.isArray(regions) ? regions[0] : regions;
}

export function memoryAccessOf(built, nodeId) {
  const node = built.ir.nodes.find((item) => item.id === nodeId);
  return { addressValueId: node.memory.addressExpr.valueId, widthBits: node.memory.widthBits, addressSpace: node.memory.addressSpace };
}
