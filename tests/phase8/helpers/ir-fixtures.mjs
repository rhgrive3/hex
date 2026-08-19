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

  /** A load: the canonical "value comes from memory, do not guess" case. */
  load(bits) {
    return this.#emit(this.#instruction('load', null, []), bits);
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

  branch(target) {
    this.current.insts.push({
      op: 'br', sub: null, block: this.current.index, row: this.current.insts.length, args: [],
      origin: { instructionIds: [`instruction_br_${nextId}`] },
    });
    this.current.succ = [target];
    this.current.successorEdges = [{ to: target, kind: 'branch' }];
    return this;
  }

  ret() {
    this.current.insts.push({
      op: 'ret', sub: null, block: this.current.index, row: this.current.insts.length, args: [],
      origin: { instructionIds: [`instruction_ret_${nextId}`] },
    });
    return this;
  }

  build() {
    // Predecessors are derived rather than declared, so a fixture cannot
    // describe a CFG whose edges disagree with themselves.
    const byIndex = new Map(this.blocks.map((block) => [block.index, block]));
    for (const block of this.blocks) block.pred = [];
    for (const block of this.blocks) {
      for (const successor of block.succ) byIndex.get(successor)?.pred.push(block.index);
    }
    if (this.blocks.length > 0 && !this.blocks.some((block) => block.isEntry)) this.blocks[0].isEntry = true;
    return {
      name: this.name,
      values: this.values,
      blocks: this.blocks,
      entry: this.blocks[0]?.index ?? null,
      origin: { instructionIds: [`instruction_${this.name}`] },
    };
  }
}

export function fixture(name) { return new IrFixture(name); }
