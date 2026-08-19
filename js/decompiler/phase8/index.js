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

import { PHASE8_CONTRACT_VERSION, PASS_STAGES } from './contract.js';
import { IDENTITY_PASS, identityPassObservation, runIdentityPass } from './identity-pass.js';

export { PHASE8_CONTRACT_VERSION, PASS_STAGES } from './contract.js';
export { createPassDescriptor, createPassResult, unchangedResult, ANALYSIS_KEYS, PASS_STATUSES, COMPLETENESS, BUDGET_CLASSES } from './contract.js';
export { createPhase8ArtifactDescriptor, PHASE8_ARTIFACT_KINDS, PHASE8_ARTIFACT_SCHEMA_VERSION } from './artifact-identity.js';

/**
 * The Phase 8 pass registry.
 *
 * Order is derived from the declared stage, not from the order of this array,
 * so adding a pass in the wrong place cannot silently reorder the pipeline.
 * Later checkpoints append their passes here; nothing else registers passes.
 */
const REGISTERED = Object.freeze([
  Object.freeze({ descriptor: IDENTITY_PASS, run: runIdentityPass, observe: identityPassObservation }),
]);

export function phase8Passes() {
  return Object.freeze([...REGISTERED]
    .sort((left, right) => left.descriptor.stageIndex - right.descriptor.stageIndex
      || left.descriptor.id.localeCompare(right.descriptor.id)));
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
function withheldLedger(status, reason, diagnostics, registryDigest) {
  const ledger = {
    contractVersion: PHASE8_CONTRACT_VERSION,
    registryDigest,
    status,
    published: false,
    completeness: 'unknown',
    degraded: true,
    passes: Object.freeze([]),
    transformCount: 0,
    invalidated: Object.freeze([]),
    diagnostics: Object.freeze(diagnostics),
    observations: Object.freeze({}),
    stopReason: reason,
  };
  ledger.publicationDigest = stableDigest({ ...ledger, publicationDigest: undefined });
  return Object.freeze(ledger);
}

/**
 * Runs every registered Phase 8 pass over one function's canonical facts.
 *
 * Returns `{ ledger, timings }`. `ledger` is deterministic and safe to publish
 * or key an artifact with; `timings` is observational.
 *
 * Cancellation and pass failure both withhold the whole ledger. A partially
 * executed optimizer set is not a smaller optimizer set — it is an unknown one.
 */
export function runPhase8Vertical(context = {}, budget = {}) {
  const passes = phase8Passes();
  const registryDigest = passRegistryDigest(passes);

  if (aborted(budget)) {
    return {
      ledger: withheldLedger('cancelled', 'cancelled-before-start', [{
        severity: 'info',
        code: 'phase8.cancelled',
        message: 'Phase 8 was cancelled before any pass started.',
        reason: 'The decompiler budget was already exhausted when the Phase 8 stage was reached.',
      }], registryDigest),
      timings: Object.freeze([]),
    };
  }

  const results = [];
  const timings = [];
  const observations = {};
  for (const pass of passes) {
    const started = clock();
    let result;
    try {
      result = pass.run(context, budget);
    } catch (error) {
      // Fail closed. A pass that threw may have left its own scratch state in
      // any condition; nothing it produced is publishable.
      return {
        ledger: withheldLedger('failed', `pass-failed:${pass.descriptor.id}`, [{
          severity: 'error',
          code: 'phase8.pass.failed',
          message: `Phase 8 pass failed: ${pass.descriptor.id}`,
          reason: String(error?.message ?? error),
        }], registryDigest),
        timings: Object.freeze(timings),
      };
    }
    timings.push({ passId: pass.descriptor.id, elapsedMs: clock() - started });
    results.push(result);
    if (typeof pass.observe === 'function') observations[pass.descriptor.id] = pass.observe(context);
    // Checked after the pass, not only before it: a long pass that outlives the
    // deadline must not have its result published as if it had finished in time.
    if (aborted(budget)) {
      return {
        ledger: withheldLedger('cancelled', `cancelled-after:${pass.descriptor.id}`, [{
          severity: 'info',
          code: 'phase8.cancelled',
          message: 'Phase 8 was cancelled part way through the pass set.',
          reason: `The budget was exhausted after ${pass.descriptor.id}; a partial optimizer set is withheld rather than published.`,
        }], registryDigest),
        timings: Object.freeze(timings),
      };
    }
  }

  const diagnostics = results.flatMap((result) => result.diagnostics);
  const invalidated = [...new Set(results.flatMap((result) => result.invalidated))].sort();
  const ledger = {
    contractVersion: PHASE8_CONTRACT_VERSION,
    registryDigest,
    status: 'published',
    published: true,
    completeness: weakestCompleteness(results.map((result) => result.completeness)),
    degraded: results.some((result) => result.status === 'degraded'),
    passes: Object.freeze(results),
    transformCount: results.reduce((total, result) => total + result.transforms.length, 0),
    invalidated: Object.freeze(invalidated),
    diagnostics: Object.freeze(diagnostics),
    observations: Object.freeze(observations),
    stopReason: null,
  };
  ledger.publicationDigest = stableDigest({ ...ledger, publicationDigest: undefined });
  return { ledger: Object.freeze(ledger), timings: Object.freeze(timings) };
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
  const started = clock();
  const deadline = started + timeBudgetMs;
  const external = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const budget = {
    timeBudgetMs,
    deadline,
    budgetClass: options.budgetClass ?? 'interactive',
    shouldAbort: () => (external ? external() === true : false) || clock() >= deadline,
  };
  const outcome = runPhase8Vertical(context, budget);
  return { ...outcome, elapsedMs: clock() - started };
}
