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
  if (addedConstants.length) tags.push('constants-added'); if (removedConstants.length) tags.push('constants-removed');
  if (addedCalls.length) tags.push('calls-added'); if (removedCalls.length) tags.push('calls-removed');
  if (addedWrites.length||removedWrites.length) tags.push('write-set-changed');
  const deltaCount=addedConstants.length+removedConstants.length+addedCalls.length+removedCalls.length+addedWrites.length+removedWrites.length;
  return { changed:!!(tags.length||deltaCount), tags, deltaCount, addedConstants, removedConstants, addedCalls, removedCalls, addedWrites, removedWrites };
}

function classifyMatch(m, semanticChange) {
  const sameAddress=m.before.address!=null&&m.after.address!=null&&m.before.address===m.after.address;
  if (m.identity==='exact'||m.identity==='normalized-identical') return { changeType:sameAddress?'same':'moved', status:sameAddress?'identical':'moved', severity:'none' };
  const structuralDelta = (() => {
    const before=m.before.cfg||{}, after=m.after.cfg||{};
    const keys=['blocks','edges','exits'];
    return keys.reduce((n,key)=>n+Number(before[key]!=null&&after[key]!=null&&before[key]!==after[key]),0);
  })();
  if (m.identity==='semantic-equivalent'||m.identity==='probable-same') {
    const major = structuralDelta>=2 || semanticChange.deltaCount>=4 || Number(m.confidence)<0.72;
    return { changeType:'changed', status:major?'substantially changed':'slightly changed', severity:major?'major':'minor' };
  }
  return { changeType:'rewritten', status:'rewritten', severity:'major' };
}

export function diffFunctions(beforeFunctions, afterFunctions, options = {}) {
  const matched=matchFunctions(beforeFunctions,afterFunctions,{threshold:options.threshold ?? 0.55, ambiguityWindow:options.ambiguityWindow ?? 0.04, neighborhoodIterations:options.neighborhoodIterations ?? 2, maxCandidates:options.maxCandidates ?? 128, allowSimilar:options.allowSimilar ?? true});
  const matches=matched.matches.map((m)=>{
    const semanticChange=semanticSummary(m.before,m.after);
    const classification=classifyMatch(m,semanticChange);
    return {...m,...classification,semanticChange};
  });
  const deleted=matched.deleted.map((before)=>({status:'deleted',changeType:'deleted',severity:'major',before,after:null,confidence:1,reasons:['unmatched'],semanticChange:null}));
  const added=matched.new.map((after)=>({status:'new',changeType:'new',severity:'major',before:null,after,confidence:1,reasons:['unmatched'],semanticChange:null}));
  matches.sort(byAddress); deleted.sort(byAddress); added.sort(byAddress);
  return { matches, deleted, new:added, results:[...matches,...deleted,...added], stats:{before:beforeFunctions.length,after:afterFunctions.length,matched:matches.length,identical:matches.filter((x)=>x.changeType==='same').length,moved:matches.filter((x)=>x.changeType==='moved').length,changed:matches.filter((x)=>x.changeType==='changed').length,rewritten:matches.filter((x)=>x.changeType==='rewritten').length,deleted:deleted.length,new:added.length,candidatesEvaluated:matched.candidatesEvaluated} };
}
