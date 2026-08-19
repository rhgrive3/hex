/**
 * P7-3a — FunctionSummary contract.
 *
 * A summary is immutable derived analysis about what a function does to state
 * and memory. Every consumer of call effects reads one of these rather than
 * re-deriving effects at the call site, so the shape has to make the dangerous
 * case impossible to spell.
 *
 * The dangerous case is P7-INV-004: a missing, stale, partial, cancelled or
 * identity-mismatched summary must never be equivalent to purity. So this
 * contract refuses to build a summary that claims no memory effects while also
 * admitting it did not resolve every call — `unknownCallEffects` and
 * `completeness: 'complete'` cannot coexist.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus } from '../status.js';

export const FUNCTION_SUMMARY_SCHEMA_VERSION = 1;
export const FUNCTION_SUMMARY_CONTRACT_VERSION = '1.0.0';

/**
 * Where an effect's authority comes from, in the priority order P7-INV-004
 * fixes: a proven summary beats a versioned library model, which beats an
 * ABI/runtime rule, which beats the conservative unknown-call fallback.
 */
export const EFFECT_SOURCES = Object.freeze([
  'proven-summary',
  'library-model',
  'abi-rule',
  'unknown-call-fallback',
]);

export const UNKNOWN_CALL_REASONS = Object.freeze([
  'unresolved-target',
  'indirect-incomplete-target-set',
  'summary-missing',
  'summary-stale',
  'summary-incomplete',
  'summary-cancelled',
  'library-model-missing',
  'recursion-unconverged',
]);

const SOURCE_SET = new Set(EFFECT_SOURCES);
const REASON_SET = new Set(UNKNOWN_CALL_REASONS);

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function list(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return values;
}

function sortedIds(values, code) {
  return [...new Set(list(values, code).map((value) => nonEmpty(value, code)))].sort();
}

function booleanKnowledge(value, code) {
  if (value === true || value === false || value === 'unknown') return value;
  fail(code);
  return null;
}

/** One memory region a function reads or writes, with why we believe it. */
export function createMemoryEffect(input = {}) {
  const source = nonEmpty(input.source ?? 'proven-summary', 'function-summary-effect-source-required');
  if (!SOURCE_SET.has(source)) fail('function-summary-invalid-effect-source');
  return deepFreeze({
    regionId: input.regionId == null ? null : nonEmpty(input.regionId, 'function-summary-invalid-region-id'),
    regionKind: nonEmpty(input.regionKind ?? 'unknown', 'function-summary-invalid-region-kind'),
    // A `broad` effect covers every region in its address spaces. It is what an
    // unresolved call contributes, and it is deliberately not expressible as a
    // list of specific regions.
    broad: input.broad === true,
    addressSpaces: sortedIds(input.addressSpaces, 'function-summary-invalid-address-spaces'),
    source,
    evidenceIds: sortedIds(input.evidenceIds, 'function-summary-invalid-evidence-ids'),
  });
}

/** A call whose effects could not be resolved. Never silently dropped. */
export function createUnknownCallEffect(input = {}) {
  const reason = nonEmpty(input.reason, 'function-summary-unknown-call-reason-required');
  if (!REASON_SET.has(reason)) fail('function-summary-invalid-unknown-call-reason');
  return deepFreeze({
    callSiteId: nonEmpty(input.callSiteId, 'function-summary-unknown-call-site-required'),
    reason,
    targetEntityIds: sortedIds(input.targetEntityIds, 'function-summary-invalid-target-ids'),
    evidenceIds: sortedIds(input.evidenceIds, 'function-summary-invalid-evidence-ids'),
  });
}

export function createDirectCall(input = {}) {
  return deepFreeze({
    callSiteId: nonEmpty(input.callSiteId, 'function-summary-call-site-required'),
    targetEntityIds: sortedIds(input.targetEntityIds, 'function-summary-invalid-target-ids'),
    summaryId: input.summaryId == null ? null : nonEmpty(input.summaryId, 'function-summary-invalid-summary-id'),
    effectSource: (() => {
      const source = nonEmpty(input.effectSource ?? 'unknown-call-fallback', 'function-summary-effect-source-required');
      if (!SOURCE_SET.has(source)) fail('function-summary-invalid-effect-source');
      return source;
    })(),
  });
}

export function createIndirectCallSet(input = {}) {
  return deepFreeze({
    callSiteId: nonEmpty(input.callSiteId, 'function-summary-call-site-required'),
    candidateEntityIds: sortedIds(input.candidateEntityIds, 'function-summary-invalid-target-ids'),
    // A candidate set that is not proven exhaustive contributes unknown-call
    // effects on top of its candidates. Averaging the candidates and calling it
    // the answer is exactly the mistake §9.4 names.
    exhaustive: input.exhaustive === true,
    evidenceIds: sortedIds(input.evidenceIds, 'function-summary-invalid-evidence-ids'),
  });
}

/**
 * Builds one function summary.
 *
 * The consistency checks at the end are the contract's whole point: they make
 * "we did not look" structurally distinguishable from "there is nothing there".
 */
export function createFunctionSummary(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('function-summary-invalid');
  const status = input.status?.schemaVersion ? input.status : createAnalysisStatus(input.status ?? {});

  const unknownCallEffects = list(input.unknownCallEffects, 'function-summary-invalid-unknown-calls').map(createUnknownCallEffect);
  const memoryReadRegions = list(input.memoryReadRegions, 'function-summary-invalid-read-regions').map(createMemoryEffect);
  const memoryWriteRegions = list(input.memoryWriteRegions, 'function-summary-invalid-write-regions').map(createMemoryEffect);

  const summary = {
    schemaVersion: FUNCTION_SUMMARY_SCHEMA_VERSION,
    contractVersion: FUNCTION_SUMMARY_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'function-summary-function-id-required'),
    inputs: sortedIds(input.inputs, 'function-summary-invalid-inputs'),
    returnValues: sortedIds(input.returnValues, 'function-summary-invalid-return-values'),
    registerEffects: sortedIds(input.registerEffects, 'function-summary-invalid-register-effects'),
    memoryReadRegions: deepFreeze(memoryReadRegions),
    memoryWriteRegions: deepFreeze(memoryWriteRegions),
    escapes: deepFreeze(list(input.escapes, 'function-summary-invalid-escapes')),
    allocations: sortedIds(input.allocations, 'function-summary-invalid-allocations'),
    frees: sortedIds(input.frees, 'function-summary-invalid-frees'),
    directCalls: deepFreeze(list(input.directCalls, 'function-summary-invalid-direct-calls').map(createDirectCall)),
    indirectCallSets: deepFreeze(list(input.indirectCallSets, 'function-summary-invalid-indirect-calls').map(createIndirectCallSet)),
    unknownCallEffects: deepFreeze(unknownCallEffects),
    noreturn: booleanKnowledge(input.noreturn ?? 'unknown', 'function-summary-invalid-noreturn'),
    mayThrow: booleanKnowledge(input.mayThrow ?? 'unknown', 'function-summary-invalid-may-throw'),
    stackDelta: input.stackDelta == null ? null : String(input.stackDelta),
    semanticFacts: deepFreeze(list(input.semanticFacts, 'function-summary-invalid-semantic-facts')),
    status,
  };

  // An unresolved call is not purity. A summary that carries one may not also
  // claim it looked at everything.
  if (unknownCallEffects.length > 0 && isCompleteStatus(status)) {
    fail('function-summary-unknown-call-cannot-be-complete');
  }
  // ...and it must actually contribute a broad effect, or downstream code that
  // reads only the region lists would treat the call as harmless.
  if (unknownCallEffects.length > 0
    && !memoryWriteRegions.some((effect) => effect.broad)) {
    fail('function-summary-unknown-call-requires-broad-write-effect');
  }
  if (unknownCallEffects.length > 0 && summary.noreturn !== 'unknown' && summary.mayThrow !== 'unknown') {
    // Control-flow facts are as unresolvable as memory facts when the callee is
    // unknown; claiming both are settled contradicts the unresolved call.
    fail('function-summary-unknown-call-cannot-settle-control-facts');
  }
  const nonExhaustiveIndirect = summary.indirectCallSets.some((set) => !set.exhaustive);
  if (nonExhaustiveIndirect && unknownCallEffects.length === 0) {
    fail('function-summary-nonexhaustive-indirect-requires-unknown-effect');
  }

  return deepFreeze(summary);
}

/** Stable identity for dependency edges between caller and callee summaries. */
export function functionSummaryDigest(summary) {
  return stableDigest({
    schemaVersion: summary.schemaVersion,
    functionId: summary.functionId,
    memoryReadRegions: summary.memoryReadRegions,
    memoryWriteRegions: summary.memoryWriteRegions,
    escapes: summary.escapes,
    directCalls: summary.directCalls,
    indirectCallSets: summary.indirectCallSets,
    unknownCallEffects: summary.unknownCallEffects,
    noreturn: summary.noreturn,
    mayThrow: summary.mayThrow,
    stackDelta: summary.stackDelta,
    completeness: summary.status.completeness,
    analyzerVersion: summary.status.analyzerVersion,
  });
}

/**
 * The only sanctioned way to ask "does this function write memory I care
 * about?". It answers `true` whenever the summary cannot prove otherwise,
 * which is what keeps an incomplete summary from reading as pure.
 */
export function summaryMayWriteRegion(summary, regionId) {
  if (!summary) return true;
  if (!isCompleteStatus(summary.status)) return true;
  if (summary.unknownCallEffects.length > 0) return true;
  if (summary.memoryWriteRegions.some((effect) => effect.broad)) return true;
  if (regionId == null) return summary.memoryWriteRegions.length > 0;
  return summary.memoryWriteRegions.some((effect) => effect.regionId === regionId);
}

export function summaryIsPure(summary) {
  return isCompleteStatus(summary?.status)
    && summary.unknownCallEffects.length === 0
    && summary.memoryWriteRegions.length === 0
    && summary.memoryReadRegions.length === 0
    && summary.escapes.length === 0;
}
