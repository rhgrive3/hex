/**
 * Phase 8 vertical runner.
 *
 * This is the one place Phase 8 passes are executed and published. Passes never
 * write to the decompiler state themselves: they return results, and this runner
 * publishes them as a single frozen ledger or publishes nothing at all.
 *
 * Publication is all-or-nothing on purpose. The current `PassManager` merges each
 * pass's return value into shared state as it goes, which is fine for the
 * representation passes it was written for but is exactly how a cancelled or
 * failed optimizer leaves half-transformed facts behind (PHASE8_CHECKPOINT_CONTRACTS
 * P8-1 merge blockers). P8-0 establishes the boundary with one identity pass;
 * P8-1 extends the same boundary to staged IR/AST mutation.
 *
 * The published ledger is deterministic: identical input and identical registry
 * produce an identical `publicationDigest`. Wall-clock timings are reported
 * beside it and are deliberately not part of the digest.
 */

import { stableDigest } from '../../core/identity/index.js';

import { PHASE8_CONTRACT_VERSION, PASS_STAGES, createPassResult } from './contract.js';
import { IDENTITY_PASS, identityPassObservation, runIdentityPass } from './identity-pass.js';
import { runPassTransaction, seedAnalysisState } from './transaction.js';
import { SCCP_PASS, runSccpPass } from './sccp.js';
import { GVN_PASS, runGvnPass } from './valuenumber.js';
import { DCE_PASS, runDcePass } from './dce.js';
import { INDUCTION_PASS, runInductionPass } from './induction.js';
import { STRUCTURING_PASS, runStructuringPass } from './structuring.js';
import { AGGREGATE_PASS, runAggregatePass } from './aggregates.js';
import { PROVIDER_PASS, runProviderPass } from './providers.js';

export { PHASE8_CONTRACT_VERSION, PASS_STAGES } from './contract.js';
export { createPassDescriptor, createPassResult, unchangedResult, ANALYSIS_KEYS, PASS_STATUSES, COMPLETENESS, BUDGET_CLASSES } from './contract.js';
export { createPhase8ArtifactDescriptor, PHASE8_ARTIFACT_KINDS, PHASE8_ARTIFACT_SCHEMA_VERSION } from './artifact-identity.js';
export { createAnalysisState, invalidationFor, runPassTransaction, seedAnalysisState, transactionDigest } from './transaction.js';
export { SCCP_PASS, describeSccp, runSccpPass } from './sccp.js';
export { GVN_PASS, loadIsReusable, runGvnPass } from './valuenumber.js';
export { DCE_PASS, observableEffectReason, runDcePass } from './dce.js';
export { INDUCTION_PASS, INDUCTION_SUMMARY_VERSION, classifyLoop, describeLoopFacts, readGuardPredicate, resolveStep, runInductionPass, tripCountOf } from './induction.js';
export { PROVIDER_PASS, PROVIDER_INTERFACE_VERSION, PROVIDER_HINT_KINDS, HINT_STATUSES, REGISTERED_PROVIDERS, ARRAY_TRAVERSAL_PROVIDER, COUNTED_LOOP_PROVIDER, createProvider, describeProviderHints, judgeHint, providerAuthorityFailures, providerView, runProviderPass } from './providers.js';
export { AGGREGATE_PASS, AGGREGATE_SUMMARY_VERSION, AGGREGATE_KINDS, CERTAINTIES, candidatesFor, certaintyOf, describeRegion, forcedContradictions, regionIdentityOf, runAggregatePass } from './aggregates.js';
export { STRUCTURING_PASS, STRUCTURING_SUMMARY_VERSION, EDGE_CONSTRUCTS, accountEdges, classifyEdge, describeStructuring, edgeAccountingFailures, observableEffectsIn, runStructuringPass, successorEdgesOf } from './structuring.js';

/**
 * The Phase 8 pass registry.
 *
 * Order is derived from the declared stage, not from the order of this array,
 * so adding a pass in the wrong place cannot silently reorder the pipeline.
 * Later checkpoints append their passes here; nothing else registers passes.
 */
const REGISTERED = Object.freeze([
  Object.freeze({ descriptor: IDENTITY_PASS, run: runIdentityPass, observe: identityPassObservation }),
  Object.freeze({ descriptor: SCCP_PASS, run: runSccpPass }),
  Object.freeze({ descriptor: GVN_PASS, run: runGvnPass }),
  Object.freeze({ descriptor: DCE_PASS, run: runDcePass }),
  Object.freeze({ descriptor: INDUCTION_PASS, run: runInductionPass }),
  Object.freeze({ descriptor: AGGREGATE_PASS, run: runAggregatePass }),
  Object.freeze({ descriptor: STRUCTURING_PASS, run: runStructuringPass }),
  Object.freeze({ descriptor: PROVIDER_PASS, run: runProviderPass }),
]);

/**
 * Stages that run on the default interactive decompile.
 *
 * Only the canonical-facts stage. Optimizer stages are demand-driven: running a
 * whole middle end on every function the user scrolls past is the eager
 * whole-binary optimization the architecture rules out, and it also makes
 * publication depend on the clock — on the heaviest corpus function the 25 ms
 * interactive allowance is the binding constraint, so the ledger would be
 * published on a fast run and withheld on a slow one for the same input.
 *
 * A caller that wants the optimizer facts asks for them and gets a budget that
 * matches the work.
 */
export const INTERACTIVE_STAGES = Object.freeze(['canonical-facts']);

/**
 * Orders passes within one stage so a producer runs before its consumers.
 *
 * Stage order alone is not enough: two passes in the same stage can still depend
 * on each other, and sorting by id would run them in whatever order their names
 * happen to fall in. That is the "stage dependencies encoded only by incidental
 * array order" the P8-1 merge blockers reject.
 *
 * Ties break on id, so the order is deterministic. A cycle is an error rather
 * than an arbitrary choice.
 */
function orderWithinStage(passes) {
  const remaining = [...passes].sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
  const ordered = [];
  const satisfied = new Set();
  while (remaining.length > 0) {
    const index = remaining.findIndex(({ descriptor }) => descriptor.consumes.every((key) => {
      // A key nobody in this stage produces must come from an earlier stage or
      // from the seeded state; either way it does not constrain this ordering.
      const producedHere = remaining.some((candidate) => candidate.descriptor.produces.includes(key));
      return !producedHere || satisfied.has(key);
    }));
    if (index < 0) {
      const stuck = remaining.map(({ descriptor }) => descriptor.id).join(', ');
      throw new TypeError(`phase8-pass-dependency-cycle:${stuck}`);
    }
    const [next] = remaining.splice(index, 1);
    for (const key of next.descriptor.produces) satisfied.add(key);
    ordered.push(next);
  }
  return ordered;
}

export function phase8Passes({ stages = null } = {}) {
  const enabled = stages == null ? null : new Set(stages);
  const selected = [...REGISTERED].filter(({ descriptor }) => enabled == null || enabled.has(descriptor.stage));
  const byStage = new Map();
  for (const pass of selected) {
    if (!byStage.has(pass.descriptor.stageIndex)) byStage.set(pass.descriptor.stageIndex, []);
    byStage.get(pass.descriptor.stageIndex).push(pass);
  }
  return Object.freeze([...byStage.keys()].sort((left, right) => left - right)
    .flatMap((stageIndex) => orderWithinStage(byStage.get(stageIndex))));
}

/**
 * Identity of the whole optimizer set.
 *
 * Adding, removing or version-bumping any pass changes this digest, which is
 * part of Phase 8 artifact key material. That is what makes a result produced by
 * an older optimizer set unservable for a newer one, rather than merely
 * discouraged (EP-005 evidence-invalidation rule).
 */
export function passRegistryDigest(passes = phase8Passes()) {
  return stableDigest(passes.map(({ descriptor }) => ({
    id: descriptor.id,
    version: descriptor.version,
    stage: descriptor.stage,
    budgetClass: descriptor.budgetClass,
    consumes: descriptor.consumes,
    preserves: descriptor.preserves,
    invalidates: descriptor.invalidates,
    contractVersion: descriptor.contractVersion,
  })));
}

const COMPLETENESS_RANK = Object.freeze({ complete: 2, partial: 1, unknown: 0 });

function weakestCompleteness(values) {
  if (values.length === 0) return 'complete';
  return values.reduce((weakest, value) => (
    COMPLETENESS_RANK[value] < COMPLETENESS_RANK[weakest] ? value : weakest
  ), 'complete');
}

function aborted(budget) {
  try { return typeof budget?.shouldAbort === 'function' && budget.shouldAbort() === true; }
  // A cancellation predicate that throws is treated as cancelled, never as
  // permission to continue.
  catch { return true; }
}

function clock() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

/**
 * A ledger that was not published. It still carries a reason, because a Phase 8
 * result that is simply absent is indistinguishable from a Phase 8 that never
 * ran, and "unknown stays explicit" is a non-negotiable principle.
 */
function withheldLedger(status, reason, diagnostics, registryDigest, analysisVersions = null) {
  const ledger = {
    contractVersion: PHASE8_CONTRACT_VERSION,
    registryDigest,
    status,
    published: false,
    completeness: 'unknown',
    degraded: true,
    passes: Object.freeze([]),
    transformCount: 0,
    produced: Object.freeze([]),
    invalidated: Object.freeze([]),
    diagnostics: Object.freeze(diagnostics),
    observations: Object.freeze({}),
    // The state is unchanged, so before and after are the same snapshot. Saying
    // so explicitly is what lets a consumer prove nothing was committed.
    analysisVersions: analysisVersions == null ? null : Object.freeze({ before: analysisVersions, after: analysisVersions }),
    stopReason: reason,
  };
  ledger.publicationDigest = stableDigest({ ...ledger, publicationDigest: undefined });
  return Object.freeze(ledger);
}

/**
 * Runs every registered Phase 8 pass over one function's canonical facts.
 *
 * Returns `{ ledger, timings, analysis }`. `ledger` is deterministic and safe to
 * publish or key an artifact with; `timings` is observational; `analysis` is the
 * authoritative state after the transactions committed.
 *
 * Cancellation and pass failure withhold the whole ledger. A partially executed
 * optimizer set is not a smaller optimizer set — it is an unknown one. The
 * per-pass transaction has already guaranteed that nothing was committed in
 * those cases, so the withheld ledger and the untouched state agree.
 */
export function runPhase8Vertical(context = {}, budget = {}) {
  const enabledStages = context.enabledStages ?? null;
  const passes = phase8Passes({ stages: enabledStages });
  // The digest covers the passes that actually ran. A ledger produced with the
  // optimizer stages disabled must never be servable for a request that wanted
  // them, and a digest over the full registry would make those two ledgers
  // indistinguishable.
  const registryDigest = passRegistryDigest(passes);
  let analysis;
  try {
    analysis = context.analysis ?? seedAnalysisState(context.ir, { types: context.types ?? null });
  } catch (error) {
    // Seeding reads upstream facts. If reading them throws, Phase 8 knows
    // nothing about this function and must say so rather than proceeding with a
    // half-built state.
    return {
      ledger: withheldLedger('failed', 'analysis-seed-failed', [{
        severity: 'error',
        code: 'phase8.seed.failed',
        message: 'Phase 8 could not read the canonical analysis facts for this function.',
        reason: String(error?.message ?? error),
      }], registryDigest, null),
      timings: Object.freeze([]),
      analysis: null,
    };
  }
  const before = analysis.snapshot();

  if (aborted(budget)) {
    return {
      ledger: withheldLedger('cancelled', 'cancelled-before-start', [{
        severity: 'info',
        code: 'phase8.cancelled',
        message: 'Phase 8 was cancelled before any pass started.',
        reason: 'The decompiler budget was already exhausted when the Phase 8 stage was reached.',
      }], registryDigest, before),
      timings: Object.freeze([]),
      analysis,
    };
  }

  const passContext = { ...context, analysis };
  const results = [];
  const timings = [];
  const observations = {};
  const invalidated = new Set();
  for (const pass of passes) {
    const started = clock();
    const outcome = runPassTransaction(analysis, pass, passContext, budget);
    timings.push({ passId: pass.descriptor.id, elapsedMs: clock() - started });

    if (!outcome.committed) {
      const reason = outcome.stopReason ?? 'unknown';
      // A missing declared input is not a failure: it is an honest unsupported
      // answer for that pass, and the rest of the set may still be meaningful.
      if (reason.startsWith('missing-input:')) {
        results.push(createPassResult({
          descriptor: pass.descriptor,
          status: 'unsupported',
          changed: false,
          completeness: 'unknown',
          stopReason: reason,
          diagnostics: [{
            severity: 'info',
            code: 'phase8.pass.missing-input',
            message: `Phase 8 pass did not run: ${pass.descriptor.id}`,
            reason: `A declared input analysis is unavailable (${reason.slice('missing-input:'.length)}); the pass refuses to improvise a substitute.`,
          }],
        }));
        continue;
      }
      // Cancellation or failure. Nothing was committed, and nothing is published.
      const cancelled = reason.startsWith('cancelled');
      return {
        ledger: withheldLedger(cancelled ? 'cancelled' : 'failed', `${cancelled ? '' : 'pass-failed:'}${cancelled ? reason : pass.descriptor.id}`, [{
          severity: cancelled ? 'info' : 'error',
          code: cancelled ? 'phase8.cancelled' : 'phase8.pass.failed',
          message: cancelled
            ? 'Phase 8 was cancelled part way through the pass set.'
            : `Phase 8 pass failed: ${pass.descriptor.id}`,
          reason,
        }], registryDigest, before),
        timings: Object.freeze(timings),
        analysis,
      };
    }

    results.push(outcome.result);
    for (const key of outcome.invalidated) invalidated.add(key);
    if (typeof pass.observe === 'function') observations[pass.descriptor.id] = pass.observe(passContext);
  }

  const diagnostics = results.flatMap((result) => result.diagnostics);
  const ledger = {
    contractVersion: PHASE8_CONTRACT_VERSION,
    registryDigest,
    status: 'published',
    published: true,
    completeness: weakestCompleteness(results.map((result) => result.completeness)),
    degraded: results.some((result) => result.status === 'degraded'),
    passes: Object.freeze(results),
    transformCount: results.reduce((total, result) => total + result.transforms.length, 0),
    // Analyses this run produced, so a consumer can tell "the optimizer ran and
    // found nothing" apart from "the optimizer never ran".
    produced: Object.freeze([...new Set(results.flatMap((result) => result.produced))].sort()),
    invalidated: Object.freeze([...invalidated].sort()),
    diagnostics: Object.freeze(diagnostics),
    observations: Object.freeze(observations),
    enabledStages: Object.freeze(enabledStages == null ? [...PASS_STAGES] : [...enabledStages]),
    // Analysis versions before and after. Invalidation is a property a consumer
    // can check, not a claim it has to believe.
    analysisVersions: Object.freeze({ before, after: analysis.snapshot() }),
    stopReason: null,
  };
  ledger.publicationDigest = stableDigest({ ...ledger, publicationDigest: undefined });
  return { ledger: Object.freeze(ledger), timings: Object.freeze(timings), analysis };
}

/**
 * Runs the Phase 8 vertical with its own budget.
 *
 * Phase 8 deliberately does not share the representation passes' deadline. The
 * existing `PassManager` deadline is a fixed-point/rewrite allowance, and simply
 * inserting a Phase 8 stage into it made two budget-saturated corpus functions
 * lose rewrite iterations — the same pseudocode, but a measurably different
 * rewrite fixed point. A middle-end that degrades the existing output merely by
 * being present is not a no-op, and "performance work must not trade correctness
 * for confidence" is a Master Architecture invariant.
 *
 * So Phase 8 gets a separate, declared allowance. Its cost is visible in the
 * active-function latency budget rather than hidden by taking it from another
 * pass.
 */
export function runPhase8Stage(context = {}, options = {}) {
  const timeBudgetMs = Math.max(0, Number(options.timeBudgetMs ?? 15));
  const stages = options.stages ?? INTERACTIVE_STAGES;
  const started = clock();
  const deadline = started + timeBudgetMs;
  const external = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const budget = {
    timeBudgetMs,
    deadline,
    budgetClass: options.budgetClass ?? 'interactive',
    shouldAbort: () => (external ? external() === true : false) || clock() >= deadline,
  };
  const outcome = runPhase8Vertical({ ...context, enabledStages: stages }, budget);
  return { ...outcome, elapsedMs: clock() - started };
}
