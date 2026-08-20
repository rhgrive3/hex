/**
 * Phase 8 pass contract.
 *
 * Every Phase 8 middle-end pass — SCCP, GVN/CSE, effect-aware DCE, induction,
 * structuring, aggregate recovery, language providers — declares itself through
 * this one contract. The point is not bureaucracy: it is that an optimizer which
 * invents its own publication, cancellation and invalidation rules is an
 * optimizer nobody can prove safe afterwards (PHASE8_CHECKPOINT_CONTRACTS P8-1).
 *
 * A descriptor answers "what does this pass read, keep and destroy". A result
 * answers "what actually happened, how complete was it, and what may now be
 * reused". Both are frozen and both are validated fail-closed: an unknown stage,
 * an undeclared analysis key, or a result that claims to have changed something
 * while declaring nothing invalidated is an error at construction time rather
 * than a stale cache three passes later.
 *
 * P8-0 shipped the versioned skeleton and one identity pass through the real
 * production pipeline. P8-1 added `produces` and the staged/atomic transaction
 * in ./transaction.js. P8-2 separated producing a fact from rewriting the
 * program: an analysis pass changes the state without transforming anything, and
 * requiring it to invent a transform record would have made provenance a
 * formality. The shape is versioned so a contract change invalidates derived
 * artifacts instead of silently reinterpreting them. P8-3 added the `deadCode`
 * key; a pass that does not preserve it now invalidates it, which is the
 * conservative direction. P8-4 added `induction`, the loop/trip fact summary
 * that structuring and aggregate recovery consume instead of each deriving
 * their own. P8-7 added `providerHints`, the refinement layer's output, kept as
 * its own key so a provider version change invalidates provider-derived
 * artifacts and nothing else.
 */

/**
 * Bumped when the descriptor/result shape changes in a way that makes older
 * published Phase 8 results uninterpretable. It is part of artifact key
 * material, so a bump invalidates derived artifacts rather than silently
 * reusing them (EP-005 evidence-invalidation rule, MIGRATION_GUARDRAILS §CI).
 */
export const PHASE8_CONTRACT_VERSION = 6;

/**
 * Ordered pipeline stages. Order here is the dependency order Phase 8 accepts;
 * it is a declared contract rather than the incidental order of an array
 * literal, which is what the P8-1 merge blockers explicitly reject.
 */
export const PASS_STAGES = Object.freeze([
  'canonical-facts',
  'scalar-optimization',
  'memory-optimization',
  'loop-facts',
  'high-level-recovery',
  'structuring',
  'providers',
  'rendering',
]);

/**
 * Analyses a pass may declare it consumes, preserves or invalidates. Anything
 * outside this set is a typo or an undeclared dependency; both are errors.
 */
export const ANALYSIS_KEYS = Object.freeze([
  'cfg',
  'dominators',
  'loops',
  'ssa',
  'memorySsa',
  'alias',
  'effects',
  'ranges',
  'valueNumbers',
  'deadCode',
  'induction',
  'types',
  'aggregates',
  'summaries',
  'origins',
  'structuredRegions',
  'providerHints',
]);

/** What a pass run did. `unsupported` is a first-class answer, never skip-green. */
export const PASS_STATUSES = Object.freeze(['unchanged', 'changed', 'degraded', 'unsupported']);

/** How complete the pass's own reasoning was. Budget truncation is `partial`. */
export const COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown']);

/** Budget classes. A pass declares the cost class it belongs to up front. */
export const BUDGET_CLASSES = Object.freeze(['interactive', 'standard', 'exhaustive']);

const STAGE_SET = new Set(PASS_STAGES);
const ANALYSIS_SET = new Set(ANALYSIS_KEYS);
const STATUS_SET = new Set(PASS_STATUSES);
const COMPLETENESS_SET = new Set(COMPLETENESS);
const BUDGET_SET = new Set(BUDGET_CLASSES);

function fail(code) { throw new TypeError(code); }

function nonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function analysisList(values, code) {
  if (values == null) return Object.freeze([]);
  if (!Array.isArray(values)) fail(code);
  const unique = [...new Set(values)];
  for (const key of unique) {
    if (typeof key !== 'string' || !ANALYSIS_SET.has(key)) fail(`${code}:${String(key)}`);
  }
  return Object.freeze(unique.sort());
}

function diagnosticList(values) {
  if (values == null) return Object.freeze([]);
  if (!Array.isArray(values)) fail('phase8-pass-diagnostics-invalid');
  return Object.freeze(values.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('phase8-pass-diagnostic-invalid');
    return Object.freeze({
      severity: nonEmptyString(item.severity, 'phase8-pass-diagnostic-severity-required'),
      code: nonEmptyString(item.code, 'phase8-pass-diagnostic-code-required'),
      message: nonEmptyString(item.message, 'phase8-pass-diagnostic-message-required'),
      // Why the pass could not do better. A missed optimization with no reason
      // recorded is indistinguishable from a pass that never ran.
      reason: item.reason == null ? null : String(item.reason),
    });
  }));
}

function transformList(values) {
  if (values == null) return Object.freeze([]);
  if (!Array.isArray(values)) fail('phase8-pass-transforms-invalid');
  return Object.freeze(values.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('phase8-pass-transform-invalid');
    return Object.freeze({
      kind: nonEmptyString(item.kind, 'phase8-pass-transform-kind-required'),
      // Provenance is not optional. A transform that cannot say which semantic
      // entities it rewrote cannot be audited, and Phase 8's hard-zero exit gate
      // is `provenanceLossCount = 0`.
      targets: Object.freeze([...new Set(
        (Array.isArray(item.targets) && item.targets.length > 0
          ? item.targets
          : fail('phase8-pass-transform-targets-required'))
          .map((target) => nonEmptyString(target, 'phase8-pass-transform-target-invalid')),
      )].sort()),
      proof: nonEmptyString(item.proof, 'phase8-pass-transform-proof-required'),
      originRefs: Object.freeze([...new Set(
        (item.originRefs ?? []).map((ref) => nonEmptyString(ref, 'phase8-pass-transform-origin-invalid')),
      )].sort()),
    });
  }));
}

/**
 * Declares one Phase 8 pass.
 *
 * `preserves` and `invalidates` must be disjoint: a pass that claims to both
 * keep and destroy an analysis has not decided what it does, and downstream
 * reuse would depend on which check ran first.
 */
export function createPassDescriptor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('phase8-pass-descriptor-invalid');
  const id = nonEmptyString(input.id, 'phase8-pass-id-required');
  const version = nonEmptyString(input.version, 'phase8-pass-version-required');
  const stage = nonEmptyString(input.stage, 'phase8-pass-stage-required');
  if (!STAGE_SET.has(stage)) fail(`phase8-pass-unknown-stage:${stage}`);
  const budgetClass = input.budgetClass ?? 'standard';
  if (!BUDGET_SET.has(budgetClass)) fail(`phase8-pass-unknown-budget-class:${budgetClass}`);
  const consumes = analysisList(input.consumes, 'phase8-pass-unknown-consumed-analysis');
  const preserves = analysisList(input.preserves, 'phase8-pass-unknown-preserved-analysis');
  const invalidates = analysisList(input.invalidates, 'phase8-pass-unknown-invalidated-analysis');
  const produces = analysisList(input.produces, 'phase8-pass-unknown-produced-analysis');
  for (const key of invalidates) {
    if (preserves.includes(key)) fail(`phase8-pass-preserves-and-invalidates:${key}`);
  }
  // Producing an analysis and preserving it are contradictory claims: the
  // consumer cannot both keep its cached version and receive a new one.
  for (const key of produces) {
    if (preserves.includes(key)) fail(`phase8-pass-preserves-and-produces:${key}`);
  }
  return Object.freeze({
    contractVersion: PHASE8_CONTRACT_VERSION,
    id,
    version,
    stage,
    stageIndex: PASS_STAGES.indexOf(stage),
    budgetClass,
    consumes,
    preserves,
    invalidates,
    // Analyses this pass writes. The transaction refuses a staged write to
    // anything not declared here, so an undeclared production cannot become an
    // undeclared dependency for everything downstream.
    produces,
    // A pass that must run even under an exhausted budget so the public result
    // stays structurally valid. Optional passes are skipped instead.
    required: input.required === true,
    description: input.description == null ? '' : String(input.description),
  });
}

/**
 * Records what one pass run produced.
 *
 * `changed` and `status` are kept consistent here rather than by convention:
 * a `changed` status with no invalidated analyses and no transforms is the exact
 * shape that produces a stale downstream fact, so it is rejected.
 */
export function createPassResult(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('phase8-pass-result-invalid');
  const descriptor = input.descriptor;
  if (!descriptor || descriptor.contractVersion !== PHASE8_CONTRACT_VERSION) fail('phase8-pass-result-descriptor-required');
  const status = nonEmptyString(input.status, 'phase8-pass-result-status-required');
  if (!STATUS_SET.has(status)) fail(`phase8-pass-result-unknown-status:${status}`);
  const completeness = input.completeness ?? 'complete';
  if (!COMPLETENESS_SET.has(completeness)) fail(`phase8-pass-result-unknown-completeness:${completeness}`);
  const transforms = transformList(input.transforms);
  const diagnostics = diagnosticList(input.diagnostics);
  const invalidated = analysisList(input.invalidated, 'phase8-pass-result-unknown-invalidated-analysis');
  for (const key of invalidated) {
    if (!descriptor.invalidates.includes(key)) fail(`phase8-pass-result-undeclared-invalidation:${key}`);
  }
  const produced = analysisList(input.produced, 'phase8-pass-result-unknown-produced-analysis');
  for (const key of produced) {
    if (!descriptor.produces.includes(key)) fail(`phase8-pass-result-undeclared-production:${key}`);
  }
  const changed = status === 'changed' || status === 'degraded' ? input.changed !== false : input.changed === true;
  // A change has to be accounted for by something: a program transformation or a
  // produced analysis. These are different things. An analysis pass that proved
  // nothing still changed the state — "SCCP ran and found nothing" is not the
  // same fact as "SCCP never ran" — and forcing it to file a transform record
  // with no target would turn provenance into a formality.
  if (changed && transforms.length === 0 && produced.length === 0) fail('phase8-pass-result-changed-without-transform-or-production');
  if (!changed && transforms.length > 0) fail('phase8-pass-result-transform-without-change');
  if (!changed && produced.length > 0) fail('phase8-pass-result-production-without-change');
  if (status === 'unchanged' && invalidated.length > 0) fail('phase8-pass-result-unchanged-invalidates');
  if (status === 'unsupported' && completeness === 'complete') fail('phase8-pass-result-unsupported-claims-complete');
  return Object.freeze({
    contractVersion: PHASE8_CONTRACT_VERSION,
    passId: descriptor.id,
    passVersion: descriptor.version,
    stage: descriptor.stage,
    status,
    changed,
    completeness,
    transforms,
    diagnostics,
    invalidated,
    produced,
    // Analyses that survive this pass, derived from the declaration rather than
    // restated by the pass body, so the two cannot drift.
    preserved: descriptor.preserves,
    stopReason: input.stopReason == null ? null : nonEmptyString(input.stopReason, 'phase8-pass-result-stop-reason-invalid'),
  });
}

/** The common "this pass looked and had nothing safe to do" answer. */
export function unchangedResult(descriptor, { completeness = 'complete', diagnostics = [], stopReason = null } = {}) {
  return createPassResult({ descriptor, status: 'unchanged', changed: false, completeness, diagnostics, stopReason });
}
