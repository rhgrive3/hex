from pathlib import Path

p=Path('js/diff/index.js')
text=p.read_text()
old="""export function diffFunctions(beforeFunctions, afterFunctions, options = {}) {
  const matched=matchFunctions(beforeFunctions,afterFunctions,{threshold:options.threshold ?? 0.55, ambiguityWindow:options.ambiguityWindow ?? 0.04, neighborhoodIterations:options.neighborhoodIterations ?? 2, maxCandidates:options.maxCandidates ?? 128, allowSimilar:options.allowSimilar ?? true});
"""
new="""export function diffFunctions(beforeFunctions, afterFunctions, options = {}) {
  const matched=matchFunctions(beforeFunctions,afterFunctions,{
    threshold:options.threshold ?? 0.55,
    ambiguityWindow:options.ambiguityWindow ?? 0.04,
    neighborhoodIterations:options.neighborhoodIterations ?? 2,
    maxCandidates:options.maxCandidates ?? 128,
    maxBucketScan:options.maxBucketScan,
    allowSimilar:options.allowSimilar ?? true,
    matchBudget:options.matchBudget,
  });
"""
if new not in text:
    if old not in text: raise SystemExit('diff match options anchor not found')
    text=text.replace(old,new,1)
old="""  const deleted=(matched.deleted||[]).map((before)=>({before,after:null,status:'deleted',changeType:'deleted',confidence:1,semanticChange:null}));
  const added=(matched.new||[]).map((after)=>({before:null,after,status:'new',changeType:'new',confidence:1,semanticChange:null}));
  const changes=[...matches,...deleted,...added].sort(byAddress);
  return { matches, deleted, new:added, changes, candidatesEvaluated:matched.candidatesEvaluated, indexBuckets:matched.indexBuckets };
}
"""
new="""  const matchingIncomplete = matched.truncated === true
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
"""
if new not in text:
    if old not in text: raise SystemExit('diff result anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)

p=Path('tests/diff-platform.mjs')
text=p.read_text()
marker="\nconsole.log('diff-platform: PASS');\n"
block=r'''

// #514: candidate-graph truncation must not become confidence-1 deletion/addition.
{
  const before=Array.from({length:4},(_x,i)=>({ ...base,address:0x10000n+BigInt(i*0x20) }));
  const after=Array.from({length:4},(_x,i)=>({ ...base,address:0x20000n+BigInt(i*0x20) }));
  const partial=diffFunctions(before,after,{
    maxCandidates:4,maxBucketScan:4,
    matchBudget:{maxCandidateEvaluations:1,maxCandidateEdges:32,maxWallMs:10_000},
  });
  assert.equal(partial.complete,false);
  assert.equal(partial.matching.candidateGraphIncomplete,true);
  assert.equal(partial.deleted.length,0);
  assert.equal(partial.new.length,0);
  assert.equal(partial.unresolved.length,8);
  assert.ok(partial.unresolved.every((x)=>x.confidence===0&&x.status==='unresolved'));
}

// #514: an oversized ambiguity component is unresolved, never a mass delete/add.
{
  const before=Array.from({length:4},(_x,i)=>({ ...base,address:0x30000n+BigInt(i*0x20) }));
  const after=Array.from({length:4},(_x,i)=>({ ...base,address:0x40000n+BigInt(i*0x20) }));
  const partial=diffFunctions(before,after,{
    maxCandidates:4,maxBucketScan:4,
    matchBudget:{maxCandidateEvaluations:100,maxCandidateEdges:100,maxComponentNodes:4,maxComponentEdges:100,maxWallMs:10_000},
  });
  assert.equal(partial.complete,false);
  assert.ok(partial.matching.truncatedComponents.some((x)=>x.reason==='component-budget'));
  assert.equal(partial.deleted.length,0);
  assert.equal(partial.new.length,0);
  assert.equal(partial.unresolved.length,8);
}

// #514: exact-solver exhaustion discards partial certainty at the facade too.
{
  const before=Array.from({length:3},(_x,i)=>({ ...base,address:0x50000n+BigInt(i*0x20) }));
  const after=Array.from({length:3},(_x,i)=>({ ...base,address:0x60000n+BigInt(i*0x20) }));
  const partial=diffFunctions(before,after,{
    maxCandidates:3,maxBucketScan:3,
    matchBudget:{maxCandidateEvaluations:100,maxCandidateEdges:100,maxComponentNodes:100,maxComponentEdges:100,maxSolverRelaxations:1,maxSolverAugmentations:100,maxWallMs:10_000},
  });
  assert.equal(partial.complete,false);
  assert.match(partial.matching.budget.reason,/solver relaxations/);
  assert.equal(partial.deleted.length,0);
  assert.equal(partial.new.length,0);
  assert.equal(partial.unresolved.length,6);
}

// #514: when matching is complete, real unmatched functions retain definitive status.
{
  const removed={ ...base,address:0x70000n,bytes:Uint8Array.from([1,1,1,1,1,1,1,1]),strings:['removed-only'],calls:[],constants:[7] };
  const addedOnly={ ...base,address:0x80000n,bytes:Uint8Array.from([9,9,9,9,9,9,9,9]),strings:['added-only'],calls:['different'],constants:[9999] };
  const gone=diffFunctions([removed],[],{threshold:0.95});
  assert.equal(gone.complete,true);
  assert.equal(gone.deleted.length,1);
  assert.equal(gone.deleted[0].confidence,1);
  assert.equal(gone.unresolved.length,0);
  const fresh=diffFunctions([],[addedOnly],{threshold:0.95});
  assert.equal(fresh.complete,true);
  assert.equal(fresh.new.length,1);
  assert.equal(fresh.new[0].confidence,1);
  assert.equal(fresh.unresolved.length,0);
}
'''
if block.strip() not in text:
    if marker not in text: raise SystemExit('diff test marker not found')
    text=text.replace(marker,block+marker,1)
p.write_text(text)
