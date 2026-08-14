/*
 * dataflow.js — compatibility facade while the analysis engine migrates to IR/SSA.
 *
 * The historical data-flow implementation remains intact in dataflow-legacy.js.
 * Proven read/modify/write chains from ir.js are overlaid on top of those results.
 * Anything the IR cannot prove falls back to the legacy implementation, so callers
 * (pinpoint / verify / purpose / panels) keep the same API during the migration.
 */

export * from './dataflow-legacy.js';

import {
  findValueUpdates as legacyFindValueUpdates,
  selfRegisters,
} from './dataflow-legacy.js';
import { findIrValueUpdates, mergeValueUpdates } from './dataflow-ir.js';
import { irFor, OP, hasUnknownStoreBarrier } from './ir.js';

/** Exposed only for regression tests and migration diagnostics. */
export { legacyFindValueUpdates as findValueUpdatesLegacy };

function instructionAt(ir, row, op) {
  if (!ir || row == null) return null;
  const list = ir.byRow && ir.byRow.get ? (ir.byRow.get(row) || []) :
    (ir.instructions || []).filter((i) => i.row === row);
  return list.find((i) => i.op === op) || null;
}

/**
 * Legacy RMW heuristics are useful while migration is incomplete, but they must
 * not resurrect a claim that the newer alias model can explicitly disprove.
 * Suppression is intentionally narrow: only a legacy RMW with mappable IR load
 * and store endpoints is removed, and only when an unknown store may alias them.
 */
function filterUnsafeLegacyRmw(ir, updates) {
  if (!ir) return updates;
  return (updates || []).filter((u) => {
    if (!u || u.kind !== 'read-modify-write' || !u.from || !u.store) return true;
    const load = instructionAt(ir, u.from.row, OP.LOAD);
    const store = instructionAt(ir, u.store.row, OP.STORE);
    if (!load || !store) return true; // no IR correspondence: preserve legacy behavior
    return !hasUnknownStoreBarrier(ir, load, store);
  });
}

/**
 * Prefer SSA/Memory-SSA evidence when it exists, without throwing away the mature
 * legacy heuristics for setters, moves and instructions that the IR does not lift yet.
 */
export function findValueUpdates(model, opts) {
  const legacyRaw = legacyFindValueUpdates(model, opts);

  let ir = null;
  try { ir = irFor(model, opts && opts.ir); } catch { ir = null; }
  const legacy = filterUnsafeLegacyRmw(ir, legacyRaw);

  let proven = [];
  try {
    proven = findIrValueUpdates(model, opts);
  } catch {
    // If IR construction succeeded, keep its explicit safety vetoes even when
    // the adapter itself cannot produce a replacement result.
    return legacy;
  }
  if (!proven.length) return legacy;

  const self = selfRegisters(model);
  for (const u of proven) {
    if (u.location && u.location.base) {
      u.location.self = self.isSelf(u.location.base, u.store ? u.store.row : null);
    }
  }
  return mergeValueUpdates(legacy, proven);
}
