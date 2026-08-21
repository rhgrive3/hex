/**
 * P7-3b — escape analysis.
 *
 * Escape is not a boolean (FM-3). Later analysis needs to know *why* a root
 * left the function and *across which boundary*, because different separation
 * proofs survive different escapes: a pointer that was only passed to a call
 * with a proven summary is not in the same situation as one stored into a
 * global.
 *
 * The result feeds A2 through `nonEscapingRoots`, which is the one hook that
 * lets alias analysis use escape evidence without A1/A2 growing a backwards
 * dependency on a later checkpoint (§7.2).
 *
 * This module is generic. Language and runtime captures (closures, ObjC/Swift
 * runtime publication, thread handoff) arrive through the `captureProviders`
 * hook rather than being decoded here, so no target-specific knowledge enters
 * the central solver (P7-INV-007).
 */

import { deepFreeze } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../status.js';

export const ESCAPE_ANALYZER_ID = 'phase7.summary.escape';
export const ESCAPE_ANALYZER_VERSION = '1.0.0';

/** Why a root became visible outside the function. */
export const ESCAPE_REASONS = Object.freeze([
  'returned',
  'stored-to-global',
  'stored-through-argument',
  'passed-to-known-call',
  'passed-to-unknown-call',
  'captured-by-closure',
  'published-to-runtime-object',
  'published-to-thread',
  'stored-through-unknown-pointer',
  'unknown',
]);

/** Which boundary it crossed. Kept separate from the reason on purpose. */
export const ESCAPE_BOUNDARIES = Object.freeze([
  'return', 'global', 'argument', 'known-call', 'unknown-call', 'closure', 'runtime', 'thread', 'unknown',
]);

/**
 * Where a root came from.
 *
 * This matters as much as escape itself. Two roots that do not escape can only
 * be proven distinct when each was *created here* — two incoming pointer
 * parameters may alias each other no matter how little they escape.
 */
export const ROOT_ORIGINS = Object.freeze(['local-frame', 'local-allocation', 'incoming', 'global', 'unknown']);

const REASON_SET = new Set(ESCAPE_REASONS);
const BOUNDARY_SET = new Set(ESCAPE_BOUNDARIES);
const LOCALLY_CREATED = new Set(['local-frame', 'local-allocation']);

function fail(code) { throw new TypeError(code); }

export function createEscapeRecord(input = {}) {
  const reason = String(input.reason ?? '');
  const boundary = String(input.boundary ?? '');
  if (!REASON_SET.has(reason)) fail('escape-invalid-reason');
  if (!BOUNDARY_SET.has(boundary)) fail('escape-invalid-boundary');
  return deepFreeze({
    rootKey: String(input.rootKey ?? ''),
    rootOrigin: ROOT_ORIGINS.includes(input.rootOrigin) ? input.rootOrigin : 'unknown',
    reason,
    boundary,
    siteId: input.siteId == null ? null : String(input.siteId),
    evidenceIds: [...new Set((input.evidenceIds ?? []).map(String))].sort(),
  });
}

/**
 * Classifies a points-to target's root.
 *
 * The classification is derived from the canonical root kind supplied by the
 * address service, never from register names or mnemonics.
 */
export function classifyRootOrigin(target, { allocationRootKeys = new Set() } = {}) {
  if (!target) return 'unknown';
  if (allocationRootKeys.has(target.rootKey)) return 'local-allocation';
  if (target.rootKind === 'stack-like') return 'local-frame';
  if (target.rootKind === 'absolute') return 'global';
  if (target.rootKind === 'rooted') return 'incoming';
  return 'unknown';
}

function evidenceOf(node) {
  return [...(node.origin?.instructionIds ?? [])].map(String);
}

/**
 * Runs escape analysis over one function.
 *
 * Requires the A2 points-to result: escape is a question about which roots a
 * value can carry, and answering it without points-to would mean re-deriving
 * roots in a second place.
 */
export function analyzeEscape(ir, cfg, ssa, pointsToRun, options = {}) {
  const analyzerStatus = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: ESCAPE_ANALYZER_ID,
    analyzerVersion: ESCAPE_ANALYZER_VERSION,
    completeness,
    budgetClass: options.budgetClass ?? null,
    stopReason,
  });

  if (options.signal?.aborted) {
    return { escapes: [], nonEscapingRoots: new Set(), rootOrigins: new Map(), status: analyzerStatus('partial', 'cancelled') };
  }
  if (!pointsToRun || pointsToRun.status.completeness === 'unsupported') {
    // Without points-to there is no root vocabulary to reason about. The only
    // sound report is "nothing is proven non-escaping".
    return { escapes: [], nonEscapingRoots: new Set(), rootOrigins: new Map(), status: analyzerStatus('unsupported', 'dependency-missing') };
  }

  const nodes = new Map((ir.nodes ?? []).map((node) => [String(node.id), node]));
  const allocationRootKeys = new Set(options.allocationRootKeys ?? []);
  const escapes = [];
  const rootOrigins = new Map();
  const escapedRoots = new Set();
  const containment = new Map();
  let sawUnresolvedFlow = false;

  const setsFor = (valueId) => {
    const set = pointsToRun.pointsTo.get(String(valueId));
    return set ?? null;
  };

  const record = (set, { reason, boundary, siteId, evidenceIds }) => {
    if (!set) { sawUnresolvedFlow = true; return; }
    if (set.top) {
      // A value that may point anywhere carries every root out with it. There
      // is no root list to mark, so no root may be called non-escaping later.
      sawUnresolvedFlow = true;
      return;
    }
    for (const target of set.targets) {
      const origin = classifyRootOrigin(target, { allocationRootKeys });
      rootOrigins.set(target.rootKey, origin);
      escapedRoots.add(target.rootKey);
      escapes.push(createEscapeRecord({
        rootKey: target.rootKey, rootOrigin: origin, reason, boundary, siteId, evidenceIds,
      }));
    }
  };

  const observe = (set) => {
    if (!set || set.top) return;
    for (const target of set.targets) {
      if (!rootOrigins.has(target.rootKey)) {
        rootOrigins.set(target.rootKey, classifyRootOrigin(target, { allocationRootKeys }));
      }
    }
  };

  for (const node of nodes.values()) {
    for (const input of node.inputs ?? []) observe(setsFor(input));

    if (node.kind === 'return') {
      for (const input of node.inputs ?? []) {
        record(setsFor(input), { reason: 'returned', boundary: 'return', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      continue;
    }

    if (node.kind === 'store') {
      // A store publishes the *stored value's* roots wherever the *address*
      // points. The address decides the boundary.
      const storedValueId = (node.inputs ?? [])[1];
      if (storedValueId == null) continue;
      const storedSet = setsFor(storedValueId);
      if (!storedSet || storedSet.top || !storedSet.targets.length) { sawUnresolvedFlow = true; continue; }
      const addressSet = setsFor(node.memory?.addressExpr?.valueId);
      if (!addressSet || addressSet.top) {
        record(storedSet, {
          reason: 'stored-through-unknown-pointer', boundary: 'unknown', siteId: node.id, evidenceIds: evidenceOf(node),
        });
        continue;
      }
      const destinationOrigins = new Set(addressSet.targets.map((target) => classifyRootOrigin(target, { allocationRootKeys })));
      if (destinationOrigins.has('global')) {
        record(storedSet, { reason: 'stored-to-global', boundary: 'global', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      if (destinationOrigins.has('incoming')) {
        record(storedSet, { reason: 'stored-through-argument', boundary: 'argument', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      if (destinationOrigins.has('unknown')) {
        record(storedSet, { reason: 'stored-through-unknown-pointer', boundary: 'unknown', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      for (const destTarget of addressSet.targets) {
        const destOrigin = classifyRootOrigin(destTarget, { allocationRootKeys });
        if (LOCALLY_CREATED.has(destOrigin)) {
          if (!containment.has(destTarget.rootKey)) containment.set(destTarget.rootKey, new Set());
          for (const storedTarget of storedSet.targets) {
            containment.get(destTarget.rootKey).add(storedTarget.rootKey);
            observe(setsFor(storedValueId));
          }
        }
      }
      continue;
    }

    if (node.kind === 'call') {
      const complete = node.call?.completeness === 'complete';
      const reason = complete ? 'passed-to-known-call' : 'passed-to-unknown-call';
      const boundary = complete ? 'known-call' : 'unknown-call';
      const argumentValueIds = [
        ...(node.call?.arguments ?? []).map((argument) => argument?.valueId ?? argument),
        ...(node.inputs ?? []),
      ].filter((value) => value != null);
      for (const valueId of argumentValueIds) {
        record(setsFor(valueId), { reason, boundary, siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      if (!complete) sawUnresolvedFlow = true;
      continue;
    }

    if (node.kind === 'unknown-memory-effect' || node.kind === 'unknown-state-write' || node.kind === 'incomplete') {
      sawUnresolvedFlow = true;
      continue;
    }
  }

  // Language and runtime capture providers contribute additional escapes
  // without the generic solver knowing anything about their languages.
  for (const provider of options.captureProviders ?? []) {
    for (const capture of provider({ ir, cfg, ssa, pointsToRun }) ?? []) {
      const record_ = createEscapeRecord(capture);
      escapes.push(record_);
      escapedRoots.add(record_.rootKey);
      if (!rootOrigins.has(record_.rootKey)) rootOrigins.set(record_.rootKey, record_.rootOrigin);
    }
  }

  // Transitive containment propagation: if a local container escaped, any root stored into it also escapes.
  const escapeRecordsByRoot = new Map();
  for (const esc of escapes) {
    if (!escapeRecordsByRoot.has(esc.rootKey)) escapeRecordsByRoot.set(esc.rootKey, []);
    escapeRecordsByRoot.get(esc.rootKey).push(esc);
  }

  const worklist = [...escapedRoots];
  const visitedTransitive = new Set();
  while (worklist.length) {
    const currentRoot = worklist.pop();
    const children = containment.get(currentRoot);
    if (!children) continue;
    const parentEscapes = escapeRecordsByRoot.get(currentRoot) ?? [];
    for (const childRoot of children) {
      const edgeKey = `${currentRoot}->${childRoot}`;
      if (!visitedTransitive.has(edgeKey)) {
        visitedTransitive.add(edgeKey);
        const childOrigin = rootOrigins.get(childRoot) ?? 'unknown';
        for (const parentEsc of parentEscapes) {
          const childRecord = createEscapeRecord({
            rootKey: childRoot,
            rootOrigin: childOrigin,
            reason: parentEsc.reason,
            boundary: parentEsc.boundary,
            siteId: parentEsc.siteId,
            evidenceIds: parentEsc.evidenceIds,
          });
          escapes.push(childRecord);
          if (!escapeRecordsByRoot.has(childRoot)) escapeRecordsByRoot.set(childRoot, []);
          escapeRecordsByRoot.get(childRoot).push(childRecord);
        }
        if (!escapedRoots.has(childRoot)) {
          escapedRoots.add(childRoot);
          worklist.push(childRoot);
        }
      }
    }
  }

  /**
   * A root is proven non-escaping only when all three hold: it was created in
   * this function, nothing published it, and the analysis saw every flow. Any
   * unresolved flow at all voids the whole set — a value that may point
   * anywhere could have carried any root out.
   */
  const nonEscapingRoots = new Set();
  if (!sawUnresolvedFlow) {
    for (const [rootKey, origin] of rootOrigins) {
      if (LOCALLY_CREATED.has(origin) && !escapedRoots.has(rootKey)) nonEscapingRoots.add(rootKey);
    }
  }

  const pointsToComplete = pointsToRun.status.completeness === 'complete';
  const completeness = pointsToComplete && !sawUnresolvedFlow ? 'complete' : 'partial';
  return {
    escapes: deepFreeze(escapes),
    nonEscapingRoots,
    rootOrigins,
    sawUnresolvedFlow,
    status: analyzerStatus(completeness, completeness === 'complete' ? null : 'evidence-missing'),
  };
}

/**
 * Escape reasons that invalidate a separation proof which relied on a root not
 * being visible outside the function. Used by artifact invalidation so exactly
 * the affected proofs are dropped, and no more (§9.4).
 */
export function invalidatesNonEscapeProof(record) {
  return record.reason !== 'passed-to-known-call';
}
