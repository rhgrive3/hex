/**
 * The Phase 8 identity pass — the walking skeleton.
 *
 * It observes the canonical semantic facts the real production decompiler
 * already has and changes nothing. That is the whole point: Phase 3 and Phase 5
 * both paid for treating integration as a late activity (EP-001), so Phase 8
 * puts a real pass through the real pipeline at the foundation checkpoint, when
 * the only thing that can break is the wiring.
 *
 * What it proves at P8-0:
 *   - a Phase 8 pass runs inside the production PassManager;
 *   - its result is published deterministically and carries provenance;
 *   - it declares consumes/preserves/invalidates and honours them;
 *   - semantic output, pseudocode, provenance and metrics are byte-identical
 *     to the pre-Phase-8 path.
 *
 * It deliberately has no optimization value. The moment it acquires one, it is
 * no longer the control for "did the wiring change the product".
 */

import { createPassDescriptor, createPassResult } from './contract.js';

export const IDENTITY_PASS = createPassDescriptor({
  id: 'phase8.identity',
  version: '1.0.0',
  stage: 'canonical-facts',
  budgetClass: 'interactive',
  // It reads the canonical facts a real Phase 8 pass reads, so the wiring it
  // proves is the wiring the optimizers will use.
  consumes: ['cfg', 'ssa', 'origins'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions'],
  invalidates: [],
  required: false,
  description: 'Identity vertical pass: observes canonical semantic facts and changes nothing.',
});

function countValues(ir) {
  return Array.isArray(ir?.values) ? ir.values.length : 0;
}

function countBlocks(ir) {
  if (Array.isArray(ir?.blocks)) return ir.blocks.length;
  if (Array.isArray(ir?.cfg?.blocks)) return ir.cfg.blocks.length;
  return 0;
}

/**
 * Observes and reports. Returns a `PassResult`, never a mutated state.
 *
 * `completeness` is honest about the one thing that can genuinely be unknown
 * here: whether canonical SSA facts were available at all. A function reached
 * through the legacy compatibility path has no Semantic IR values, and saying
 * `complete` about a function we did not look at would be exactly the
 * skip-green failure the guardrails forbid.
 */
export function runIdentityPass(context = {}) {
  const values = countValues(context.ir);
  const blocks = countBlocks(context.ir);
  const observed = values > 0;
  return createPassResult({
    descriptor: IDENTITY_PASS,
    status: observed ? 'unchanged' : 'unsupported',
    changed: false,
    completeness: observed ? 'complete' : 'unknown',
    stopReason: observed ? null : 'no-canonical-ssa-values',
    diagnostics: observed ? [] : [{
      severity: 'info',
      code: 'phase8.identity.no-canonical-values',
      message: 'Phase 8 saw no canonical Semantic IR values for this function.',
      reason: 'The function was produced through a path that does not publish Semantic IR values; Phase 8 reports unknown rather than assuming there was nothing to do.',
    }],
    // Deliberately empty: this pass has no transforms, and a transform record
    // here would mean the control is no longer a control.
    transforms: [],
    invalidated: [],
    // Observation counters are metrics, not semantics; they are reported through
    // the publication ledger below rather than smuggled into the result shape.
    observation: { values, blocks },
  });
}

/** Observation counters, kept separate from the validated result contract. */
export function identityPassObservation(context = {}) {
  return Object.freeze({ values: countValues(context.ir), blocks: countBlocks(context.ir) });
}
