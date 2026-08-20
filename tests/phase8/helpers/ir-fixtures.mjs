/**
 * Architecture-neutral IR fixtures for the Phase 8 scalar lane.
 *
 * These build the CFG/SSA shape the decompiler pipeline consumes, directly and
 * by hand. That is deliberate: a fixture assembled from AArch64 assembly proves
 * things about AArch64 as much as about the optimizer, and Phase 8's generic
 * passes have to be provable without any target in the picture at all. The
 * frozen corpus proves end-to-end product integration; these prove the algorithm.
 *
 * Nothing here names a register, a flag or an ABI.
 */

import { analyzeGraph } from '../../../js/controlflow.js';

let nextId = 1;

function freshId() { return nextId++; }

/** One function under construction. Blocks are declared in order. */
export class IrFixture {
  constructor(name = 'fixture') {
    this.name = name;
    this.blocks = [];
    this.values = [];
    this.current = null;
  }

  block(index, { succ = [], pred = [], edges = null, isEntry = false } = {}) {
    const block = {
      index,
      succ: [...succ],
      pred: [...pred],
      successorEdges: edges ?? succ.map((to) => ({ to, kind: 'branch' })),
      insts: [],
      phis: [],
      isEntry,
      // A block whose edges were declared explicitly keeps them: a terminator
      // helper must not quietly relabel an unwind or indirect edge as a plain
      // branch, which is the very thing the structuring tests are about.
      declaredEdges: edges != null,
      origin: { instructionIds: [`instruction_block_${index}`] },
    };
    this.blocks.push(block);
    this.current = block;
    return this;
  }

  #value(bits, definition, kind = 'def') {
    const value = {
      id: freshId(), kind, bits, signed: null, const: null, uses: [],
      origin: { instructionIds: [`instruction_value_${nextId}`] },
      def: definition,
    };
    if (definition) definition.dst = value;
    this.values.push(value);
    return value;
  }

  #instruction(op, sub, args, extra = {}) {
    return {
      op, sub, block: this.current.index, row: this.current.insts.length,
      args: args.map((value) => ({ value })), extra,
      origin: { instructionIds: [`instruction_${op}_${nextId}`] },
    };
  }

  #emit(instruction, bits) {
    this.current.insts.push(instruction);
    const value = this.#value(bits, instruction);
    for (const argument of instruction.args) argument.value?.uses.push(instruction);
    return value;
  }

  constant(value, bits) {
    const instruction = this.#instruction('const', null, [], { value: BigInt(value) });
    const produced = this.#emit(instruction, bits);
    produced.const = BigInt.asUintN(bits, BigInt(value));
    return produced;
  }

  /** An input with no definition: the canonical overdefined source. */
  opaque(bits) {
    const value = this.#value(bits, null, 'arg');
    return value;
  }

  binary(operator, left, right, bits) {
    return this.#emit(this.#instruction('bin', operator, [left, right]), bits);
  }

  unary(operator, operand, bits) {
    return this.#emit(this.#instruction('un', operator, [operand]), bits);
  }

  cast(kind, operand, bits) {
    return this.#emit(this.#instruction('mov', kind, [operand]), bits);
  }

  copy(operand, bits) {
    return this.#emit(this.#instruction('mov', null, [operand]), bits);
  }

  select(condition, whenTrue, whenFalse, bits) {
    return this.#emit(this.#instruction('sel', 'sel', [condition, whenTrue, whenFalse]), bits);
  }

  /**
   * A load with explicit memory facts.
   *
   * The defaults mirror what the real IR reports when nothing has been proved:
   * volatility and atomicity `unknown`, which is not permission to reuse or
   * remove. A fixture has to opt in to the proved case, exactly as the product
   * does.
   */
  load(bits, {
    locKey = null, addressSpace = 'memory', volatility = 'unknown', atomic = 'unknown',
    ordering = 'unknown', faults = [], memDefs = null, barrier = null, addressPrecise = false,
    addrBase = null, addrIndex = null, scale = 0, disp = null, locKind = null,
  } = {}) {
    const instruction = this.#instruction('load', null, [], {
      memoryAccess: { addressSpace, widthBits: bits, volatility, atomic, ordering, faults },
      addressPrecise,
    });
    if (locKey != null || locKind != null || disp != null) {
      instruction.loc = { kind: locKind ?? 'field', key: locKey, size: bits / 8, disp: disp == null ? null : BigInt(disp) };
    }
    if (memDefs != null) instruction.memUse = { memDefs: memDefs.map((id) => ({ inst: { id } })) };
    if (barrier != null) instruction.unknownAliasBarrier = barrier;
    // The address a load computes from, as the real IR carries it: a base value
    // and an optional index, not an ordinary operand.
    if (addrBase != null || addrIndex != null) {
      instruction.addr = { base: addrBase, index: addrIndex, disp: disp == null ? 0n : BigInt(disp), scale };
    }
    return this.#emit(instruction, bits);
  }

  /** A store. Observable regardless of whether anything reads it. */
  store(value, { locKey = null, locKind = null, disp = null, addrBase = null, addrIndex = null, scale = 0, bits = null } = {}) {
    const width = bits ?? value?.bits ?? 32;
    const instruction = this.#instruction('store', null, [value], {
      memoryAccess: { addressSpace: 'memory', widthBits: width, volatility: 'unknown', atomic: 'unknown', ordering: 'unknown', faults: [] },
    });
    if (locKey != null || locKind != null || disp != null) {
      instruction.loc = { kind: locKind ?? 'field', key: locKey, size: width / 8, disp: disp == null ? null : BigInt(disp) };
    }
    if (addrBase != null || addrIndex != null) {
      instruction.addr = { base: addrBase, index: addrIndex, disp: disp == null ? 0n : BigInt(disp), scale };
    }
    this.current.insts.push(instruction);
    value?.uses.push(instruction);
    return instruction;
  }

  /** A call. It may do anything, and it may do something different each time. */
  call(bits) {
    return this.#emit(this.#instruction('call', null, []), bits);
  }

  /** An operation that writes state this analysis does not track. */
  stateWrite(bits) {
    return this.#emit(this.#instruction('mov', null, [], { stateWrite: { key: 'opaque' } }), bits);
  }

  /** A division, which can trap unless the IR proves otherwise. */
  divide(left, right, bits, { faults = null } = {}) {
    return this.#emit(this.#instruction('bin', 'udiv', [left, right], faults == null ? {} : { faults }), bits);
  }

  /** An opaque operation the semantic IR could not represent. */
  unknown(bits) {
    return this.#emit(this.#instruction('unknown', null, []), bits);
  }

  phi(incoming, bits) {
    const instruction = {
      op: 'phi', sub: null, block: this.current.index, row: -1, args: [],
      incoming: incoming.map(([from, value]) => ({ from, value })),
      origin: { instructionIds: [`instruction_phi_${nextId}`] },
    };
    const value = this.#value(bits, instruction, 'phi');
    this.current.phis.push(instruction);
    for (const [, source] of incoming) source?.uses.push(instruction);
    return value;
  }

  /**
   * Fills in a phi edge whose value is only defined further down the loop body.
   *
   * A loop-carried phi has to name a value that does not exist yet when the
   * header is written, which is a property of loops, not of this helper.
   */
  closePhi(phiValue, from, value) {
    const incoming = (phiValue?.def?.incoming ?? []).find((entry) => entry.from === from);
    if (incoming == null) throw new TypeError(`ir-fixture-no-phi-edge-from:${from}`);
    incoming.value = value;
    value?.uses.push(phiValue.def);
    return phiValue;
  }

  /** A conditional branch on a one-bit value, as the IR presents it. */
  conditionalBranch(condition, trueBlock, falseBlock) {
    this.current.insts.push({
      op: 'cbr', sub: null, block: this.current.index, row: this.current.insts.length,
      args: [{ value: condition }], conditionValue: condition,
      origin: { instructionIds: [`instruction_cbr_${nextId}`] },
    });
    this.current.succ = [trueBlock, falseBlock];
    this.current.successorEdges = [
      { to: trueBlock, kind: 'conditional-true' },
      { to: falseBlock, kind: 'conditional-false' },
    ];
    return this;
  }

  /** A switch terminator: one edge per case, plus an optional default. */
  switchBranch(selector, cases, defaultTarget = null) {
    this.current.insts.push({
      op: 'switch', sub: null, block: this.current.index, row: this.current.insts.length,
      args: [{ value: selector }], selectorValue: selector,
      origin: { instructionIds: [`instruction_switch_${nextId}`] },
    });
    selector?.uses.push(this.current.insts.at(-1));
    const targets = defaultTarget == null ? [...cases] : [...cases, defaultTarget];
    this.current.succ = targets;
    this.current.successorEdges = targets.map((to, index) => ({
      to,
      kind: defaultTarget != null && index === targets.length - 1 ? 'switch-default' : 'switch-case',
    }));
    return this;
  }

  branch(target) {
    this.current.insts.push({
      op: 'br', sub: null, block: this.current.index, row: this.current.insts.length, args: [],
      origin: { instructionIds: [`instruction_br_${nextId}`] },
    });
    if (!this.current.declaredEdges) {
      this.current.succ = [target];
      this.current.successorEdges = [{ to: target, kind: 'branch' }];
    }
    return this;
  }

  ret() {
    this.current.insts.push({
      op: 'ret', sub: null, block: this.current.index, row: this.current.insts.length, args: [],
      origin: { instructionIds: [`instruction_ret_${nextId}`] },
    });
    return this;
  }

  /**
   * Finishes the function.
   *
   * Dominance and the loop set come from the product's own `analyzeGraph`, not
   * from anything written here. That is the point: the Phase 8 loop pass has to
   * be proved against the canonical upstream loop facts, and a fixture that
   * hand-wrote its own would be proving the pass against a second loop detector
   * — the exact thing P8-4 forbids.
   *
   * `loops` may be overridden to hand the pass a record that is *not* a natural
   * loop, which is how the refusal path is tested.
   */
  build({ loops = null } = {}) {
    // Predecessors are derived rather than declared, so a fixture cannot
    // describe a CFG whose edges disagree with themselves.
    const byIndex = new Map(this.blocks.map((block) => [block.index, block]));
    for (const block of this.blocks) block.pred = [];
    for (const block of this.blocks) {
      for (const successor of block.succ) byIndex.get(successor)?.pred.push(block.index);
    }
    if (this.blocks.length > 0 && !this.blocks.some((block) => block.isEntry)) this.blocks[0].isEntry = true;
    const highest = this.blocks.reduce((most, block) => Math.max(most, block.index), -1);
    const successors = [];
    for (let index = 0; index <= highest; index += 1) successors.push([...(byIndex.get(index)?.succ ?? [])]);
    const graph = analyzeGraph(successors, this.blocks[0]?.index ?? 0);
    return {
      name: this.name,
      values: this.values,
      blocks: this.blocks,
      entry: this.blocks[0]?.index ?? null,
      idom: graph.immediateDominators,
      dominators: graph.dominators,
      ipdom: graph.immediatePostDominators,
      postDominators: graph.postDominators,
      backEdges: graph.backEdges,
      loops: loops ?? graph.loops,
      origin: { instructionIds: [`instruction_${this.name}`] },
    };
  }
}

export function fixture(name) { return new IrFixture(name); }
