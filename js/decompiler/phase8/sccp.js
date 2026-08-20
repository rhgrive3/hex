/**
 * Sparse conditional constant propagation, with a wrapped range beside every
 * lattice cell.
 *
 * Two properties matter more than the folding itself.
 *
 * Executable edges. A phi meets only its executable predecessors, and an edge is
 * executable only when it was *proved* reachable, never when it merely looks
 * plausible. That is what separates SCCP from ordinary constant propagation: a
 * value that is constant on every path the program can take stays constant even
 * though a dead path assigns something else.
 *
 * Exact widths. Every fold goes through the bitvector module, so `0xFFFFFFF0 + 0x20`
 * is `0x10` at 32 bits and not `0x100000010`. An operation that cannot be
 * modelled exactly — an architecture-defined shift, a division that can trap, a
 * comparison whose flag semantics belong to the target — makes the value
 * overdefined and records why. Guessing there would produce a confident wrong
 * answer, which is the one thing the architecture forbids outright.
 *
 * This pass is generic. It names no register, no flag and no ABI: the IR has
 * already lowered branch conditions to one-bit values, so nothing here needs to
 * know what `nzcv` or `eflags` mean.
 */

import {
  bitvector, evaluateBinary, evaluateUnary, extractField, insertField,
  isSupportedWidth, sameBitvector, signExtend, truncate, zeroExtend,
} from './bitvector.js';
import {
  describeRange, emptyRange, fullRange, join, sameRange, singleton, widen,
  evaluateBinaryRange, signExtendRange, truncateRange, zeroExtendRange,
} from './range.js';
import { createPassDescriptor, createPassResult } from './contract.js';

export const SCCP_PASS = createPassDescriptor({
  id: 'phase8.sccp',
  version: '1.0.0',
  stage: 'scalar-optimization',
  budgetClass: 'standard',
  consumes: ['cfg', 'ssa'],
  // It reads nothing about memory, types or loops and rewrites nothing, so every
  // other analysis survives it untouched.
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'valueNumbers', 'deadCode', 'induction', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: ['ranges'],
  description: 'Executable-edge-aware constant propagation with an exact-width wrapped range domain.',
});

/** Lattice cells. UNDEFINED is the top: not yet known to be reachable at all. */
export const UNDEFINED = 'undefined';
export const CONSTANT = 'constant';
export const OVERDEFINED = 'overdefined';

const TOP = Object.freeze({ state: UNDEFINED, constant: null, reason: null });

function constantCell(constant) {
  return Object.freeze({ state: CONSTANT, constant, reason: null });
}

function overdefined(reason) {
  return Object.freeze({ state: OVERDEFINED, constant: null, reason: reason ?? null });
}

/**
 * Meet. Two different constants are overdefined; a constant met with top stays
 * the constant, which is exactly what lets an unreachable predecessor contribute
 * nothing to a phi.
 */
export function meet(left, right) {
  if (left.state === UNDEFINED) return right;
  if (right.state === UNDEFINED) return left;
  if (left.state === OVERDEFINED) return left;
  if (right.state === OVERDEFINED) return right;
  if (sameBitvector(left.constant, right.constant)) return left;
  return overdefined('predecessors disagree');
}

/** Widening threshold. Convergence has to be bounded, not merely likely. */
const DEFAULT_LIMITS = Object.freeze({
  maxVisitsPerValue: 6,
  // The primary bound is work, not wall clock, so the point at which SCCP stops
  // is a property of the input rather than of the machine. The heaviest function
  // in the frozen corpus reaches ~5,400 items; the bound is set an order of
  // magnitude above that so it limits pathological inputs without truncating
  // ordinary ones.
  maxWorkItems: 50000,
});

function widthOf(value) {
  const bits = Number(value?.bits ?? 0);
  return isSupportedWidth(bits) ? bits : null;
}

function constantOfValue(value) {
  const bits = widthOf(value);
  if (bits == null) return null;
  const raw = value?.def?.extra?.value ?? value?.const;
  if (raw == null) return null;
  try { return bitvector(raw, bits); } catch { return null; }
}

/** The generic operator name for a definition, or null when it is not modelled. */
function operatorOf(definition) {
  const op = definition?.op;
  const sub = definition?.sub;
  if (op === 'bin') return { kind: 'binary', operator: sub };
  if (op === 'un') return { kind: 'unary', operator: sub };
  if (op === 'mov') {
    if (sub == null) return { kind: 'copy', operator: 'copy' };
    if (sub === 'trunc' || sub === 'zext' || sub === 'sext') return { kind: 'cast', operator: sub };
    return null;
  }
  if (op === 'bfx' && sub === 'extract') return { kind: 'extract', operator: 'extract' };
  if (op === 'bfi' && sub === 'insert') return { kind: 'insert', operator: 'insert' };
  if (op === 'sel') return { kind: 'select', operator: 'select' };
  if (op === 'const') return { kind: 'const', operator: 'const' };
  return null;
}

function argumentValues(definition) {
  return (definition?.args ?? []).map((argument) => argument?.value ?? null);
}

/**
 * The reason a definition is not foldable.
 *
 * Recorded rather than swallowed, so a missed optimization is visible as a
 * missed optimization instead of looking like an operation nobody tried.
 */
function unmodelledReason(definition) {
  const op = definition?.op;
  if (op === 'load') return 'value comes from memory';
  if (op === 'cmp') return 'comparison result depends on target-defined flag semantics';
  if (op === 'clobber') return 'value is clobbered by an opaque operation';
  if (op === 'unknown') return 'operation is not represented in the semantic IR';
  if (op === 'call') return 'value is produced by a call';
  return `operation is not modelled: ${op}${definition?.sub ? `/${definition.sub}` : ''}`;
}

/**
 * Runs SCCP over one function's canonical CFG and SSA facts.
 *
 * `analysis` is the authoritative state; the pass reads `cfg` and `ssa` from it
 * and stages `ranges`. It never writes to the IR.
 */
export function runSccpPass(context = {}, budget = {}, area = null) {
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const ssa = analysis?.get('ssa');
  const blocks = cfg?.blocks ?? [];
  const values = ssa?.values ?? [];
  const limits = { ...DEFAULT_LIMITS, ...(context.sccpLimits ?? {}) };

  const cells = new Map();
  const ranges = new Map();
  const visits = new Map();
  const executableEdges = new Set();
  const executableBlocks = new Set();
  // Executable predecessors per block, maintained alongside the edge set. A phi
  // asks "is this predecessor reachable" once per incoming value per revisit;
  // answering it by scanning the edge set made that O(edges) and dominated the
  // whole pass on a 300-value function (EP-016: profile the hot path).
  const executablePredecessors = new Map();
  const diagnostics = [];
  let widened = 0;
  let work = 0;
  let budgetExhausted = false;

  const valueById = new Map(values.map((value) => [value.id, value]));
  const blockByIndex = new Map(blocks.map((block) => [block.index, block]));

  const cellOf = (value) => (value == null ? overdefined('missing operand') : cells.get(value.id) ?? TOP);
  const rangeOfValue = (value) => {
    if (value == null) return null;
    const known = ranges.get(value.id);
    if (known) return known;
    const bits = widthOf(value);
    return bits == null ? null : fullRange(bits);
  };

  const valueWorklist = [];
  const blockWorklist = [];

  function markEdge(from, to, kind) {
    const key = `${from}->${to}:${kind}`;
    if (executableEdges.has(key)) return;
    executableEdges.add(key);
    if (!executablePredecessors.has(to)) executablePredecessors.set(to, new Set());
    executablePredecessors.get(to).add(from);
    if (!executableBlocks.has(to)) {
      executableBlocks.add(to);
      blockWorklist.push(to);
    } else {
      // The block was already reachable, but a new incoming edge changes every
      // phi in it: a predecessor that used to contribute nothing now does.
      for (const phi of blockByIndex.get(to)?.phis ?? []) if (phi?.dst?.id != null) valueWorklist.push(phi.dst.id);
    }
  }

  function setCell(valueId, proposed, proposedRange) {
    const previous = cells.get(valueId) ?? TOP;
    const previousRange = ranges.get(valueId) ?? null;
    const seen = (visits.get(valueId) ?? 0) + 1;
    visits.set(valueId, seen);

    // Cells only ever move down the lattice. Re-evaluating a value can transiently
    // read an operand as not-yet-evaluated, and letting the cell climb back to
    // top on that reading makes the worklist oscillate forever instead of
    // converging — the whole analysis then reports `partial` on a five-block
    // function. Meeting with the previous cell is what makes the chain finite.
    const next = meet(previous, proposed);

    // Ranges ascend by union for the same reason: a monotone chain plus widening
    // is what bounds convergence. Without it a range can shrink and grow forever.
    let effectiveRange = proposedRange;
    if (previousRange != null && proposedRange != null && previousRange.bits === proposedRange.bits) {
      effectiveRange = join(previousRange, proposedRange);
      if (!sameRange(previousRange, effectiveRange) && seen > limits.maxVisitsPerValue) {
        // A value that keeps moving is widened rather than chased; the
        // alternative is a fixed point that exists in theory and not inside a
        // browser budget.
        effectiveRange = widen(previousRange, effectiveRange);
        widened += 1;
      }
    }

    // Two cells are equal when the state matches and either both carry no
    // constant or they carry the same one. `sameBitvector(null, null)` is false
    // by design — a missing constant is not a constant — so comparing cells
    // through it alone reports a change on every revisit of an overdefined
    // value, and the worklist never terminates.
    const sameConstant = previous.constant == null && next.constant == null
      ? true
      : sameBitvector(previous.constant, next.constant);
    const cellChanged = previous.state !== next.state || !sameConstant;
    const rangeChanged = effectiveRange != null && (previousRange == null || !sameRange(previousRange, effectiveRange));
    if (!cellChanged && !rangeChanged) return;
    cells.set(valueId, next);
    if (effectiveRange != null) ranges.set(valueId, effectiveRange);
    for (const use of valueById.get(valueId)?.uses ?? []) {
      const target = use?.dst?.id ?? use?.id;
      if (target != null) valueWorklist.push(target);
    }
    // A use list that does not cover phis in successor blocks would leave a phi
    // stale, so successors' phis are re-queued explicitly.
    const definition = valueById.get(valueId)?.def;
    const block = definition?.block;
    if (block != null) {
      for (const successor of blockByIndex.get(block)?.succ ?? []) {
        for (const phi of blockByIndex.get(successor)?.phis ?? []) if (phi?.dst?.id != null) valueWorklist.push(phi.dst.id);
      }
    }
  }

  function evaluatePhi(value) {
    const definition = value.def;
    const bits = widthOf(value);
    let cell = TOP;
    let range = bits == null ? null : emptyRange(bits);
    for (const incoming of definition?.incoming ?? []) {
      const from = incoming?.from;
      const source = incoming?.value;
      if (from == null) return { cell: overdefined('phi predecessor is unknown'), range: bits == null ? null : fullRange(bits) };
      // Only executable predecessors contribute. This is the whole point of the
      // "conditional" in SCCP.
      if (!executablePredecessors.get(definition.block)?.has(from)) continue;
      cell = meet(cell, cellOf(source));
      const sourceRange = rangeOfValue(source);
      if (bits != null && sourceRange != null && sourceRange.bits === bits) range = join(range, sourceRange);
      else if (bits != null) range = fullRange(bits);
    }
    return { cell, range };
  }

  function evaluate(value) {
    const definition = value.def;
    const bits = widthOf(value);
    if (bits == null) return { cell: overdefined(`unsupported width: ${value?.bits}`), range: null };
    if (value.kind === 'phi' || definition?.op === 'phi') return evaluatePhi(value);
    if (value.kind === 'arg' || value.kind === 'undef' || definition == null) {
      return { cell: overdefined(value.kind === 'arg' ? 'function argument' : 'value has no definition'), range: fullRange(bits) };
    }

    const shape = operatorOf(definition);
    if (shape == null) {
      return { cell: overdefined(unmodelledReason(definition)), range: fullRange(bits) };
    }
    if (shape.kind === 'const') {
      const constant = constantOfValue(value);
      return constant == null
        ? { cell: overdefined('constant has no representable value'), range: fullRange(bits) }
        : { cell: constantCell(constant), range: singleton(constant) };
    }

    const operands = argumentValues(definition);
    const operandCells = operands.map((operand) => cellOf(operand));
    // An operand nobody has reached yet leaves this value at top too: concluding
    // anything from an unevaluated operand would be reading uninitialised state.
    if (operandCells.some((cell) => cell.state === UNDEFINED)) return { cell: TOP, range: null };

    const constants = operandCells.map((cell) => cell.constant);
    const allConstant = operandCells.every((cell) => cell.state === CONSTANT);

    if (shape.kind === 'copy') {
      const source = operands[0];
      const cell = operandCells[0] ?? overdefined('copy has no source');
      const sourceRange = rangeOfValue(source);
      if (cell.state === CONSTANT && cell.constant.bits !== bits) {
        // A copy that changes width is a cast the IR did not label; do not
        // silently reinterpret the bits.
        return { cell: overdefined('copy changes width without a declared cast'), range: fullRange(bits) };
      }
      return { cell, range: sourceRange && sourceRange.bits === bits ? sourceRange : fullRange(bits) };
    }

    if (shape.kind === 'cast') {
      const source = operands[0];
      const sourceRange = rangeOfValue(source);
      if (allConstant) {
        const folded = shape.operator === 'trunc' ? truncate(constants[0], bits)
          : shape.operator === 'zext' ? zeroExtend(constants[0], bits)
            : signExtend(constants[0], bits);
        if (folded != null) return { cell: constantCell(folded), range: singleton(folded) };
        return { cell: overdefined(`cast is not representable: ${shape.operator}`), range: fullRange(bits) };
      }
      if (sourceRange == null) return { cell: overdefined('cast source has no range'), range: fullRange(bits) };
      const widenedRange = shape.operator === 'trunc' ? truncateRange(sourceRange, bits)
        : shape.operator === 'zext' ? zeroExtendRange(sourceRange, bits)
          : signExtendRange(sourceRange, bits);
      if (!widenedRange.exact && widenedRange.reason) {
        diagnostics.push({
          severity: 'info',
          code: 'phase8.sccp.precision-loss',
          message: `Range precision lost across ${shape.operator} for value ${value.id}.`,
          reason: widenedRange.reason,
        });
      }
      return { cell: overdefined(`operand of ${shape.operator} is not constant`), range: widenedRange.range };
    }

    if (shape.kind === 'unary') {
      if (allConstant) {
        const folded = evaluateUnary(shape.operator, constants[0]);
        if (folded != null && folded.bits === bits) return { cell: constantCell(folded), range: singleton(folded) };
        if (folded != null) return { cell: overdefined('unary result width disagrees with the value width'), range: fullRange(bits) };
      }
      if (shape.operator === 'sext') {
        // `un/sext` is a cast spelled as a unary operation.
        const sourceRange = rangeOfValue(operands[0]);
        if (allConstant) {
          const folded = signExtend(constants[0], bits);
          if (folded != null) return { cell: constantCell(folded), range: singleton(folded) };
        }
        if (sourceRange != null) return { cell: overdefined('operand is not constant'), range: signExtendRange(sourceRange, bits).range };
      }
      return { cell: overdefined(`unary ${shape.operator} is not foldable here`), range: fullRange(bits) };
    }

    if (shape.kind === 'binary') {
      if (allConstant) {
        const folded = evaluateBinary(shape.operator, constants[0], constants[1]);
        if (folded != null && folded.bits === bits) return { cell: constantCell(folded), range: singleton(folded) };
        if (folded == null) {
          const reason = `binary ${shape.operator} is not exactly modelled for these operands`;
          diagnostics.push({
            severity: 'info',
            code: 'phase8.sccp.unmodelled-operation',
            message: `Value ${value.id} was not folded.`,
            reason,
          });
          return { cell: overdefined(reason), range: fullRange(bits) };
        }
        return { cell: overdefined('binary result width disagrees with the value width'), range: fullRange(bits) };
      }
      const leftRange = rangeOfValue(operands[0]);
      const rightRange = rangeOfValue(operands[1]);
      if (leftRange == null || rightRange == null) return { cell: overdefined('operand has no range'), range: fullRange(bits) };
      const combined = evaluateBinaryRange(shape.operator, leftRange, rightRange);
      return {
        cell: overdefined(`operands of ${shape.operator} are not both constant`),
        range: combined.range.bits === bits ? combined.range : fullRange(bits),
      };
    }

    if (shape.kind === 'extract') {
      if (allConstant) {
        const low = definition.extra?.lsb ?? definition.extra?.low ?? definition.extra?.offset;
        const folded = low == null ? null : extractField(constants[0], low, bits);
        if (folded != null) return { cell: constantCell(folded), range: singleton(folded) };
      }
      return { cell: overdefined('bit-field extract is not foldable here'), range: fullRange(bits) };
    }

    if (shape.kind === 'insert') {
      if (allConstant && constants.length >= 2) {
        const low = definition.extra?.lsb ?? definition.extra?.low ?? definition.extra?.offset;
        const folded = low == null ? null : insertField(constants[0], constants[1], low);
        if (folded != null && folded.bits === bits) return { cell: constantCell(folded), range: singleton(folded) };
      }
      return { cell: overdefined('bit-field insert is not foldable here'), range: fullRange(bits) };
    }

    if (shape.kind === 'select') {
      const conditionCell = operandCells[0];
      if (conditionCell?.state === CONSTANT) {
        // The condition decides which arm survives; the other contributes
        // nothing, exactly as an unreachable phi predecessor does.
        const chosen = conditionCell.constant.value === 0n ? operandCells[2] : operandCells[1];
        const chosenValue = conditionCell.constant.value === 0n ? operands[2] : operands[1];
        if (chosen != null) {
          const chosenRange = rangeOfValue(chosenValue);
          return { cell: chosen, range: chosenRange && chosenRange.bits === bits ? chosenRange : fullRange(bits) };
        }
      }
      const armRanges = [rangeOfValue(operands[1]), rangeOfValue(operands[2])].filter((range) => range?.bits === bits);
      return {
        cell: meet(operandCells[1] ?? overdefined('select arm missing'), operandCells[2] ?? overdefined('select arm missing')),
        range: armRanges.length === 2 ? join(armRanges[0], armRanges[1]) : fullRange(bits),
      };
    }

    return { cell: overdefined('operation shape is not modelled'), range: fullRange(bits) };
  }

  function processTerminator(block) {
    const terminator = (block.insts ?? []).at(-1);
    const edges = block.successorEdges ?? [];
    if (terminator?.op !== 'cbr' || edges.length === 0) {
      for (const successor of block.succ ?? []) markEdge(block.index, successor, 'unconditional');
      return;
    }
    const condition = terminator.conditionValue;
    const cell = condition == null ? overdefined('branch has no condition value') : cellOf(condition);
    // A condition nobody has evaluated yet is not "unknown", it is "not yet
    // known". Marking both arms executable here would be permanent — edges are
    // only ever added — and the branch could never be folded afterwards no
    // matter what the condition turns out to be.
    if (cell.state === UNDEFINED) return;
    if (cell.state !== CONSTANT || cell.constant.bits !== 1) {
      for (const edge of edges) markEdge(block.index, edge.to, edge.kind);
      return;
    }
    // A proved condition makes exactly one arm executable. Everything reached
    // only through the other arm is unreachable, and a phi there stops seeing it.
    const taken = cell.constant.value !== 0n;
    for (const edge of edges) {
      const isTrueArm = edge.kind === 'conditional-true';
      const isFalseArm = edge.kind === 'conditional-false' || edge.kind === 'fallthrough';
      if ((taken && isTrueArm) || (!taken && isFalseArm)) markEdge(block.index, edge.to, edge.kind);
      else if (!isTrueArm && !isFalseArm) markEdge(block.index, edge.to, edge.kind);
    }
  }

  // Which block's terminator each value can decide. Re-running every terminator
  // after every value evaluation was the second half of the cost; a value that
  // is not a branch condition cannot change any edge.
  const conditionOwners = new Map();
  for (const block of blocks) {
    const terminator = (block.insts ?? []).at(-1);
    const conditionId = terminator?.op === 'cbr' ? terminator.conditionValue?.id : null;
    if (conditionId == null) continue;
    if (!conditionOwners.has(conditionId)) conditionOwners.set(conditionId, []);
    conditionOwners.get(conditionId).push(block);
  }

  // Values with no definition — function arguments, undefined values, anything
  // the IR presents without a producer — are overdefined from the start. They
  // are never reached by the worklist, so leaving them at top would mean a
  // branch on an argument never resolves and every block behind it looks
  // unreachable.
  for (const value of values) {
    if (value.def != null || value.kind === 'phi') continue;
    const bits = widthOf(value);
    const known = constantOfValue(value);
    cells.set(value.id, known != null ? constantCell(known) : overdefined(value.kind === 'arg' ? 'function argument' : 'value has no definition'));
    if (bits != null) ranges.set(value.id, known != null ? singleton(known) : fullRange(bits));
  }

  const entry = blocks.find((block) => block.isEntry) ?? blocks[0];
  if (entry != null) {
    executableBlocks.add(entry.index);
    blockWorklist.push(entry.index);
  }

  const aborted = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  while ((blockWorklist.length > 0 || valueWorklist.length > 0) && !budgetExhausted) {
    if (work >= limits.maxWorkItems || aborted()) { budgetExhausted = true; break; }
    work += 1;

    if (blockWorklist.length > 0) {
      const index = blockWorklist.shift();
      const block = blockByIndex.get(index);
      if (!block) continue;
      for (const phi of block.phis ?? []) if (phi?.dst?.id != null) valueWorklist.push(phi.dst.id);
      for (const instruction of block.insts ?? []) {
        const destination = instruction?.dst;
        if (destination?.id != null) valueWorklist.push(destination.id);
        // The branch condition is an operand, not a destination. If it is
        // defined in another executable block it has a cell already; queueing it
        // here costs one evaluation and removes the ordering dependency.
        if (instruction?.op === 'cbr' && instruction.conditionValue?.id != null) valueWorklist.push(instruction.conditionValue.id);
      }
      processTerminator(block);
      continue;
    }

    const valueId = valueWorklist.shift();
    const value = valueById.get(valueId);
    if (!value) continue;
    const definitionBlock = value.def?.block;
    // A value defined in a block nobody can reach has no meaning yet.
    if (definitionBlock != null && !executableBlocks.has(definitionBlock)) continue;
    const { cell, range } = evaluate(value);
    setCell(valueId, cell, range);
    // Folding a branch condition can make an edge executable, so exactly the
    // terminators this value decides are reconsidered — not every terminator.
    for (const owner of conditionOwners.get(valueId) ?? []) {
      if (executableBlocks.has(owner.index)) processTerminator(owner);
    }
  }

  const provenConstants = [...cells.entries()].filter(([, cell]) => cell.state === CONSTANT);
  const unreachableBlocks = blocks.filter((block) => !executableBlocks.has(block.index)).map((block) => block.index);
  const newlyProven = provenConstants.filter(([valueId]) => {
    const value = valueById.get(valueId);
    return value != null && constantOfValue(value) == null;
  });

  const result = {
    contractVersion: SCCP_PASS.contractVersion,
    passVersion: SCCP_PASS.version,
    // Constants the IR did not already carry. Reporting the total would flatter
    // the pass with facts it did not produce.
    constants: new Map(provenConstants.map(([valueId, cell]) => [valueId, cell.constant])),
    newlyProvenConstantCount: newlyProven.length,
    ranges,
    executableEdges: Object.freeze([...executableEdges].sort()),
    unreachableBlockIndexes: Object.freeze(unreachableBlocks.sort((left, right) => left - right)),
    overdefinedReasons: new Map([...cells.entries()]
      .filter(([, cell]) => cell.state === OVERDEFINED && cell.reason)
      .map(([valueId, cell]) => [valueId, cell.reason])),
    widenedValueCount: widened,
    workItems: work,
    // Per-value revisit counts. A value that dominates this map is the value
    // whose lattice or range is not converging, which is the first thing to look
    // at when the pass reports `partial`.
    visitCounts: visits,
    // Truthfully partial when the worklist was cut off: a fixed point that was
    // not reached is not a fixed point.
    completeness: budgetExhausted ? 'partial' : 'complete',
  };

  if (area != null) area.stage('ranges', Object.freeze(result));

  const boundedDiagnostics = diagnostics.slice(0, 24);
  if (budgetExhausted) {
    boundedDiagnostics.push({
      severity: 'warning',
      code: 'phase8.sccp.budget',
      message: 'SCCP stopped before reaching a fixed point.',
      reason: `The worklist exceeded ${limits.maxWorkItems} items or the pass was cancelled; the published ranges are sound but not maximally precise.`,
    });
  }
  if (widened > 0) {
    boundedDiagnostics.push({
      severity: 'info',
      code: 'phase8.sccp.widened',
      message: `${widened} value ranges were widened to reach a fixed point.`,
      reason: `A value revisited more than ${limits.maxVisitsPerValue} times is widened rather than chased, so convergence is bounded.`,
    });
  }

  return createPassResult({
    descriptor: SCCP_PASS,
    // A produced analysis is a change: downstream reuse has to see a new version.
    status: 'changed',
    changed: true,
    completeness: result.completeness,
    // SCCP rewrites nothing. It produces an analysis, which is a different kind
    // of change and is recorded as one; the values it made a claim about are in
    // the published facts themselves, keyed by SSA value id.
    transforms: [],
    produced: ['ranges'],
    diagnostics: boundedDiagnostics,
    invalidated: [],
  });
}

/** A short human summary, used by diagnostics and evidence. */
export function describeSccp(result) {
  return [
    `constants=${result.constants.size}`,
    `newlyProven=${result.newlyProvenConstantCount}`,
    `ranges=${result.ranges.size}`,
    `executableEdges=${result.executableEdges.length}`,
    `unreachableBlocks=${result.unreachableBlockIndexes.length}`,
    `widened=${result.widenedValueCount}`,
    `completeness=${result.completeness}`,
  ].join(' ');
}

export { describeRange };
