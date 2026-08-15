export const DEFAULT_MATCH_BUDGET = Object.freeze({
  // Preprocessing is deliberately budgeted separately from candidate/solver
  // work: raw-function fingerprinting can dominate both CPU and memory.
  maxPreprocessFunctions: 700_000,
  maxPreprocessInputBytes: 256 * 1024 * 1024,
  maxPreprocessEstimatedBytes: 256 * 1024 * 1024,
  maxPreprocessWork: 4_000_000,
  maxIndexEntries: 2_000_000,
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

function arrayLength(value) { return Array.isArray(value) ? value.length : 0; }
function rawFunctionCost(fn) {
  const precomputed = fn?.schema === 'hex.function-fingerprint' || fn?.schema === 'hex.function-fingerprint-fast';
  if (precomputed) return { inputBytes:0, estimatedBytes:320, work:1 };
  const bytes = Number(fn?.bytes?.byteLength ?? fn?.bytes?.length ?? 0);
  const inputBytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
  const instructions = arrayLength(fn?.instructions);
  const blocks = Array.isArray(fn?.cfg?.blocks) ? fn.cfg.blocks.length : 0;
  const metadata = arrayLength(fn?.strings) + arrayLength(fn?.imports) + arrayLength(fn?.calls)
    + arrayLength(fn?.constants) + arrayLength(fn?.relocationOffsets) + arrayLength(fn?.relocationRanges);
  const semantic = fn?.semantic || fn?.irSemantic || {};
  const semanticItems = arrayLength(semantic.reads) + arrayLength(semantic.writes) + arrayLength(semantic.rmw)
    + arrayLength(semantic.calls) + arrayLength(semantic.thresholds) + arrayLength(semantic.operations);
  // The estimate is intentionally conservative. fingerprintFunction copies
  // relocation-normalized bytes and creates normalized instruction/metadata
  // arrays, so count both bounded byte sampling and object/string overhead.
  const estimatedBytes = 768 + Math.min(inputBytes, 4096) + instructions * 48 + blocks * 96
    + metadata * 48 + semanticItems * 48;
  const work = 1 + Math.ceil(inputBytes / 64) + instructions + blocks * 2 + metadata + semanticItems;
  return { inputBytes, estimatedBytes, work };
}

export function createMatchBudget(overrides = {}) {
  const limits = {
    maxPreprocessFunctions: limit(overrides.maxPreprocessFunctions, DEFAULT_MATCH_BUDGET.maxPreprocessFunctions),
    maxPreprocessInputBytes: limit(overrides.maxPreprocessInputBytes, DEFAULT_MATCH_BUDGET.maxPreprocessInputBytes),
    maxPreprocessEstimatedBytes: limit(overrides.maxPreprocessEstimatedBytes, DEFAULT_MATCH_BUDGET.maxPreprocessEstimatedBytes),
    maxPreprocessWork: limit(overrides.maxPreprocessWork, DEFAULT_MATCH_BUDGET.maxPreprocessWork),
    maxIndexEntries: limit(overrides.maxIndexEntries, DEFAULT_MATCH_BUDGET.maxIndexEntries),
    maxCandidateEvaluations: limit(overrides.maxCandidateEvaluations, DEFAULT_MATCH_BUDGET.maxCandidateEvaluations),
    maxCandidateEdges: limit(overrides.maxCandidateEdges, DEFAULT_MATCH_BUDGET.maxCandidateEdges),
    maxComponentNodes: limit(overrides.maxComponentNodes, DEFAULT_MATCH_BUDGET.maxComponentNodes),
    maxComponentEdges: limit(overrides.maxComponentEdges, DEFAULT_MATCH_BUDGET.maxComponentEdges),
    maxSolverRelaxations: limit(overrides.maxSolverRelaxations, DEFAULT_MATCH_BUDGET.maxSolverRelaxations),
    maxSolverAugmentations: limit(overrides.maxSolverAugmentations, DEFAULT_MATCH_BUDGET.maxSolverAugmentations),
    maxWallMs: limit(overrides.maxWallMs, DEFAULT_MATCH_BUDGET.maxWallMs),
  };
  const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
  const signal = overrides.signal || null;
  const started = now();
  let preprocessFunctions = 0;
  let preprocessInputBytes = 0;
  let preprocessEstimatedBytes = 0;
  let preprocessWork = 0;
  let fingerprintsBuilt = 0;
  let indexEntries = 0;
  let candidateEvaluations = 0;
  let candidateEdges = 0;
  let solverRelaxations = 0;
  let solverAugmentations = 0;
  let oversizedComponents = 0;
  let truncated = false;
  let candidateGraphIncomplete = false;
  let preprocessingIncomplete = false;
  let reason = null;

  const stop = (message, incomplete = false, preprocessing = false) => {
    truncated = true;
    if (incomplete) candidateGraphIncomplete = true;
    if (preprocessing) preprocessingIncomplete = true;
    if (reason == null) reason = message;
    return false;
  };
  const wallOkay = (stage, incomplete = false, preprocessing = false) => {
    if (truncated) return false;
    if (signal?.aborted) return stop(`${stage} aborted`, incomplete, preprocessing);
    if (now() - started > limits.maxWallMs) return stop(`${stage} exceeded ${limits.maxWallMs} ms wall-clock budget`, incomplete, preprocessing);
    return true;
  };

  return {
    limits,
    get truncated() { return truncated; },
    get globalTruncated() { return truncated; },
    get candidateGraphIncomplete() { return candidateGraphIncomplete; },
    get preprocessingIncomplete() { return preprocessingIncomplete; },
    get reason() { return reason; },
    preprocess(fn, stage = 'fingerprint preprocessing') {
      if (truncated) return false;
      if (!wallOkay(stage, true, true)) return false;
      const cost = rawFunctionCost(fn);
      if (preprocessFunctions >= limits.maxPreprocessFunctions) return stop(`preprocessing functions exceed ${limits.maxPreprocessFunctions}`, true, true);
      if (cost.inputBytes > limits.maxPreprocessInputBytes - preprocessInputBytes) return stop(`preprocessing input bytes exceed ${limits.maxPreprocessInputBytes}`, true, true);
      if (cost.estimatedBytes > limits.maxPreprocessEstimatedBytes - preprocessEstimatedBytes) return stop(`preprocessing estimated memory exceeds ${limits.maxPreprocessEstimatedBytes} bytes`, true, true);
      if (cost.work > limits.maxPreprocessWork - preprocessWork) return stop(`preprocessing work exceeds ${limits.maxPreprocessWork}`, true, true);
      preprocessFunctions++;
      preprocessInputBytes += cost.inputBytes;
      preprocessEstimatedBytes += cost.estimatedBytes;
      preprocessWork += cost.work;
      return true;
    },
    fingerprinted() {
      fingerprintsBuilt++;
      return !truncated;
    },
    indexEntry() {
      if (truncated) return false;
      if (indexEntries >= limits.maxIndexEntries) return stop(`index entries exceed ${limits.maxIndexEntries}`, true, true);
      indexEntries++;
      return (indexEntries & 0xfff) === 0 ? wallOkay('fingerprint index construction', true, true) : true;
    },
    checkPreprocessWall(stage = 'fingerprint preprocessing') { return wallOkay(stage, true, true); },
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
        preprocessFunctions,
        preprocessInputBytes,
        preprocessEstimatedBytes,
        preprocessWork,
        fingerprintsBuilt,
        indexEntries,
        candidateEvaluations,
        candidateEdges: Math.min(candidateEdges, limits.maxCandidateEdges),
        solverRelaxations,
        solverAugmentations,
        oversizedComponents,
        truncated,
        candidateGraphIncomplete,
        preprocessingIncomplete,
        reason,
      };
    },
  };
}
