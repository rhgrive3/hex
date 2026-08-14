/*
 * dataflow.js — compatibility facade while the analysis engine migrates to IR/SSA.
 *
 * The historical data-flow implementation remains intact in dataflow-legacy.js.
 * Proven read/modify/write chains and constant comparisons from IR are overlaid
 * on top of those results. Unsupported cases continue through the legacy path.
 */

export * from './dataflow-legacy.js';

import {
  findValueUpdates as legacyFindValueUpdates,
  constantComparisons as legacyConstantComparisons,
  amountOf as legacyAmountOf,
  selfRegisters,
} from './dataflow-legacy.js';
import { findIrValueUpdates, mergeValueUpdates } from './dataflow-ir.js';
import { findIrConstantComparisons, mergeConstantComparisons } from './dataflow-ir-compare.js';
import { irFor, OP, MK, hasUnknownStoreBarrier } from './ir.js';

export {
  legacyFindValueUpdates as findValueUpdatesLegacy,
  legacyConstantComparisons as constantComparisonsLegacy,
  legacyAmountOf as amountOfLegacy,
};

const updateCache = new WeakMap();
function rememberUpdates(model, updates) {
  if (model && typeof model === 'object') updateCache.set(model, updates || []);
  return updates;
}

function instructionAt(ir, row, op) {
  if (!ir || row == null) return null;
  const list = ir.byRow && ir.byRow.get ? (ir.byRow.get(row) || []) :
    (ir.instructions || []).filter((i) => i.row === row);
  return list.find((i) => i.op === op) || null;
}

function filterUnsafeLegacyRmw(ir, updates) {
  if (!ir) return updates;
  return (updates || []).filter((u) => {
    if (!u || u.kind !== 'read-modify-write' || !u.from || !u.store) return true;
    const load = instructionAt(ir, u.from.row, OP.LOAD);
    const store = instructionAt(ir, u.store.row, OP.STORE);
    if (!load || !store) return true;
    return !hasUnknownStoreBarrier(ir, load, store);
  });
}

export function findValueUpdates(model, opts) {
  const legacyRaw = legacyFindValueUpdates(model, opts);

  let ir = null;
  try { ir = irFor(model, opts && opts.ir); } catch { ir = null; }
  const legacy = filterUnsafeLegacyRmw(ir, legacyRaw);

  let proven = [];
  try {
    proven = findIrValueUpdates(model, opts);
  } catch {
    return rememberUpdates(model, legacy);
  }
  proven = proven.filter((u) => !(u.location && u.location.irKind === MK.GLOBAL));
  if (!proven.length) return rememberUpdates(model, legacy);

  const self = selfRegisters(model);
  for (const u of proven) {
    if (u.location && u.location.base) {
      u.location.self = self.isSelf(u.location.base, u.store ? u.store.row : null);
    }
  }
  return rememberUpdates(model, mergeValueUpdates(legacy, proven));
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

export function constantComparisons(model, opts) {
  const legacy = legacyConstantComparisons(model);
  let proven = [];
  try { proven = findIrConstantComparisons(model, opts); } catch { return legacy; }

  /*
   * pinpointLocation currently associates generic comparisons with every location
   * candidate found in the function. A propagated SSA threshold is new evidence,
   * so do not introduce it when that function has multiple distinct candidate
   * locations and the caller has not explicitly requested scoped comparison facts.
   * Direct literals already existed in the legacy path and remain unchanged.
   */
  const cached = updateCache.get(model);
  if (!(opts && opts.allowUnscopedPropagated) && cached && distinctCandidateLocations(cached) > 1) {
    proven = proven.filter((c) => !c.propagated);
  }
  return proven.length ? mergeConstantComparisons(legacy, proven) : legacy;
}

const AMOUNT_OPS = new Set(['add', 'adds', 'sub', 'subs', 'mul', 'madd', 'msub',
  'smull', 'umull', 'sdiv', 'udiv', 'fadd', 'fsub', 'fmul', 'fdiv', 'lsl', 'lsr', 'asr']);
const CLAMP_OPS = new Set(['bic', 'csel', 'csinc', 'csneg', 'csinv', 'smax', 'smin', 'umax', 'umin']);
const DIRECT_ORIGIN = new Set(['field', 'stack', 'global', 'imm', 'call', 'arg']);

export function amountOf(model, update) {
  const legacy = legacyAmountOf(model, update);
  if (!update || update.engine !== 'ir-ssa') return legacy;

  let amount = null;
  let cappedBy = null;
  for (const step of update.steps || []) {
    const origin = step && step.otherOrigin;
    if (!cappedBy && CLAMP_OPS.has(step.op) && origin && origin.kind === 'field') {
      cappedBy = origin;
    }
    if (amount || !AMOUNT_OPS.has(step.op)) continue;
    if (origin && DIRECT_ORIGIN.has(origin.kind)) {
      amount = { op: step.op, ...origin };
    } else if (step.imm != null) {
      amount = { kind: 'imm', value: step.imm, op: step.op, row: step.row, engine: 'ir-ssa' };
    }
  }

  return {
    ...legacy,
    amount: amount || legacy.amount,
    cappedBy: cappedBy || legacy.cappedBy,
  };
}
