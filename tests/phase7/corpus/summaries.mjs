/**
 * Frozen call-graph corpus for the P7-3 summary checkpoints.
 *
 * Summaries are scored per field rather than by one opaque score, because an
 * aggregate can hide a missing write effect behind accurate register effects
 * (§17.5). Each case therefore declares, separately: which effects must be
 * present, which must be absent, what completeness is correct, and whether the
 * component is expected to converge.
 */

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';

export const SUMMARY_CORPUS_ID = 'phase7-summary-corpus';
export const SUMMARY_CORPUS_VERSION = 1;

const completeStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_summary_corpus',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const partialStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_summary_corpus',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'partial',
  stopReason: 'evidence-missing',
});

function localSummary(functionId, { calls = [], writes = [], reads = [], indirect = [], unknowns = [], status = completeStatus() } = {}) {
  return createFunctionSummary({
    functionId,
    directCalls: calls.map((target) => ({
      callSiteId: `call_${functionId}_${target}`,
      targetEntityIds: [target],
      effectSource: 'abi-rule',
    })),
    indirectCallSets: indirect.map((set, index) => ({
      callSiteId: `indirect_${functionId}_${index}`,
      candidateEntityIds: set.candidates ?? [],
      exhaustive: set.exhaustive === true,
    })),
    unknownCallEffects: unknowns,
    memoryWriteRegions: [
      ...writes.map((regionId) => ({ regionId, regionKind: 'stack-fixed', source: 'proven-summary' })),
      ...(unknowns.length ? [{ regionKind: 'unknown', broad: true, source: 'unknown-call-fallback' }] : []),
    ],
    memoryReadRegions: reads.map((regionId) => ({ regionId, regionKind: 'stack-fixed', source: 'proven-summary' })),
    noreturn: unknowns.length ? 'unknown' : false,
    mayThrow: unknowns.length ? 'unknown' : false,
    status: unknowns.length ? partialStatus() : status,
  });
}

/** A -> B -> C, no recursion. C's write must reach A. */
function acyclicChain() {
  return new Map([
    ['fn_a', localSummary('fn_a', { calls: ['fn_b'] })],
    ['fn_b', localSummary('fn_b', { calls: ['fn_c'] })],
    ['fn_c', localSummary('fn_c', { writes: ['region_leaf'] })],
  ]);
}

/** Direct self-recursion. Must converge and keep its own write. */
function selfRecursive() {
  return new Map([
    ['fn_self', localSummary('fn_self', { calls: ['fn_self'], writes: ['region_self'] })],
  ]);
}

/** Mutual recursion through two functions, with a real leaf effect below it. */
function mutualRecursion() {
  return new Map([
    ['fn_top', localSummary('fn_top', { calls: ['fn_even'] })],
    ['fn_even', localSummary('fn_even', { calls: ['fn_odd', 'fn_leaf'] })],
    ['fn_odd', localSummary('fn_odd', { calls: ['fn_even'] })],
    ['fn_leaf', localSummary('fn_leaf', { writes: ['region_leaf'] })],
  ]);
}

/** A callee the binary defines but for which no summary exists. */
function missingCalleeSummary() {
  return new Map([
    ['fn_caller', localSummary('fn_caller', { calls: ['fn_absent'] })],
  ]);
}

/** An indirect call whose candidate set is not proven exhaustive. */
function nonExhaustiveIndirect() {
  return new Map([
    ['fn_dispatch', localSummary('fn_dispatch', {
      indirect: [{ candidates: ['fn_target'], exhaustive: false }],
      unknowns: [{ callSiteId: 'indirect_fn_dispatch_0', reason: 'indirect-incomplete-target-set' }],
    })],
    ['fn_target', localSummary('fn_target', { writes: ['region_target'] })],
  ]);
}

/** An indirect call with a proven exhaustive candidate set. */
function exhaustiveIndirect() {
  return new Map([
    ['fn_dispatch_exact', localSummary('fn_dispatch_exact', {
      indirect: [{ candidates: ['fn_target'], exhaustive: true }],
    })],
    ['fn_target', localSummary('fn_target', { writes: ['region_target'] })],
  ]);
}

const GRAPHS = Object.freeze({
  'acyclic-chain': acyclicChain,
  'self-recursive': selfRecursive,
  'mutual-recursion': mutualRecursion,
  'missing-callee-summary': missingCalleeSummary,
  'non-exhaustive-indirect': nonExhaustiveIndirect,
  'exhaustive-indirect': exhaustiveIndirect,
});

export const SUMMARY_GRAPH_IDS = Object.freeze(Object.keys(GRAPHS).sort());

export function buildSummaryGraph(id) {
  if (!GRAPHS[id]) throw new TypeError(`phase7-summary-corpus-unknown-graph:${id}`);
  return GRAPHS[id]();
}

/**
 * Per-field truth for each graph.
 *
 * `mustInclude` are effects the solve is required to propagate; `mustExclude`
 * are effects it must not invent. `completeness` is scored on its own, so a
 * precise-looking summary with the wrong completeness still fails.
 */
export const SUMMARY_QUERIES = Object.freeze([
  {
    id: 's-acyclic-chain', graph: 'acyclic-chain', root: 'fn_a', functionId: 'fn_a',
    mustIncludeWrites: ['region_leaf'], mustExcludeWrites: [], mustBeBroad: false,
    completeness: 'complete', converges: true,
  },
  {
    id: 's-self-recursive', graph: 'self-recursive', root: 'fn_self', functionId: 'fn_self',
    mustIncludeWrites: ['region_self'], mustExcludeWrites: [], mustBeBroad: false,
    completeness: 'complete', converges: true,
  },
  {
    id: 's-mutual-recursion', graph: 'mutual-recursion', root: 'fn_top', functionId: 'fn_odd',
    mustIncludeWrites: ['region_leaf'], mustExcludeWrites: [], mustBeBroad: false,
    completeness: 'complete', converges: true,
  },
  {
    id: 's-missing-callee', graph: 'missing-callee-summary', root: 'fn_caller', functionId: 'fn_caller',
    mustIncludeWrites: [], mustExcludeWrites: [], mustBeBroad: true,
    completeness: 'partial', converges: true,
  },
  {
    id: 's-non-exhaustive-indirect', graph: 'non-exhaustive-indirect', root: 'fn_dispatch', functionId: 'fn_dispatch',
    mustIncludeWrites: [], mustExcludeWrites: [], mustBeBroad: true,
    completeness: 'partial', converges: true,
  },
  {
    id: 's-exhaustive-indirect', graph: 'exhaustive-indirect', root: 'fn_dispatch_exact', functionId: 'fn_dispatch_exact',
    mustIncludeWrites: ['region_target'], mustExcludeWrites: [], mustBeBroad: false,
    completeness: 'complete', converges: true,
  },
]);
