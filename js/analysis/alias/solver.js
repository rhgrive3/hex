/**
 * Canonical Phase 7 alias solver.
 *
 * One entry point, layered:
 *
 *   A1 (region identity)  →  A2 (field-sensitive points-to)  →  reconcile
 *
 * A2 may only *strengthen* A1's answer, and only when the two do not
 * contradict each other. A contradiction — one side proving separation while
 * the other proves identity — means at least one input is wrong, so the solver
 * returns `unknown` rather than picking whichever answer is more useful. That
 * rule is what stops a precision bug in one layer from becoming a soundness bug
 * in the product.
 *
 * This module is the only thing wired into MemorySSA's `queryAlias` seam.
 * Consumers that want a stronger answer ask here; nobody gets a private path.
 */

import { createAnalysisStatus, mergeAnalysisStatus } from '../status.js';
import { analyzeLocalPointsTo } from '../pointsto/local.js';
import { pointsToAlias } from '../pointsto/alias.js';
import { analyzeEscape } from '../summary/escape.js';
import { a1RegionAlias } from './a1-region-alias.js';
import { createAliasResult, unknownAlias } from './result.js';

export const PHASE7_ALIAS_SOLVER_ID = 'phase7.alias.solver';
export const PHASE7_ALIAS_SOLVER_VERSION = '1.0.0';

const STRENGTH = { unknown: 0, may: 1, must: 2, no: 2 };

function contradicts(left, right) {
  if (left === 'no' && right === 'must') return true;
  if (left === 'must' && right === 'no') return true;
  return false;
}

/**
 * The status every answer from this solver starts from.
 *
 * Cancellation is checked here rather than only inside the fixed point,
 * because A1 can answer a question without ever running A2 — and a cancelled
 * caller must not receive a `complete` status just because the cheap layer
 * happened to have an answer ready (P7-INV-010).
 */
function baseStatus(options) {
  if (options.status) return options.status;
  const cancelled = options.signal?.aborted === true;
  return createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: PHASE7_ALIAS_SOLVER_ID,
    analyzerVersion: PHASE7_ALIAS_SOLVER_VERSION,
    completeness: cancelled ? 'partial' : 'complete',
    budgetClass: options.budgetClass ?? null,
    stopReason: cancelled ? 'cancelled' : null,
  });
}

/**
 * Creates a solver bound to one function's semantic artifacts.
 *
 * The A2 fixed point runs once per function and is reused for every alias
 * question about it — demand-driven per P7-INV-009, not a whole-program solve.
 */
export function createPhase7AliasSolver({ ir, cfg, ssa, options = {} } = {}) {
  let pointsToRun = null;
  let escapeRun = null;
  const enableA2 = options.enableA2 !== false && ir != null;
  const enableEscape = options.enableEscape !== false && enableA2;

  function pointsTo() {
    if (!enableA2) return null;
    if (pointsToRun == null) {
      pointsToRun = analyzeLocalPointsTo(ir, cfg, ssa, options);
    }
    return pointsToRun;
  }

  /**
   * Escape evidence, computed on demand from the same points-to run.
   *
   * A1/A2 do not depend on escape to satisfy their own contracts — this is the
   * later refinement §7.2 allows, layered on top rather than folded backwards
   * into the earlier checkpoints.
   */
  function escape() {
    if (!enableEscape) return null;
    if (escapeRun == null) {
      const run = pointsTo();
      escapeRun = run == null ? null : analyzeEscape(ir, cfg, ssa, run, options);
    }
    return escapeRun;
  }

  function nonEscapingRoots() {
    if (options.nonEscapingRoots) return options.nonEscapingRoots;
    return escape()?.nonEscapingRoots ?? new Set();
  }

  function setFor(addressValueId) {
    if (addressValueId == null) return null;
    const run = pointsTo();
    if (!run) return null;
    return run.pointsTo.get(String(addressValueId)) ?? null;
  }

  /**
   * Answers one alias question.
   *
   * `leftAccess`/`rightAccess` are the semantic memory accesses when the caller
   * has them. Without them only A1 runs, which is correct but coarser — region
   * identity alone cannot see field offsets.
   */
  function alias(leftRegion, rightRegion, context = {}) {
    const status = baseStatus({ signal: options.signal, ...options, ...context });
    if (status.stopReason != null && status.completeness !== 'bounded') {
      return unknownAlias(status, ['budget-exhausted']);
    }

    const a1 = a1RegionAlias(leftRegion, rightRegion, { ...options, status });
    const leftAccess = context.leftAccess ?? null;
    const rightAccess = context.rightAccess ?? null;
    if (!enableA2 || !leftAccess || !rightAccess) return a1;

    const leftSet = setFor(leftAccess.addressValueId);
    const rightSet = setFor(rightAccess.addressValueId);
    if (!leftSet || !rightSet) return a1;

    const run = pointsTo();
    const a2Status = mergeAnalysisStatus(status, run.status);
    const a2 = pointsToAlias(leftSet, rightSet, {
      status: a2Status,
      widthBitsLeft: leftAccess.widthBits,
      widthBitsRight: rightAccess.widthBits,
      nonEscapingRoots: nonEscapingRoots(),
    });

    if (contradicts(a1.relation, a2.relation)) {
      return unknownAlias(a2Status, ['unresolved-root'], {
        regionIds: a1.regionIds,
        proof: { conflict: { a1: a1.relation, a2: a2.relation } },
      });
    }
    if (STRENGTH[a2.relation] > STRENGTH[a1.relation]) {
      return createAliasResult({
        relation: a2.relation,
        reasonCodes: a2.reasonCodes,
        evidenceIds: [...a1.evidenceIds, ...a2.evidenceIds],
        regionIds: a1.regionIds,
        status: a2Status,
        proof: { layer: 'a2', a1: a1.relation, detail: a2.proof },
      });
    }
    return a1;
  }

  /** MemorySSA `queryAlias` provider. */
  function queryAlias(leftRegion, rightRegion, memorySsaContext = {}) {
    const result = alias(leftRegion, rightRegion, {
      leftAccess: memorySsaContext.left?.descriptor?.memory ?? null,
      rightAccess: memorySsaContext.right?.descriptor?.memory ?? null,
    });
    return {
      relation: result.relation,
      reasonCodes: result.reasonCodes,
      evidenceIds: result.evidenceIds,
      proof: {
        analyzerId: PHASE7_ALIAS_SOLVER_ID,
        analyzerVersion: PHASE7_ALIAS_SOLVER_VERSION,
        completeness: result.status.completeness,
        stopReason: result.status.stopReason,
        reasonCodes: result.reasonCodes,
      },
    };
  }

  return Object.freeze({
    alias,
    queryAlias,
    pointsToRun: pointsTo,
    escapeRun: escape,
    analyzerId: PHASE7_ALIAS_SOLVER_ID,
    analyzerVersion: PHASE7_ALIAS_SOLVER_VERSION,
  });
}
