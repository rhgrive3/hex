import { compareFingerprints, fingerprintFunction } from '../fingerprint/index.js';
import { matchFunctions } from '../recognition/matcher.js';
export { compareFingerprints, fingerprintFunction };

function byAddress(a,b) { const x=a.before?.address??a.after?.address??0n, y=b.before?.address??b.after?.address??0n; return x<y?-1:x>y?1:0; }
function setDiff(a,b) { const B=new Set(b||[]); return [...new Set(a||[])].filter((x)=>!B.has(x)); }
function semanticSummary(before,after) {
  const b=before.semantic || {}, a=after.semantic || {};
  const addedConstants=setDiff(after.constants,before.constants), removedConstants=setDiff(before.constants,after.constants);
  const addedCalls=setDiff(after.calls,before.calls), removedCalls=setDiff(before.calls,after.calls);
  const addedWrites=setDiff(a.writes,b.writes), removedWrites=setDiff(b.writes,a.writes);
  const beforeOps=new Set(b.operations||[]), afterOps=new Set(a.operations||[]);
  const clampBefore=[...beforeOps].some((x)=>/clamp|min|max|saturat/i.test(x));
  const clampAfter=[...afterOps].some((x)=>/clamp|min|max|saturat/i.test(x));
  const tags=[]; if (!clampBefore && clampAfter) tags.push('clamp-introduced'); if (clampBefore && !clampAfter) tags.push('clamp-removed');
  if (addedConstants.length) tags.push('constants-added'); if (addedCalls.length) tags.push('calls-added'); if (addedWrites.length||removedWrites.length) tags.push('write-set-changed');
  return { changed:!!(tags.length||removedConstants.length||removedCalls.length), tags, addedConstants, removedConstants, addedCalls, removedCalls, addedWrites, removedWrites };
}

function statusFor(changeType) {
  if (changeType === 'same') return 'identical';
  if (changeType === 'moved') return 'moved';
  if (changeType === 'rewritten') return 'rewritten';
  return 'slightly changed';
}

export function diffFunctions(beforeFunctions, afterFunctions, options = {}) {
  const matched=matchFunctions(beforeFunctions,afterFunctions,{
    threshold:options.threshold ?? 0.55,
    ambiguityWindow:options.ambiguityWindow ?? 0.04,
    neighborhoodIterations:options.neighborhoodIterations ?? 2,
    maxCandidates:options.maxCandidates ?? 128,
    maxBucketScan:options.maxBucketScan,
    allowSimilar:options.allowSimilar ?? true,
    matchBudget:options.matchBudget,
  });
  const matches=matched.matches.map((m)=>{
    const sameAddress=m.before.address!=null&&m.after.address!=null&&m.before.address===m.after.address;
    let changeType;
    if (m.identity==='exact'||m.identity==='normalized-identical') changeType=sameAddress?'same':'moved';
    else if (m.identity==='semantic-equivalent'||m.identity==='probable-same') changeType='changed';
    else changeType='rewritten';
    const semanticChange=semanticSummary(m.before,m.after);
    return {...m,status:statusFor(changeType),changeType,semanticChange};
  });
  const matchingIncomplete = matched.truncated === true
    || matched.ambiguous === true
    || matched.matching?.truncated === true
    || matched.matching?.candidateGraphIncomplete === true;
  const incompleteReason = matched.matching?.budget?.reason
    || matched.matching?.truncatedComponents?.[0]?.reason
    || (matched.matching?.candidateGraphIncomplete ? 'candidate-graph-incomplete' : 'matching-incomplete');

  let deleted=[];
  let added=[];
  let unresolved=[];
  if (matchingIncomplete) {
    // Matcher budgets are a trust boundary. With an incomplete global graph we
    // cannot prove that any unmatched before/after is truly deleted/new. Even
    // when truncation is component-local, matcher.js currently exposes only
    // aggregate unresolved counts, not stable member identities; conservatively
    // keep every unmatched function unresolved rather than invent certainty.
    const unresolvedBefore=(matched.deleted||[]).map((before)=>({
      before,after:null,status:'unresolved',changeType:'unresolved',confidence:0,
      semanticChange:null,reason:incompleteReason,side:'before',
    }));
    const unresolvedAfter=(matched.new||[]).map((after)=>({
      before:null,after,status:'unresolved',changeType:'unresolved',confidence:0,
      semanticChange:null,reason:incompleteReason,side:'after',
    }));
    unresolved=[...unresolvedBefore,...unresolvedAfter];
  } else {
    deleted=(matched.deleted||[]).map((before)=>({before,after:null,status:'deleted',changeType:'deleted',confidence:1,semanticChange:null}));
    added=(matched.new||[]).map((after)=>({before:null,after,status:'new',changeType:'new',confidence:1,semanticChange:null}));
  }
  const changes=[...matches,...deleted,...added,...unresolved].sort(byAddress);
  return {
    matches, deleted, new:added, unresolved, changes,
    complete:!matchingIncomplete,
    truncated:!!matched.truncated,
    ambiguous:!!matched.ambiguous,
    matching:matched.matching || null,
    candidatesEvaluated:matched.candidatesEvaluated,
    candidateComparisons:matched.candidateComparisons,
    indexBuckets:matched.indexBuckets,
  };
}
