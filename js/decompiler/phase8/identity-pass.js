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
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'deadCode', 'induction', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: [],
  required: false,
  description: 'Identity vertical pass: observes canonical semantic facts and changes nothing.',
});

/**
 * Observes and reports. Returns a `PassResult`; it never writes.
 *
 * `context.analysis` is the authoritative analysis state. The pass reads its
 * declared inputs from there rather than from the raw IR, so "what does this
 * pass actually depend on" is the same question as "what does it declare".
 */
export function runIdentityPass(context = {}) {
  const analysis = context.analysis;
  const ssa = analysis?.get('ssa') ?? null;
  const cfg = analysis?.get('cfg') ?? null;
  const values = Array.isArray(ssa?.values) ? ssa.values.length : 0;
  const blocks = Array.isArray(cfg?.blocks) ? cfg.blocks.length : 0;
  // The transaction refuses to run a pass whose declared inputs are absent, so
  // reaching this point means the facts are present. Reporting `complete` here
  // is therefore a statement about facts that exist, not an assumption.
  return createPassResult({
    descriptor: IDENTITY_PASS,
    status: 'unchanged',
    changed: false,
    completeness: 'complete',
    diagnostics: [],
    transforms: [],
    invalidated: [],
    observation: { values, blocks },
  });
}

/** Observation counters, kept separate from the validated result contract. */
export function identityPassObservation(context = {}) {
  const analysis = context.analysis;
  return Object.freeze({
    values: Array.isArray(analysis?.get('ssa')?.values) ? analysis.get('ssa').values.length : 0,
    blocks: Array.isArray(analysis?.get('cfg')?.blocks) ? analysis.get('cfg').blocks.length : 0,
  });
}
