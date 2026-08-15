from pathlib import Path

p=Path('js/recognition/matcher.js')
text=p.read_text()

old="""export class FunctionMatchIndex {
  constructor(functions = [], options = {}) {
    const mode = options.mode || 'fast';
    this.items = functions.map((x) => mode === 'full' ? fingerprintFunction(x) : fingerprintFunctionFast(x));
    this.buckets = new Map();
    for (let i = 0; i < this.items.length; i++) {
      for (const token of coarseTokens(this.items[i])) {
        let bucket = this.buckets.get(token);
        if (!bucket) this.buckets.set(token, bucket = []);
        bucket.push(i);
      }
    }
  }
  candidates(input, options = {}) {
    const fp = fingerprintFunctionFast(input);
"""
new="""export class FunctionMatchIndex {
  constructor(functions = [], options = {}) {
    const mode = options.mode || 'fast';
    this.budget = options.budget || createMatchBudget(options.matchBudget || {});
    this.items = [];
    this.buckets = new Map();
    this.complete = true;
    indexBuild:
    for (const raw of functions || []) {
      if (!this.budget.preprocess(raw, 'after fingerprint preprocessing')) { this.complete = false; break; }
      const fp = mode === 'full' ? fingerprintFunction(raw) : fingerprintFunctionFast(raw);
      this.budget.fingerprinted();
      const index = this.items.length;
      this.items.push(fp);
      for (const token of coarseTokens(fp)) {
        if (!this.budget.indexEntry()) { this.complete = false; break indexBuild; }
        let bucket = this.buckets.get(token);
        if (!bucket) this.buckets.set(token, bucket = []);
        bucket.push(index);
      }
      if (!this.budget.checkPreprocessWall('fingerprint index construction')) { this.complete = false; break; }
    }
    if (this.budget.preprocessingIncomplete) this.complete = false;
  }
  candidates(input, options = {}) {
    const fp = input?.schema === 'hex.function-fingerprint' || input?.schema === 'hex.function-fingerprint-fast'
      ? input
      : fingerprintFunctionFast(input);
"""
if new not in text:
    if old not in text: raise SystemExit('FunctionMatchIndex anchor not found')
    text=text.replace(old,new,1)

old="""export function matchFunctions(beforeFunctions, afterFunctions, options = {}) {
  const fastMode = options.mode === 'fast';
  const before = beforeFunctions.map((x) => fastMode ? fingerprintFunctionFast(x) : fingerprintFunction(x));
  const after = afterFunctions.map((x) => fastMode ? fingerprintFunctionFast(x) : fingerprintFunction(x));
  const index = new FunctionMatchIndex(after, { mode: fastMode ? 'fast' : 'full' });
  const threshold = options.threshold ?? 0.62;
  const ambiguityWindow = options.ambiguityWindow ?? 0.035;
  const budget = createMatchBudget(options.matchBudget || {});
  const all = [];
"""
new="""export function matchFunctions(beforeFunctions = [], afterFunctions = [], options = {}) {
  const fastMode = options.mode === 'fast';
  // Start every time/abort/memory/work budget before the first raw function is
  // fingerprinted. This is the trust boundary for the full matching pipeline.
  const budget = createMatchBudget(options.matchBudget || {});
  const incompletePreprocessing = (index = null) => {
    const matchingBudget = budget.snapshot();
    return {
      matches: [],
      // Do not allocate another O(N) copy on the failure path. Consumers must
      // inspect matching.truncated / candidateGraphIncomplete before treating
      // these unmatched inputs as definitive deletions/additions.
      deleted: beforeFunctions,
      new: afterFunctions,
      unresolvedBefore: beforeFunctions,
      unresolvedAfter: afterFunctions,
      candidatesEvaluated: 0,
      candidateComparisons: matchingBudget.candidateEvaluations,
      indexBuckets: index?.buckets?.size || 0,
      truncated: true,
      ambiguous: true,
      matching: {
        truncated: true,
        candidateGraphIncomplete: true,
        preprocessingIncomplete: true,
        ambiguousBefore: beforeFunctions.length,
        ambiguousAfter: afterFunctions.length,
        truncatedComponents: [],
        budget: matchingBudget,
      },
    };
  };

  // Build the after-side fingerprint/index incrementally. No all-function map
  // exists before the budget can stop the work.
  const index = new FunctionMatchIndex(afterFunctions, { mode: fastMode ? 'fast' : 'full', budget });
  if (!index.complete || budget.preprocessingIncomplete) return incompletePreprocessing(index);
  const after = index.items;

  // Fingerprint the before side incrementally under the same aggregate budget.
  const before = [];
  for (const raw of beforeFunctions) {
    if (!budget.preprocess(raw, 'before fingerprint preprocessing')) return incompletePreprocessing(index);
    before.push(fastMode ? fingerprintFunctionFast(raw) : fingerprintFunction(raw));
    budget.fingerprinted();
    if (!budget.checkPreprocessWall('before fingerprint preprocessing')) return incompletePreprocessing(index);
  }

  const threshold = options.threshold ?? 0.62;
  const ambiguityWindow = options.ambiguityWindow ?? 0.035;
  const all = [];
"""
if new not in text:
    if old not in text: raise SystemExit('matchFunctions preprocessing anchor not found')
    text=text.replace(old,new,1)

old="""  candidateGeneration:
  for (let i = 0; i < before.length; i++) {
    const candidateIds = index.candidates(before[i], options);
"""
new="""  candidateGeneration:
  for (let i = 0; i < before.length; i++) {
    // A zero-candidate lookup still performs bounded bucket work; check the
    // wall/abort budget before every lookup so empty graphs cannot bypass it.
    if (!budget.checkCandidateWall()) break candidateGeneration;
    const candidateIds = index.candidates(before[i], options);
"""
if new not in text:
    if old not in text: raise SystemExit('candidate lookup wall anchor not found')
    text=text.replace(old,new,1)

old="""      matching: {
        truncated: true, candidateGraphIncomplete: true,
        ambiguousBefore: before.length, ambiguousAfter: after.length,
        truncatedComponents: [], budget: matchingBudget,
      },
"""
new="""      unresolvedBefore: before,
      unresolvedAfter: after,
      matching: {
        truncated: true, candidateGraphIncomplete: true,
        preprocessingIncomplete: !!matchingBudget.preprocessingIncomplete,
        ambiguousBefore: before.length, ambiguousAfter: after.length,
        truncatedComponents: [], budget: matchingBudget,
      },
"""
if new not in text:
    if old not in text: raise SystemExit('candidate incomplete result anchor not found')
    text=text.replace(old,new,1)

old="""    matching: {
      truncated,
      candidateGraphIncomplete: false,
      ambiguousBefore: solved.ambiguousLeft.size,
      ambiguousAfter: solved.ambiguousRight.size,
      truncatedComponents,
"""
new="""    unresolvedBefore: truncated ? before.filter((_x, i) => solved.ambiguousLeft.has(i)) : [],
    unresolvedAfter: truncated ? after.filter((_x, i) => solved.ambiguousRight.has(i)) : [],
    matching: {
      truncated,
      candidateGraphIncomplete: false,
      preprocessingIncomplete: false,
      ambiguousBefore: solved.ambiguousLeft.size,
      ambiguousAfter: solved.ambiguousRight.size,
      truncatedComponents,
"""
if new not in text:
    if old not in text: raise SystemExit('solver result anchor not found')
    text=text.replace(old,new,1)

p.write_text(text)
