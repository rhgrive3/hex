export const DEFAULT_MATCH_BUDGET = Object.freeze({
  maxCandidateEvaluations: 500_000,
  maxCandidateEdges: 100_000,
  maxComponentNodes: 2_048,
  maxComponentEdges: 20_000,
  maxSolverRelaxations: 500_000,
  maxSolverAugmentations: 2_048,
  maxWallMs: 2_000,
});

function limit(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function createMatchBudget(overrides = {}) {
  const limits = {
    maxCandidateEvaluations: limit(overrides.maxCandidateEvaluations, DEFAULT_MATCH_BUDGET.maxCandidateEvaluations),
    maxCandidateEdges: limit(overrides.maxCandidateEdges, DEFAULT_MATCH_BUDGET.maxCandidateEdges),
    maxComponentNodes: limit(overrides.maxComponentNodes, DEFAULT_MATCH_BUDGET.maxComponentNodes),
    maxComponentEdges: limit(overrides.maxComponentEdges, DEFAULT_MATCH_BUDGET.maxComponentEdges),
    maxSolverRelaxations: limit(overrides.maxSolverRelaxations, DEFAULT_MATCH_BUDGET.maxSolverRelaxations),
    maxSolverAugmentations: limit(overrides.maxSolverAugmentations, DEFAULT_MATCH_BUDGET.maxSolverAugmentations),
    maxWallMs: limit(overrides.maxWallMs, DEFAULT_MATCH_BUDGET.maxWallMs),
  };
  const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
  const started = now();
  let candidateEvaluations = 0;
  let candidateEdges = 0;
  let solverRelaxations = 0;
  let solverAugmentations = 0;
  let oversizedComponents = 0;
  let truncated = false;
  let candidateGraphIncomplete = false;
  let reason = null;

  const stop = (message, incomplete = false) => {
    truncated = true;
    if (incomplete) candidateGraphIncomplete = true;
    if (reason == null) reason = message;
    return false;
  };
  const wallOkay = (stage, incomplete = false) => {
    if (truncated) return false;
    if (now() - started > limits.maxWallMs) return stop(`${stage} exceeded ${limits.maxWallMs} ms wall-clock budget`, incomplete);
    return true;
  };

  return {
    limits,
    get truncated() { return truncated; },
    get globalTruncated() { return truncated; },
    get candidateGraphIncomplete() { return candidateGraphIncomplete; },
    get reason() { return reason; },
    candidate() {
      if (truncated) return false;
      candidateEvaluations++;
      if (candidateEvaluations > limits.maxCandidateEvaluations) return stop(`candidate evaluations exceeded ${limits.maxCandidateEvaluations}`, true);
      return (candidateEvaluations & 0xfff) === 0 ? wallOkay('candidate generation', true) : true;
    },
    edge() {
      if (truncated) return false;
      candidateEdges++;
      if (candidateEdges > limits.maxCandidateEdges) return stop(`candidate edges exceeded ${limits.maxCandidateEdges}`, true);
      return true;
    },
    checkCandidateWall() { return wallOkay('candidate generation', true); },
    checkSolverWall(stage = 'matching') { return wallOkay(stage, false); },
    allowComponent(nodeCount, edgeCount) {
      if (nodeCount > limits.maxComponentNodes || edgeCount > limits.maxComponentEdges) {
        oversizedComponents++;
        return false;
      }
      return wallOkay('component solving', false);
    },
    solverRelaxation() {
      if (truncated) return false;
      solverRelaxations++;
      if (solverRelaxations > limits.maxSolverRelaxations) return stop(`solver relaxations exceeded ${limits.maxSolverRelaxations}`);
      return (solverRelaxations & 0xfff) === 0 ? wallOkay('exact solver', false) : true;
    },
    solverAugmentation() {
      if (truncated) return false;
      solverAugmentations++;
      if (solverAugmentations > limits.maxSolverAugmentations) return stop(`solver augmentations exceeded ${limits.maxSolverAugmentations}`);
      return true;
    },
    snapshot() {
      return {
        ...limits,
        candidateEvaluations,
        candidateEdges: Math.min(candidateEdges, limits.maxCandidateEdges),
        solverRelaxations,
        solverAugmentations,
        oversizedComponents,
        truncated,
        candidateGraphIncomplete,
        reason,
      };
    },
  };
}
