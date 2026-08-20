/**
 * Effect-aware dead code identification.
 *
 * The rule this pass exists to enforce: "the result is unused" and "running the
 * operation is unobservable" are two different facts, and both have to be proved
 * before an operation may be dropped. Conflating them is the classic decompiler
 * bug that deletes a store whose value nobody reads, or a call whose return
 * value is ignored, or a load that faults.
 *
 * So the question is asked in two halves:
 *
 *   1. Is every use of this value gone?
 *   2. Is executing this operation observable in any other way — does it write
 *      memory, call, trap, fault, order other accesses, change control flow, or
 *      touch state this analysis does not model?
 *
 * Only an operation that fails both tests is a candidate. Everything else is
 * kept, with the reason recorded. When in doubt the operation stays: a missed
 * removal costs a line of pseudocode, a wrong removal costs the program.
 *
 * This pass identifies candidates. It does not remove anything.
 */

import { createPassDescriptor, createPassResult } from './contract.js';

export const DCE_PASS = createPassDescriptor({
  id: 'phase8.dce',
  version: '1.0.0',
  stage: 'memory-optimization',
  budgetClass: 'standard',
  // It reads the CFG and SSA and nothing else. Declaring `valueNumbers` here
  // would be a dependency this pass does not have, which is as misleading as an
  // undeclared one: it would order the pipeline around a fact nobody reads.
  consumes: ['cfg', 'ssa'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'induction', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: ['deadCode'],
  description: 'Identifies operations whose result is dead and whose execution is provably unobservable.',
});

/**
 * Operations whose execution is observable regardless of their result.
 *
 * A store changes memory. A call can do anything. Control flow decides what runs
 * next. A clobber and an unrepresented operation are, by construction, things
 * this analysis does not model — and something you do not model is not something
 * you may delete.
 */
const ALWAYS_OBSERVABLE = new Set(['store', 'call', 'ret', 'br', 'cbr', 'clobber', 'unknown', 'intrinsic', 'trap', 'fence', 'syscall']);

/** Operations that compute a value and do nothing else, if their facts agree. */
const PURE_CANDIDATES = new Set(['bin', 'un', 'mov', 'bfx', 'bfi', 'sel', 'const', 'phi']);

/**
 * Why this operation must be kept, or null if nothing was found.
 *
 * Every branch here answers with a reason rather than a boolean, because a
 * decision to keep an operation is evidence a reviewer has to be able to read.
 */
export function observableEffectReason(instruction) {
  const op = instruction?.op;
  if (op == null) return 'operation has no kind';
  if (ALWAYS_OBSERVABLE.has(op)) return `${op} is observable independently of its result`;

  const access = instruction.extra?.memoryAccess ?? null;
  if (access != null) {
    // A load reads memory. Removing it is only safe when its execution cannot be
    // observed: ordinary memory rather than a device, not atomic, no ordering,
    // and no possible fault. The values compared here are the Semantic IR's own
    // vocabulary — `true | false | 'unknown'` for knowledge, and
    // `relaxed | acquire | release | acq-rel | seq-cst | unknown` for ordering.
    // `unknown` is what the IR reports until something proved otherwise, and it
    // is not permission.
    if (access.addressSpace != null && access.addressSpace !== 'memory') {
      return `access is to ${access.addressSpace}, not ordinary memory`;
    }
    if (access.volatility === true) return 'the access is known to be volatile';
    if (access.atomic !== false) return `access atomicity is ${access.atomic === true ? 'yes' : 'unknown'}`;
    if (access.ordering != null && access.ordering !== 'unknown' && access.ordering !== 'relaxed') {
      return `access imposes ordering: ${access.ordering}`;
    }
    if (Array.isArray(access.faults) && access.faults.length > 0) {
      return `access can fault: ${access.faults.map((fault) => fault?.kind ?? String(fault)).join(', ')}`;
    }
  }

  if (!PURE_CANDIDATES.has(op)) return `${op} is not a modelled pure operation`;

  // A division that can trap on a zero divisor is not pure. The IR records
  // faults on the operation when it knows about them; an unrecorded fault set on
  // a trapping operator is treated as a fault.
  if (op === 'bin' && ['udiv', 'sdiv', 'urem', 'srem'].includes(instruction.sub)) {
    const faults = instruction.extra?.faults;
    if (!Array.isArray(faults) || faults.length > 0) return `${instruction.sub} can trap on a zero divisor`;
  }

  if (instruction.extra?.stateWrite != null || instruction.writesState === true) {
    return 'operation writes architectural state this analysis does not track';
  }
  return null;
}

/** Uses of a value that still exist once the given set is assumed removed. */
function liveUseCount(value, removed) {
  let live = 0;
  for (const use of value?.uses ?? []) {
    const consumerId = use?.dst?.id ?? null;
    // A use by an instruction that produces no value — a store, a branch, a
    // return — always counts: it is not going away.
    if (consumerId == null) { live += 1; continue; }
    if (!removed.has(consumerId)) live += 1;
  }
  return live;
}

/**
 * Identifies dead operations by fixed point.
 *
 * Removing one operation can make its operands dead, so the set grows until it
 * stops. The iteration is bounded by the number of values, since the set only
 * ever grows.
 */
export function runDcePass(context = {}, budget = {}, area = null) {
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const ssa = analysis?.get('ssa');
  const values = ssa?.values ?? [];
  const blocks = cfg?.blocks ?? [];
  if (area == null) throw new TypeError('phase8-dce-requires-staging-area');

  // The defining operation is read from the value itself. Walking block
  // instruction lists instead looks equivalent and is not: a value whose
  // definition is not in the list it was expected to be in simply disappears
  // from the analysis, and a dead-code pass that cannot see an operation
  // silently reports there is nothing to remove.
  const instructionOf = new Map();
  for (const value of values) if (value?.def != null) instructionOf.set(value.id, value.def);
  for (const block of blocks) {
    for (const phi of block.phis ?? []) if (phi?.dst?.id != null && !instructionOf.has(phi.dst.id)) instructionOf.set(phi.dst.id, phi);
  }

  const keptReasons = new Map();
  const removable = new Set();
  const candidates = [];
  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  // The observability half is a property of the operation alone, so it is
  // decided once rather than re-decided on every fixed-point round.
  const unobservable = new Set();
  for (const value of values) {
    const instruction = instructionOf.get(value.id);
    if (instruction == null) { keptReasons.set(value.id, 'value has no defining operation to remove'); continue; }
    const reason = observableEffectReason(instruction);
    if (reason == null) unobservable.add(value.id);
    else keptReasons.set(value.id, reason);
  }

  let budgetExhausted = false;
  let changed = true;
  let rounds = 0;
  while (changed && !budgetExhausted) {
    changed = false;
    rounds += 1;
    if (rounds > values.length + 2) break;
    for (const value of values) {
      if (abortedNow()) { budgetExhausted = true; break; }
      if (removable.has(value.id) || !unobservable.has(value.id)) continue;
      if (liveUseCount(value, removable) > 0) continue;
      removable.add(value.id);
      candidates.push({
        valueId: value.id,
        operation: `${instructionOf.get(value.id)?.op ?? '?'}/${instructionOf.get(value.id)?.sub ?? '-'}`,
        // Both halves, stated separately, because they are separate proofs.
        proof: 'the result has no remaining use, and executing the operation is unobservable: no memory write, no call, no fault, no ordering, no untracked state',
      });
      changed = true;
    }
  }

  // Values that are dead but must be kept anyway are the interesting ones: they
  // are exactly the cases where a naive "unused means removable" pass would have
  // deleted something observable.
  const deadButObservable = values
    .filter((value) => !unobservable.has(value.id) && liveUseCount(value, removable) === 0 && instructionOf.has(value.id))
    .map((value) => ({ valueId: value.id, reason: keptReasons.get(value.id) }));

  const facts = Object.freeze({
    passVersion: DCE_PASS.version,
    candidates: Object.freeze(candidates),
    deadButObservable: Object.freeze(deadButObservable),
    keptReasons,
    rounds,
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('deadCode', facts);

  const diagnostics = [];
  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.dce.budget',
      message: 'Dead-code identification stopped before reaching a fixed point.',
      reason: 'The pass was cancelled; the candidate set published is a subset of the true one, which is the safe direction.',
    });
  }
  if (deadButObservable.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.dce.kept-observable',
      message: `${deadButObservable.length} operations have no live result but were kept.`,
      reason: [...new Set(deadButObservable.map((entry) => entry.reason))].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: DCE_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['deadCode'],
    diagnostics,
    invalidated: [],
  });
}
