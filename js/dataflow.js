/*
 * dataflow.js — stable compatibility API over Semantic IR facts.
 *
 * Semantic IR / SSA / Memory SSA is the primary and only semantic producer when
 * an IR can be built. dataflow-legacy.js remains exported for old callers and is
 * used only when IR construction itself is unavailable.
 */

export * from './dataflow-legacy.js';

import {
  findValueUpdates as legacyFindValueUpdates,
  constantComparisons as legacyConstantComparisons,
  amountOf as legacyAmountOf,
  selfRegisters,
} from './dataflow-legacy.js';
import { findIrValueUpdates } from './dataflow-ir.js';
import { findIrSemanticUpdates } from './dataflow-semantic.js';
import { findIrConstantComparisons } from './dataflow-ir-compare.js';
import { irFor, MK, pointerProvenance } from './ir.js';

export {
  legacyFindValueUpdates as findValueUpdatesLegacy,
  legacyConstantComparisons as constantComparisonsLegacy,
  legacyAmountOf as amountOfLegacy,
};

const updateCache = new WeakMap();
function isDefaultUpdateQuery(opts) {
  return opts == null || Object.keys(opts).length === 0;
}
function rememberUpdates(model, updates, opts) {
  if (isDefaultUpdateQuery(opts) && model && typeof model === 'object') updateCache.set(model, updates || []);
  return updates;
}

function selfFromIr(update) {
  if (!update || !update.ir) return false;
  const loc = update.ir.location || update.ir.store && update.ir.store.loc || update.ir.load && update.ir.load.loc;
  if (!loc || loc.kind !== MK.FIELD || !loc.base) return !!(update.location && update.location.self);
  const p = pointerProvenance(loc.base);
  return !!(p && p.root === 'arg:x0' && p.must !== false);
}

/** Which engine produced the semantic answer. Useful for diagnostics/tests. */
export function dataflowEngine(model, opts) {
  try { return irFor(model, opts && opts.ir) ? 'semantic-ir' : 'legacy-fallback'; }
  catch { return 'legacy-fallback'; }
}

export function findValueUpdates(model, opts) {
  let ir = null;
  try { ir = irFor(model, opts && opts.ir); } catch { ir = null; }
  if (!ir) return rememberUpdates(model, legacyFindValueUpdates(model, opts), opts);

  let rmw = [];
  let direct = [];
  try {
    rmw = findIrValueUpdates(model, opts).filter((u) => !(u.location && u.location.irKind === MK.GLOBAL));
    direct = findIrSemanticUpdates(model, opts, rmw)
      .filter((u) => !(u.location && u.location.irKind === MK.GLOBAL));
  } catch {
    // IR existed but a consumer adapter failed. Do not silently replace a proven
    // semantic model with a different heuristic truth; expose the safe subset.
    return rememberUpdates(model, rmw, opts);
  }

  const out = [...rmw, ...direct];
  for (const u of out) {
    if (u.location) u.location.self = u.location.self || selfFromIr(u);
  }
  out.sort((a, b) => b.confidence - a.confidence ||
    ((a.store && a.store.row) || 0) - ((b.store && b.store.row) || 0));
  return rememberUpdates(model, out, opts);
}

function distinctCandidateLocations(updates) {
  const keys = new Set();
  for (const u of updates || []) {
    const loc = u && u.location;
    if (!loc || loc.stack || loc.key == null) continue;
    keys.add(String(loc.key));
    if (keys.size > 1) break;
  }
  return keys.size;
}

function comparisonContextUpdates(model, opts) {
  if (!model || typeof model !== 'object') return [];
  if (opts && opts.ir) {
    try { return findValueUpdates(model, { ir: opts.ir }); } catch { return []; }
  }
  const cached = updateCache.get(model);
  if (cached) return cached;
  try { return findValueUpdates(model); } catch { return []; }
}

export function constantComparisons(model, opts) {
  let ir = null;
  try { ir = irFor(model, opts && opts.ir); } catch { ir = null; }
  if (!ir) return legacyConstantComparisons(model);

  let proven = [];
  try { proven = findIrConstantComparisons(model, opts); } catch { return []; }
  if (!(opts && opts.allowUnscopedPropagated)) {
    const context = comparisonContextUpdates(model, opts);
    if (distinctCandidateLocations(context) > 1) proven = proven.filter((c) => !c.propagated);
  }
  return proven;
}

const AMOUNT_OPS = new Set(['add', 'adds', 'sub', 'subs', 'mul', 'madd', 'msub',
  'smull', 'umull', 'sdiv', 'udiv', 'fadd', 'fsub', 'fmul', 'fdiv', 'lsl', 'lsr', 'asr']);
const CLAMP_OPS = new Set(['bic', 'csel', 'csinc', 'csneg', 'csinv', 'smax', 'smin', 'umax', 'umin']);
const SCALE_OPS = new Set(['mul', 'madd', 'msub', 'smull', 'umull', 'sdiv', 'udiv',
  'fmul', 'fdiv', 'lsl', 'lsr', 'asr']);
const DIRECT_ORIGIN = new Set(['field', 'stack', 'global', 'imm', 'call', 'arg']);

export function amountOf(model, update) {
  if (!update || (update.engine !== 'ir-ssa' && update.engine !== 'ir-semantic')) {
    return legacyAmountOf(model, update);
  }

  let amount = null;
  let cappedBy = null;
  let clamped = false;
  let scaled = false;
  const ops = [];
  for (const step of update.steps || []) {
    if (!step || !step.op) continue;
    ops.push(step.op);
    const origin = step.otherOrigin;
    if (CLAMP_OPS.has(step.op)) {
      clamped = true;
      if (!cappedBy && origin && origin.kind === 'field') cappedBy = origin;
    }
    if (SCALE_OPS.has(step.op)) scaled = true;
    if (amount || !AMOUNT_OPS.has(step.op)) continue;
    const operandSide = step.sourceOperandIndex == null ? {} : {
      sourceOperandIndex: step.sourceOperandIndex,
      sourceOnLeft: step.sourceOnLeft === true,
    };
    if (origin && DIRECT_ORIGIN.has(origin.kind)) amount = { op: step.op, ...origin, ...operandSide };
    else if (step.imm != null) amount = { kind: 'imm', value: step.imm, op: step.op, row: step.row, engine: 'ir-ssa', ...operandSide };
  }
  return { amount, clamped, scaled, cappedBy, ops };
}

/* Low-level compatibility utility. It is not a semantic producer. */
export { selfRegisters };
