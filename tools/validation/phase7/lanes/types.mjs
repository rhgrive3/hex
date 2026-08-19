/**
 * Type lane metrics.
 *
 * Layers are scored separately (§17.6), and the counter the verifier blocks on
 * is `falseCertainty`: a conclusion presented as certain that contradicts exact
 * truth, or that stands on top of an unhandled hard contradiction. No aggregate
 * accuracy figure may override a non-zero false-certainty count.
 *
 * Debug-assisted and no-debug runs are reported side by side so debug ingestion
 * cannot conceal a regression in inference quality.
 */

import { TypeConstraintGraph, certainConclusions, selectedTypeIfCertain } from '../../../../js/analysis/types/graph.js';
import { TYPE_CASES, caseConstraints, caseExpectations } from '../../../../tests/phase7/corpus/types.mjs';

function solveCase(testCase, { withDebug }) {
  const graph = new TypeConstraintGraph({ snapshotId: 'snapshot_type_corpus' });
  const { hard, soft } = caseConstraints(testCase, { withDebug });
  for (const constraint of hard) graph.addHardConstraint(constraint);
  for (const evidence of soft) graph.addSoftEvidence(evidence);
  return graph.solveEntity(testCase.entityId);
}

function scoreRun({ withDebug }) {
  const perCase = [];
  let falseCertainty = 0;
  let missedCertainty = 0;
  let missedContradictions = 0;
  let correctSelections = 0;
  let scoredSelections = 0;

  for (const testCase of TYPE_CASES) {
    const result = solveCase(testCase, { withDebug });
    const expectations = caseExpectations(testCase, { withDebug });
    const layers = Object.keys(result.layers);
    const certain = certainConclusions(result).map((entry) => entry.layer);

    for (const layer of layers) {
      const solved = result.layers[layer];
      const truth = expectations.truth?.[layer];

      if (truth === null) {
        // The corpus says no selection is correct here. Presenting one as
        // certain is false certainty; presenting it as probable is a precision
        // problem tracked separately.
        if (solved.confidence === 'certain') falseCertainty += 1;
      } else if (truth != null) {
        scoredSelections += 1;
        const selected = solved.selected?.descriptor ?? null;
        const matches = selected != null && Object.entries(truth).every(([key, value]) => (
          JSON.stringify(selected[key]) === JSON.stringify(value)
        ));
        if (matches) correctSelections += 1;
        else if (solved.confidence === 'certain') falseCertainty += 1;
      }

      const expectedContradiction = expectations.expectContradiction.includes(layer);
      if (expectedContradiction && solved.contradictions.length === 0) missedContradictions += 1;
    }

    for (const layer of expectations.expectCertain) {
      if (!certain.includes(layer)) missedCertainty += 1;
    }
    for (const layer of expectations.expectAmbiguous) {
      if (result.layers[layer]?.confidence !== 'unknown') falseCertainty += 1;
    }

    perCase.push({
      id: testCase.id,
      certain,
      contradictions: result.contradictions.length,
      confidences: Object.fromEntries(layers.map((layer) => [layer, result.layers[layer].confidence])),
      userConstrained: result.userConstrained,
    });
  }

  return {
    total: TYPE_CASES.length,
    falseCertainty,
    missedCertainty,
    missedContradictions,
    correctSelections,
    scoredSelections,
    accuracy: scoredSelections === 0 ? 0 : correctSelections / scoredSelections,
    perCase,
  };
}

export function collectTypeMetrics() {
  const withDebug = scoreRun({ withDebug: true });
  const withoutDebug = scoreRun({ withDebug: false });

  // A consumer that prints a type as fact must go through selectedTypeIfCertain.
  // Verify it refuses on a contradicted layer, so the guard is exercised rather
  // than merely present.
  const contradicted = TYPE_CASES.find((testCase) => (testCase.expectContradiction ?? []).length > 0);
  const contradictedResult = solveCase(contradicted, { withDebug: true });
  const guardHolds = selectedTypeIfCertain(contradictedResult, contradicted.expectContradiction[0]) == null;

  return {
    available: true,
    candidate: {
      falseCertainty: withDebug.falseCertainty + withoutDebug.falseCertainty,
      accuracy: withDebug.accuracy,
      missedCertainty: withDebug.missedCertainty,
      missedContradictions: withDebug.missedContradictions,
    },
    // Reported separately so debug ingestion cannot hide an inference
    // regression behind DWARF/PDB accuracy (§11.4).
    debugAssisted: withDebug,
    noDebug: withoutDebug,
    guardHolds,
  };
}
