from pathlib import Path

p=Path('js/recognition/matcher.js')
text=p.read_text()

old="import { coarseTokens, compareFingerprints, fingerprintFunction, fingerprintFunctionFast } from '../fingerprint/index.js';\n"
new="""import { coarseTokens, compareFingerprints, fingerprintFunction, fingerprintFunctionFast } from '../fingerprint/index.js';
import { maximumWeightCandidateMatchingBounded, solveCandidateMatching } from './bounded-matching.js';
import { createMatchBudget } from './match-budget.js';
"""
if new not in text:
    if old not in text: raise SystemExit('import anchor not found')
    text=text.replace(old,new,1)

old="""export function maximumWeightCandidateMatching(candidates = []) {
  const selected = [];
  for (const component of candidateComponents(candidates)) selected.push(...maximumWeightComponent(component));
  return selected.sort((a,b)=>a.i-b.i || a.j-b.j);
}
"""
new="""export function maximumWeightCandidateMatching(candidates = [], options = {}) {
  return maximumWeightCandidateMatchingBounded(candidates, options);
}
"""
if new not in text:
    if old not in text: raise SystemExit('maximumWeightCandidateMatching anchor not found')
    text=text.replace(old,new,1)

old="""  const threshold = options.threshold ?? 0.62;
  const ambiguityWindow = options.ambiguityWindow ?? 0.035;
  const all = [];
  for (let i = 0; i < before.length; i++) {
    const candidateIds = index.candidates(before[i], options);
    for (const j of candidateIds) {
      const cmp = compareFingerprints(before[i], after[j]);
      if (cmp.confidence < threshold || cmp.identity === 'unrelated') continue;
      if (options.isRejected?.(before[i], after[j])) continue;
      all.push({ i, j, ...cmp, baseConfidence: cmp.confidence });
    }
  }
"""
new="""  const threshold = options.threshold ?? 0.62;
  const ambiguityWindow = options.ambiguityWindow ?? 0.035;
  const budget = createMatchBudget(options.matchBudget || {});
  const all = [];
  candidateGeneration:
  for (let i = 0; i < before.length; i++) {
    const candidateIds = index.candidates(before[i], options);
    for (const j of candidateIds) {
      if (!budget.candidate()) break candidateGeneration;
      const cmp = compareFingerprints(before[i], after[j]);
      if (cmp.confidence < threshold || cmp.identity === 'unrelated') continue;
      if (options.isRejected?.(before[i], after[j])) continue;
      if (!budget.edge()) break candidateGeneration;
      all.push({ i, j, ...cmp, baseConfidence: cmp.confidence });
    }
  }
  if (!budget.candidateGraphIncomplete) budget.checkCandidateWall();
  if (budget.candidateGraphIncomplete) {
    const matchingBudget = budget.snapshot();
    return {
      matches: [], deleted: before.slice(), new: after.slice(),
      candidatesEvaluated: all.length, candidateComparisons: matchingBudget.candidateEvaluations,
      indexBuckets: index.buckets.size, truncated: true, ambiguous: true,
      matching: {
        truncated: true, candidateGraphIncomplete: true,
        ambiguousBefore: before.length, ambiguousAfter: after.length,
        truncatedComponents: [], budget: matchingBudget,
      },
    };
  }
"""
if new not in text:
    if old not in text: raise SystemExit('candidate generation anchor not found')
    text=text.replace(old,new,1)

old="""  const selected = maximumWeightCandidateMatching(eligible);
  const usedBefore = new Set(), usedAfter = new Set(), matches = [];
"""
new="""  const solved = solveCandidateMatching(eligible, budget);
  const selected = solved.selected;
  const usedBefore = new Set(), usedAfter = new Set(), matches = [];
"""
if new not in text:
    if old not in text: raise SystemExit('selected anchor not found')
    text=text.replace(old,new,1)

old="""  const deleted = before.filter((_x, i) => !usedBefore.has(i));
  const added = after.filter((_x, i) => !usedAfter.has(i));
  return { matches, deleted, new: added, candidatesEvaluated: all.length, indexBuckets: index.buckets.size };
}
"""
new="""  const deleted = before.filter((_x, i) => !usedBefore.has(i));
  const added = after.filter((_x, i) => !usedAfter.has(i));
  const matchingBudget = budget.snapshot();
  const truncatedComponents = solved.truncatedComponents.slice(0, 32);
  const truncated = matchingBudget.truncated || solved.truncatedComponents.length > 0;
  return {
    matches, deleted, new: added,
    candidatesEvaluated: all.length,
    candidateComparisons: matchingBudget.candidateEvaluations,
    indexBuckets: index.buckets.size,
    truncated,
    ambiguous: truncated,
    matching: {
      truncated,
      candidateGraphIncomplete: false,
      ambiguousBefore: solved.ambiguousLeft.size,
      ambiguousAfter: solved.ambiguousRight.size,
      truncatedComponents,
      omittedTruncatedComponents: Math.max(0, solved.truncatedComponents.length - truncatedComponents.length),
      budget: matchingBudget,
    },
  };
}
"""
if new not in text:
    if old not in text: raise SystemExit('return anchor not found')
    text=text.replace(old,new,1)

p.write_text(text)
