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

/** Exposed only for regression tests and migration diagnostics. */
export { legacyFindValueUpdates as findValueUpdatesLegacy };

/**
 * Prefer SSA/Memory-SSA evidence when it exists, without throwing away the mature
 * legacy heuristics for setters, moves and instructions that the IR does not lift yet.
 */
export function findValueUpdates(model, opts) {
  const legacy = legacyFindValueUpdates(model, opts);
  let proven = [];
  try {
    proven = findIrValueUpdates(model, opts);
  } catch {
    // IR is deliberately fail-closed. A malformed/unsupported function must not
    // make the old analysis path disappear.
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
