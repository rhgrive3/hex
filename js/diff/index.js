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
  const matched=matchFunctions(beforeFunctions,afterFunctions,{threshold:options.threshold ?? 0.55, ambiguityWindow:options.ambiguityWindow ?? 0.04, neighborhoodIterations:options.neighborhoodIterations ?? 2, maxCandidates:options.maxCandidates ?? 128, allowSimilar:options.allowSimilar ?? true});
  const matches=matched.matches.map((m)=>{
    const sameAddress=m.before.address!=null&&m.after.address!=null&&m.before.address===m.after.address;
    let changeType;
    if (m.identity==='exact'||m.identity==='normalized-identical') changeType=sameAddress?'same':'moved';
    else if (m.identity==='semantic-equivalent'||m.identity==='probable-same') changeType='changed';
    else changeType='rewritten';
    const semanticChange=semanticSummary(m.before,m.after);
    return {...m,status:statusFor(changeType),changeType,semanticChange};
  });
  const deleted=(matched.deleted||[]).map((before)=>({before,after:null,status:'deleted',changeType:'deleted',confidence:1,semanticChange:null}));
  const added=(matched.new||[]).map((after)=>({before:null,after,status:'new',changeType:'new',confidence:1,semanticChange:null}));
  const changes=[...matches,...deleted,...added].sort(byAddress);
  return { matches, deleted, new:added, changes, candidatesEvaluated:matched.candidatesEvaluated, indexBuckets:matched.indexBuckets };
}
