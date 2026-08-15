import { coarseTokens, compareFingerprints, fingerprintFunction, fingerprintFunctionFast } from '../fingerprint/index.js';
import { maximumWeightCandidateMatchingBounded, solveCandidateMatching } from './bounded-matching.js';
import { createMatchBudget } from './match-budget.js';

export class FunctionMatchIndex {
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
    const maxCandidates = Math.max(1, options.maxCandidates ?? 128);
    const maxBucketScan = Math.max(maxCandidates, options.maxBucketScan ?? 1024);
    const tokenBuckets = coarseTokens(fp).map((token) => ({token,bucket:this.buckets.get(token)})).filter((x) => x.bucket?.length).sort((a,b) => a.bucket.length - b.bucket.length);
    if (!tokenBuckets.length) return [];
    const exact = tokenBuckets.find((x) => x.token.startsWith('nb:') && x.bucket.length <= maxCandidates);
    if (exact) return exact.bucket.slice();
    const scores = new Map();
    const selected = tokenBuckets.slice(0, Math.min(6, tokenBuckets.length));
    for (let rank = 0; rank < selected.length; rank++) {
      const { bucket } = selected[rank]; const scan = Math.min(bucket.length, maxBucketScan);
      // For huge, low-information buckets, deterministic spread sampling avoids O(N) probes.
      const step = bucket.length > scan ? bucket.length / scan : 1;
      for (let k = 0; k < scan; k++) {
        const idx = bucket[Math.min(bucket.length - 1, Math.floor(k * step))];
        const current = scores.get(idx) || {hits:0, rarity:0}; current.hits++; current.rarity += 1 / Math.max(1,bucket.length); scores.set(idx,current);
      }
    }
    return [...scores].sort((a,b) => b[1].hits-a[1].hits || b[1].rarity-a[1].rarity || a[0]-b[0]).slice(0,maxCandidates).map(([i])=>i);
  }
}

function neighborSet(fp) { return new Set([...(fp.callers || []), ...(fp.callees || [])].map(String)); }
function neighborBonus(a, b, anchors) {
  if (!anchors?.size) return 0;
  const A = neighborSet(a), B = neighborSet(b);
  if (!A.size || !B.size) return 0;
  let possible = 0, hits = 0;
  for (const from of A) {
    const to = anchors.get(from);
    if (!to) continue;
    possible++;
    if (B.has(String(to))) hits++;
  }
  return possible ? Math.min(0.08, 0.08 * hits / possible) : 0;
}

// Exact ambiguity solving is implemented only in bounded-matching.js.
export function maximumWeightCandidateMatching(candidates = [], options = {}) {
  return maximumWeightCandidateMatchingBounded(candidates, options);
}

export function matchFunctions(beforeFunctions, afterFunctions, options = {}) {
  const fastMode = options.mode === 'fast';
  const before = beforeFunctions.map((x) => fastMode ? fingerprintFunctionFast(x) : fingerprintFunction(x));
  const after = afterFunctions.map((x) => fastMode ? fingerprintFunctionFast(x) : fingerprintFunction(x));
  const index = new FunctionMatchIndex(after, { mode: fastMode ? 'fast' : 'full' });
  const threshold = options.threshold ?? 0.62;
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
  // Anchor only unique, very strong matches before contextual refinement.
  // Ambiguous strong candidates are deliberately excluded to prevent graph feedback loops.
  const anchors = new Map();
  const byBefore = new Map(); const byAfter = new Map();
  for (const c of all) {
    let left=byBefore.get(c.i); if (!left) byBefore.set(c.i,left=[]); left.push(c);
    let right=byAfter.get(c.j); if (!right) byAfter.set(c.j,right=[]); right.push(c);
  }
  for (const [i, choices] of byBefore) {
    choices.sort((a,b)=>b.baseConfidence-a.baseConfidence || a.j-b.j); const top=choices[0], second=choices[1];
    const reverse=(byAfter.get(top.j)||[]).slice().sort((a,b)=>b.baseConfidence-a.baseConfidence || a.i-b.i); const reverseSecond=reverse.find((x)=>x.i!==i);
    const uniqueLeft=!second || top.baseConfidence-second.baseConfidence>0.06;
    const uniqueRight=!reverseSecond || top.baseConfidence-reverseSecond.baseConfidence>0.06;
    if (top.baseConfidence>=0.9 && uniqueLeft && uniqueRight && before[top.i].address!=null && after[top.j].address!=null) anchors.set(String(before[top.i].address),String(after[top.j].address));
  }
  const iterations = Math.max(0, Math.min(3, options.neighborhoodIterations ?? 2));
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (const c of all) {
      if (c.baseConfidence < 0.55) continue;
      const bonus = neighborBonus(before[c.i], after[c.j], anchors);
      const next = Math.min(0.97, c.baseConfidence + bonus);
      if (next > c.confidence) { c.confidence = next; if (bonus > 0 && !c.reasons.includes('call-neighborhood')) c.reasons.push('call-neighborhood'); changed = true; }
    }
    if (!changed) break;
  }
  const eligible = all.filter((c) => {
    if (c.identity !== 'similar' || options.allowSimilar === true) return true;
    if (c.baseConfidence >= 0.7 && c.confidence >= 0.78 && c.reasons.includes('call-neighborhood')) { c.identity = 'probable-same'; return true; }
    return false;
  });
  const eligibleByBefore = new Map(), eligibleByAfter = new Map();
  for (const c of eligible) {
    let left=eligibleByBefore.get(c.i); if (!left) eligibleByBefore.set(c.i,left=[]); left.push(c);
    let right=eligibleByAfter.get(c.j); if (!right) eligibleByAfter.set(c.j,right=[]); right.push(c);
  }
  for (const list of eligibleByBefore.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.j-b.j);
  for (const list of eligibleByAfter.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.i-b.i);

  const solved = solveCandidateMatching(eligible, budget);
  const selected = solved.selected;
  const usedBefore = new Set(), usedAfter = new Set(), matches = [];
  for (const c of selected) {
    // Ambiguity is evidence about the original candidate distribution, not a
    // side-effect of assignment order. Keep candidates even when another match
    // consumes their after-function.
    const forwardAlternatives = (eligibleByBefore.get(c.i) || []).filter((x) => x.j !== c.j && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ side:'after', index:x.j, address:after[x.j].address, confidence:x.confidence, identity:x.identity, reasons:x.reasons }));
    const reverseAlternatives = (eligibleByAfter.get(c.j) || []).filter((x) => x.i !== c.i && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ side:'before', index:x.i, address:before[x.i].address, confidence:x.confidence, identity:x.identity, reasons:x.reasons }));
    const alternatives = [...forwardAlternatives, ...reverseAlternatives]
      .sort((a,b)=>b.confidence-a.confidence || String(a.side).localeCompare(String(b.side)) || a.index-b.index).slice(0, 4);
    const ambiguous = alternatives.length > 0;
    matches.push({ before: before[c.i], after: after[c.j], confidence: c.confidence, identity: c.identity, reasons: c.reasons, evidence: c.evidence, ambiguous, candidates: alternatives });
    usedBefore.add(c.i); usedAfter.add(c.j);
    if (!ambiguous && c.confidence >= 0.82 && before[c.i].address != null && after[c.j].address != null) anchors.set(String(before[c.i].address), String(after[c.j].address));
  }
  matches.sort((a,b)=>{
    const ai=before.findIndex((x)=>x===a.before), bi=before.findIndex((x)=>x===b.before);
    return ai-bi;
  });
  const deleted = before.filter((_x, i) => !usedBefore.has(i));
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

export function matchFunctionsFast(beforeFunctions, afterFunctions, options = {}) {
  return matchFunctions(beforeFunctions, afterFunctions, { ...options, mode:'fast', neighborhoodIterations:0 });
}

export function recognitionMetrics(expectedPairs, result) {
  const expected = new Set((expectedPairs || []).map(([a,b]) => `${a}>${b}`));
  const predicted = new Set((result.matches || []).filter((m) => !m.ambiguous).map((m) => `${m.before.address}>${m.after.address}`));
  let tp = 0; for (const p of predicted) if (expected.has(p)) tp++;
  const fp = predicted.size - tp, fn = expected.size - tp;
  return {
    truePositive: tp, falsePositive: fp, falseNegative: fn,
    precision: predicted.size ? tp / predicted.size : 1,
    recall: expected.size ? tp / expected.size : 1,
    falseMatchRate: predicted.size ? fp / predicted.size : 0,
    ambiguousRate: result.matches?.length ? result.matches.filter((x) => x.ambiguous).length / result.matches.length : 0,
  };
}

export function calibrationReport(expectedPairs, result, options = {}) {
  const bins = Math.max(2, Math.min(50, Number(options.bins) || 10));
  const expected = new Set((expectedPairs || []).map(([a,b]) => `${a}>${b}`));
  const buckets = Array.from({length:bins}, (_x,index) => ({ lower:index/bins, upper:(index+1)/bins, samples:0, correct:0, meanScore:0 }));
  for (const match of result.matches || []) {
    const score = Math.max(0, Math.min(1, Number(match.confidence) || 0));
    const index = Math.min(bins-1, Math.floor(score*bins)); const bucket=buckets[index];
    bucket.samples++; bucket.meanScore += score;
    if (expected.has(`${match.before.address}>${match.after.address}`)) bucket.correct++;
  }
  for (const bucket of buckets) {
    bucket.meanScore = bucket.samples ? bucket.meanScore / bucket.samples : null;
    bucket.observedPrecision = bucket.samples ? bucket.correct / bucket.samples : null;
  }
  return { scoreKind:'similarity-confidence-v1', calibrated:false, bins:buckets };
}
