/**
 * Phase 8 metric collection.
 *
 * One place computes the quality vector, the hard-zero safety counters and the
 * performance numbers, and the baseline capture, the release verifier and the
 * contract tests all read it. A metric that is computed twice is a metric that
 * will eventually disagree with itself.
 *
 * Counters that Phase 8 has not implemented the machinery for yet report
 * `null` — explicitly not measured. They are never reported as zero, because a
 * zero that means "nothing looked" is exactly the skip-green failure the
 * guardrails forbid.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { PASS_STAGES, passRegistryDigest, phase8Passes, runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { edgeAccountingFailures } from '../../../js/decompiler/phase8/structuring.js';
import { forcedContradictions } from '../../../js/decompiler/phase8/aggregates.js';
import { providerAuthorityFailures, providerView } from '../../../js/decompiler/phase8/providers.js';
import { createPhase8ArtifactDescriptor } from '../../../js/decompiler/phase8/artifact-identity.js';

import { loadCorpus } from './build-corpus.mjs';
import { decompileEntry, observeCorpus } from './decompile-corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FROZEN_BASELINE = path.join(ROOT, 'tests/phase8/corpus/pre-phase8-observations.json');
const PHASE8_SOURCE_DIRECTORY = path.join(ROOT, 'js/decompiler/phase8');

export function loadFrozenBaseline(target = FROZEN_BASELINE) {
  if (!fs.existsSync(target)) throw new Error(`phase8: frozen baseline missing at ${path.relative(ROOT, target)}`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

/** The accepted readability/recovery vector. Higher is better only where noted. */
export function qualityVector(observations) {
  const usable = observations.filter((observation) => !observation.failure);
  const semantic = usable.filter((observation) => observation.semantic);
  return {
    functions: observations.length,
    failures: observations.length - usable.length,
    // How much of the corpus the shared semantic decompiler covers at all. Every
    // function below this line is served by the legacy compatibility path.
    semanticCoverage: usable.length === 0 ? 0 : semantic.length / usable.length,
    semanticFunctions: semantic.length,
    rawAssemblyFallbacks: sum(semantic.map((observation) => observation.readability.rawAssemblyFallbacks)),
    gotos: sum(semantic.map((observation) => observation.readability.gotos)),
    temporaries: sum(semantic.map((observation) => observation.readability.temporaries)),
    redundantCasts: sum(semantic.map((observation) => observation.readability.redundantCasts)),
    structuredFunctions: semantic.filter((observation) => observation.readability.structured === true).length,
    sourceMappedNodes: sum(semantic.map((observation) => observation.sourceMappedNodes)),
    aggregateLayouts: sum(semantic.map((observation) => observation.aggregateLayouts)),
    highVariableGroups: sum(semantic.map((observation) => observation.highVariableGroups)),
  };
}

/**
 * Static architecture-boundary check over Phase 8's own generic sources.
 *
 * Phase 8's generic middle end must not name architecture registers, flags or
 * decoders. This is a text check on purpose: it is cheap, it runs on every
 * candidate, and it catches the failure at the moment someone reaches for
 * `w0`/`nzcv`/`rax` inside a generic optimizer rather than three checkpoints
 * later when the pass no longer works on RISC-V.
 */
export function architectureBoundaryViolations(directory = PHASE8_SOURCE_DIRECTORY) {
  const patterns = [
    /\b(?:x|w)(?:[12]?\d|3[01])\b/,          // AArch64 general registers
    /\bnzcv\b/i,                              // AArch64 flags
    /\b(?:r[abcd]x|r[sd]i|rsp|rbp|r(?:8|9|1[0-5])d?)\b/i, // x86-64 registers
    /\beflags\b/i,
    // `\b` alone would miss AAPCS64_ABI: an underscore is a word character, so
    // there is no boundary after the identifier proper.
    /\b(?:aapcs64|sysv[_-]?amd64|lp64|ilp32)\w*/i, // ABI identifiers
    /\bfrom-machine-effects\b/,               // decoder entry points
  ];
  const violations = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const lines = fs.readFileSync(absolute, 'utf8').split('\n');
      // Comments explain the boundary; they are not the boundary. Block comments
      // span lines, so the scanner tracks that state rather than stripping each
      // line in isolation — otherwise the sentence explaining that generic code
      // must not know what a flag register is gets reported as generic code
      // knowing what a flag register is.
      let inBlockComment = false;
      lines.forEach((line, index) => {
        let code = '';
        for (let position = 0; position < line.length; position += 1) {
          if (inBlockComment) {
            if (line.startsWith('*/', position)) { inBlockComment = false; position += 1; }
            continue;
          }
          if (line.startsWith('/*', position)) { inBlockComment = true; position += 1; continue; }
          if (line.startsWith('//', position)) break;
          code += line[position];
        }
        for (const pattern of patterns) {
          if (pattern.test(code)) {
            violations.push({ file: path.relative(ROOT, absolute), line: index + 1, text: line.trim().slice(0, 120) });
            break;
          }
        }
      });
    }
  };
  visit(directory);
  return violations;
}

/**
 * Proves Phase 8 artifact identity actually discriminates.
 *
 * A key that does not change when the optimizer set changes is how a result
 * from an older pass registry gets served for a newer one. This computes the
 * failure count directly rather than trusting the descriptor's intent.
 */
export function artifactIdentityFailures() {
  const base = {
    kind: 'phase8.passLedger',
    binaryId: 'binary_phase8_identity_probe',
    functionId: 'function_probe',
    architectureId: 'aarch64',
    snapshotId: 'snapshot_probe',
    semanticSchemaVersion: 'semantic-ir/v2',
    cfgVersion: 'cfg/1',
    ssaVersion: 'ssa/1',
    producerId: 'phase8.vertical',
    producerVersion: '1.0.0',
    passRegistryDigest: passRegistryDigest(),
    budgetClass: 'interactive',
  };
  const failures = [];
  const original = createPhase8ArtifactDescriptor(base);
  const differentRegistry = createPhase8ArtifactDescriptor({ ...base, passRegistryDigest: `${base.passRegistryDigest}x` });
  const differentSsa = createPhase8ArtifactDescriptor({ ...base, ssaVersion: 'ssa/2' });
  const differentBudget = createPhase8ArtifactDescriptor({ ...base, budgetClass: 'exhaustive' });
  const sameAgain = createPhase8ArtifactDescriptor({ ...base });
  if (original.artifactId === differentRegistry.artifactId) failures.push('pass registry digest does not change the artifact id');
  if (original.artifactId === differentSsa.artifactId) failures.push('SSA version does not change the artifact id');
  if (original.artifactId === differentBudget.artifactId) failures.push('budget class does not change the artifact id');
  if (original.artifactId !== sameAgain.artifactId) failures.push('identical inputs do not produce the same artifact id');
  return failures;
}

/**
 * Compares the candidate against the frozen pre-Phase-8 product.
 *
 * The hard-zero counters live here because every one of them is defined as a
 * regression against that frozen evidence, not as an absolute property of a
 * single run.
 */
export function safetyCounters(observations, baseline) {
  const byId = new Map(baseline.observations.map((observation) => [observation.id, observation]));
  let semanticMismatchCount = 0;
  let provenanceLossCount = 0;
  let unknownSafetyRegressionCount = 0;
  const details = [];

  for (const observation of observations) {
    const before = byId.get(observation.id);
    if (!before) { details.push({ id: observation.id, kind: 'unbaselined' }); continue; }

    if (observation.failure && !before.failure) {
      semanticMismatchCount += 1;
      details.push({ id: observation.id, kind: 'failure-appeared', detail: observation.failure });
      continue;
    }
    // Falling off the shared semantic path onto the legacy decompiler is a
    // semantic regression even when the printed text looks similar.
    if (before.semantic && !observation.semantic) {
      semanticMismatchCount += 1;
      details.push({ id: observation.id, kind: 'semantic-path-lost' });
    }
    if (before.semantic && observation.semantic && observation.sourceMappedNodes < before.sourceMappedNodes) {
      provenanceLossCount += 1;
      details.push({ id: observation.id, kind: 'source-mapping-lost', detail: `${before.sourceMappedNodes} -> ${observation.sourceMappedNodes}` });
    }

    const ledger = observation.phase8;
    if (ledger) {
      // A published ledger that claims complete reasoning about a function the
      // shared semantic path could not represent is false certainty.
      if (ledger.published && ledger.completeness === 'complete' && !observation.semantic) {
        unknownSafetyRegressionCount += 1;
        details.push({ id: observation.id, kind: 'complete-claimed-without-semantic-path' });
      }
      // A withheld ledger must not carry transforms: nothing was published, so
      // nothing may claim to have been applied.
      if (!ledger.published && ledger.transformCount > 0) {
        unknownSafetyRegressionCount += 1;
        details.push({ id: observation.id, kind: 'withheld-ledger-claims-transforms' });
      }
    }
  }

  return {
    semanticMismatchCount,
    provenanceLossCount,
    unknownSafetyRegressionCount,
    details: details.slice(0, 40),
  };
}

/**
 * Runs the corpus twice in-process and reports observations that differ.
 *
 * The first run may be supplied by a caller that already has one, so a full
 * metric collection costs two corpus runs rather than three. What is being
 * proved is that two independent runs agree, and a caller's run is an
 * independent run.
 *
 * Both runs must share a time budget. They did not: the default here was 400 ms
 * while every caller's own run used the 5000 ms measurement allowance, so the
 * comparison was a fast run against a slow one and any function heavy enough to
 * truncate at 400 ms would be reported as non-deterministic. That is a
 * measurement defect, not a transform defect — the same defect P8-3 removed from
 * the baseline capture — and it stayed latent only until the corpus got slightly
 * more expensive. `MEASUREMENT_TIME_BUDGET_MS` is now the single allowance both
 * runs use.
 */
export const MEASUREMENT_TIME_BUDGET_MS = 5000;

export function determinismFailures({ corpus = loadCorpus(), decompilerTimeBudgetMs = MEASUREMENT_TIME_BUDGET_MS, first: firstRun = null } = {}) {
  const first = firstRun ?? observeCorpus({ corpus, decompilerTimeBudgetMs });
  // Same corpus, same budget. Anything else compares two different questions.
  const second = observeCorpus({ corpus, decompilerTimeBudgetMs });
  const failures = [];
  for (let index = 0; index < first.length; index += 1) {
    if (stableDigest(first[index]) !== stableDigest(second[index])) failures.push(first[index].id);
  }
  return failures;
}

/**
 * Edge accounting over the whole corpus.
 *
 * The P8-5 gate is `lostCfgEdgeCount = 0`: every edge in every corpus function's
 * CFG is accounted for by a structured construct, an explicit jump or an
 * explicit unknown. The count is recomputed here from the CFG rather than read
 * off the pass's own summary, which is the entire point of an edge-accounting
 * verifier.
 *
 * A function with no semantic IR is reported separately and counted as missing
 * coverage. It is never counted as zero: an edge nobody looked at is not an edge
 * nobody lost.
 */
export function structuringAccounting({ corpus = loadCorpus(), decompilerTimeBudgetMs = MEASUREMENT_TIME_BUDGET_MS } = {}) {
  const failures = [];
  const withoutIr = [];
  const withoutFacts = [];
  let edgeCount = 0;
  let residualGotoCount = 0;
  let constraintEdgeCount = 0;
  let unknownEdgeCount = 0;
  let covered = 0;
  for (const [index, entry] of corpus.functions.entries()) {
    const outcome = decompileEntry(entry, { index, decompilerTimeBudgetMs });
    const ir = outcome?.result?.ir ?? null;
    if (ir == null) { withoutIr.push(entry.id); continue; }
    const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 4000 });
    if (!ledger.published) { withoutFacts.push(`${entry.id}: ${ledger.stopReason}`); continue; }
    const facts = analysis.get('structuredRegions');
    if (facts == null) { withoutFacts.push(`${entry.id}: no structured-region facts`); continue; }
    covered += 1;
    edgeCount += facts.edgeCount;
    residualGotoCount += facts.residualGotoCount;
    constraintEdgeCount += facts.constraintEdgeCount;
    unknownEdgeCount += facts.unknownEdgeCount;
    for (const failure of edgeAccountingFailures(ir, facts)) {
      failures.push({ id: entry.id, ...failure });
    }
  }
  return {
    // Missing coverage is a lost edge as far as this gate is concerned.
    lostCfgEdgeCount: failures.length + withoutIr.length + withoutFacts.length,
    accountingFailures: failures.slice(0, 20),
    functionsCovered: covered,
    functionsWithoutIr: withoutIr,
    functionsWithoutFacts: withoutFacts,
    edgeCount,
    // Reported for evidence, never gated: a correct jump beats a false loop.
    residualGotoCount,
    constraintEdgeCount,
    unknownEdgeCount,
  };
}

/**
 * Aggregate certainty over the whole corpus.
 *
 * The P8-6 gate is `forcedTypeContradictionCount = 0`: no candidate reached
 * certainty over an unresolved conflict, on soft evidence alone, or by a region
 * with contradictory declarations quietly settling on one shape. It is
 * recomputed here from the published evidence rather than read off a counter the
 * pass keeps about itself.
 */
export function aggregateCertainty({ corpus = loadCorpus(), decompilerTimeBudgetMs = MEASUREMENT_TIME_BUDGET_MS } = {}) {
  const forced = [];
  const withoutFacts = [];
  let regionCount = 0;
  let candidateCount = 0;
  let ambiguousRegionCount = 0;
  let conflictCount = 0;
  let confirmedCount = 0;
  for (const [index, entry] of corpus.functions.entries()) {
    const outcome = decompileEntry(entry, { index, decompilerTimeBudgetMs });
    const ir = outcome?.result?.ir ?? null;
    if (ir == null) { withoutFacts.push(`${entry.id}: no semantic IR`); continue; }
    const { ledger, analysis } = runPhase8Stage({ ir, types: outcome.result.types ?? null }, { stages: PASS_STAGES, timeBudgetMs: 4000 });
    if (!ledger.published) { withoutFacts.push(`${entry.id}: ${ledger.stopReason}`); continue; }
    const facts = analysis.get('aggregates');
    if (facts == null) { withoutFacts.push(`${entry.id}: no aggregate facts`); continue; }
    regionCount += facts.regionCount;
    candidateCount += facts.candidateCount;
    ambiguousRegionCount += facts.ambiguousRegionCount;
    conflictCount += facts.conflictCount;
    confirmedCount += facts.confirmedCount;
    for (const failure of forcedContradictions(facts)) forced.push({ id: entry.id, ...failure });
  }
  return {
    // Missing coverage counts against the gate: a region nobody looked at is not
    // a region with no forced contradiction.
    forcedTypeContradictionCount: forced.length + withoutFacts.length,
    forcedContradictions: forced.slice(0, 20),
    functionsWithoutFacts: withoutFacts,
    regionCount,
    candidateCount,
    // Regions that kept more than one shape instead of picking the best score.
    ambiguousRegionCount,
    conflictCount,
    confirmedCount,
  };
}

/**
 * Provider evidence: the same corpus with providers off and on.
 *
 * Two things have to hold at once. With providers off the generic result must be
 * exactly what it was — a refinement layer that changes the answer when it is
 * switched off was never a refinement layer. With providers on the hints must
 * appear, and none of them may have been granted more authority than the generic
 * evidence supports.
 */
export function providerEvidence({ corpus = loadCorpus(), decompilerTimeBudgetMs = MEASUREMENT_TIME_BUDGET_MS } = {}) {
  const genericDivergences = [];
  const authorityFailures = [];
  const withoutFacts = [];
  let hintCount = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;
  let cappedCount = 0;
  let functionsWithHints = 0;
  let providerFailureCount = 0;
  for (const [index, entry] of corpus.functions.entries()) {
    const outcome = decompileEntry(entry, { index, decompilerTimeBudgetMs });
    const ir = outcome?.result?.ir ?? null;
    if (ir == null) { withoutFacts.push(`${entry.id}: no semantic IR`); continue; }
    const context = { ir, types: outcome.result.types ?? null };
    const off = runPhase8Stage({ ...context, opts: { phase8Providers: false } }, { stages: PASS_STAGES, timeBudgetMs: 4000 });
    const on = runPhase8Stage(context, { stages: PASS_STAGES, timeBudgetMs: 4000 });
    if (!off.ledger.published || !on.ledger.published) {
      withoutFacts.push(`${entry.id}: ${off.ledger.stopReason ?? on.ledger.stopReason}`);
      continue;
    }
    // Every generic fact must be identical with the providers switched off and
    // on. Only the hints may differ.
    for (const key of ['ranges', 'valueNumbers', 'deadCode', 'induction', 'aggregates', 'structuredRegions']) {
      if (stableDigest(off.analysis.get(key)) !== stableDigest(on.analysis.get(key))) {
        genericDivergences.push(`${entry.id}: ${key} changed when providers were enabled`);
      }
    }
    const offHints = off.analysis.get('providerHints');
    if (offHints != null && offHints.hints.length > 0) {
      genericDivergences.push(`${entry.id}: hints were published with providers disabled`);
    }
    const facts = on.analysis.get('providerHints');
    if (facts == null) { withoutFacts.push(`${entry.id}: no provider facts`); continue; }
    hintCount += facts.hints.length;
    acceptedCount += facts.acceptedCount;
    rejectedCount += facts.rejectedCount;
    cappedCount += facts.cappedCount;
    providerFailureCount += facts.failures.length;
    if (facts.hints.length > 0) functionsWithHints += 1;
    for (const failure of providerAuthorityFailures(facts, providerView(on.analysis))) {
      authorityFailures.push({ id: entry.id, ...failure });
    }
  }
  return {
    // A provider that exceeded its authority, or a generic fact that moved when
    // the refinement layer was switched on, are both hard failures. They are
    // reported as evidence rather than added to the frozen hard-zero list, which
    // the P8-I contract fixes at eight counters.
    providerAuthorityFailureCount: authorityFailures.length + withoutFacts.length,
    providerAuthorityFailures: authorityFailures.slice(0, 20),
    providerOffDivergenceCount: genericDivergences.length,
    providerOffDivergences: genericDivergences.slice(0, 20),
    functionsWithoutFacts: withoutFacts,
    hintCount,
    acceptedCount,
    rejectedCount,
    // Hints that asked for more certainty than the generic evidence allowed.
    cappedCount,
    functionsWithHints,
    providerFailureCount,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Active-function latency.
 *
 * iPad/WebKit responsiveness is a release constraint, not a final-lane
 * afterthought (§8), so the cost of the Phase 8 stage is measured from the first
 * checkpoint. `coldActiveFunction` is the median whole-corpus decompilation; the
 * Phase 8 stage cost is reported separately so a regression can be attributed.
 */
export function performanceMetrics({ repetitions = 3, corpus = loadCorpus() } = {}) {
  const perFunction = [];
  const phase8PerFunction = [];
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const started = Date.now();
    const observations = observeCorpus({ corpus, deterministicTransforms: false });
    perFunction.push((Date.now() - started) / Math.max(1, observations.length));
    // The Phase 8 stage reports its own elapsed time through the pipeline ctx;
    // when no ledger is published there is nothing to attribute.
    phase8PerFunction.push(observations.filter((observation) => observation.phase8?.published).length);
    runs.push(observations);
  }
  return {
    procedureVersion: 1,
    repetitions,
    aggregate: 'median',
    coldActiveFunctionMs: { medianMs: median(perFunction), samples: perFunction.map((value) => Number(value.toFixed(3))) },
    publishedLedgers: median(phase8PerFunction),
    runs,
  };
}

/**
 * Production-mode determinism.
 *
 * The clock valve that guards iPad responsiveness means a budget-saturated
 * function can stop at different points on different runs. That is acceptable
 * only because such a result is labelled `partial`. What must never vary is the
 * canonical result: two runs that both report `complete` for the same function
 * have to agree exactly.
 *
 * This is measured in production mode, not in the work-bounded measurement mode,
 * because a determinism property that only holds in the mode nobody ships is not
 * a property of the product.
 */
export function completeResultDivergences(runs) {
  // One run cannot disagree with itself. Reporting zero divergences from a
  // single sample would claim a proof nobody performed, so it reports null.
  if (!Array.isArray(runs) || runs.length < 2) return null;
  const canonical = new Map();
  const divergences = [];
  for (const run of runs) {
    for (const observation of run) {
      if (observation.failure || observation.completeness !== 'complete') continue;
      const digest = stableDigest({ ...observation, phase8: undefined });
      const first = canonical.get(observation.id);
      if (first == null) canonical.set(observation.id, digest);
      else if (first !== digest && !divergences.includes(observation.id)) divergences.push(observation.id);
    }
  }
  return divergences;
}

export function collectPhase8Metrics({ repetitions = 3, includePerformance = true } = {}) {
  const corpus = loadCorpus();
  const baseline = loadFrozenBaseline();
  const observations = observeCorpus({ corpus, decompilerTimeBudgetMs: MEASUREMENT_TIME_BUDGET_MS });
  const quality = qualityVector(observations);
  const baselineQuality = qualityVector(baseline.observations);
  const boundary = architectureBoundaryViolations();
  const artifactFailures = artifactIdentityFailures();
  const determinism = determinismFailures({ corpus, first: observations, decompilerTimeBudgetMs: MEASUREMENT_TIME_BUDGET_MS });
  const accounting = structuringAccounting({ corpus });
  const certainty = aggregateCertainty({ corpus });
  const providers = providerEvidence({ corpus });
  const performance = includePerformance ? performanceMetrics({ repetitions, corpus }) : null;
  const productionDivergences = performance ? completeResultDivergences(performance.runs) : null;
  return {
    corpus: {
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      corpusDigest: corpus.corpusDigest,
      toolchain: corpus.toolchain,
      frozenBaselineDigest: baseline.observationsDigest,
      baselineCommit: baseline.baseCommit,
    },
    registry: {
      passRegistryDigest: passRegistryDigest(),
      passes: phase8Passes().map(({ descriptor }) => ({ id: descriptor.id, version: descriptor.version, stage: descriptor.stage })),
    },
    quality: { baseline: baselineQuality, candidate: quality },
    safety: {
      ...safetyCounters(observations, baseline),
      architectureBoundaryViolationCount: boundary.length,
      architectureBoundaryViolations: boundary.slice(0, 10),
      staleArtifactAcceptanceCount: artifactFailures.length,
      staleArtifactAcceptanceDetails: artifactFailures,
      transformDeterminismFailureCount: determinism.length,
      transformDeterminismFailures: determinism,
      // Null when performance runs were skipped: not measured, never zero.
      completeResultDivergenceCount: productionDivergences == null ? null : productionDivergences.length,
      completeResultDivergences: productionDivergences ?? [],
      // Measured from P8-5 by recomputing the edge set from each corpus
      // function's CFG and diffing it against the published accounting.
      lostCfgEdgeCount: accounting.lostCfgEdgeCount,
      edgeAccounting: accounting,
      // Measured from P8-6 by recomputing certainty from each published
      // candidate's own evidence.
      forcedTypeContradictionCount: certainty.forcedTypeContradictionCount,
      aggregateCertainty: certainty,
      // Reported evidence, not a frozen gate: the P8-I hard-zero list is fixed
      // at eight counters and this is not one of them.
      providerEvidence: providers,
    },
    // `runs` is dropped: it is several megabytes of observations that exist only
    // to compute the divergence counter, and release evidence has to stay
    // auditable by a human.
    performance: performance == null ? null : { ...performance, runs: undefined },
  };
}
