import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fingerprintFunctionFast } from '../js/fingerprint/index.js';
import { matchFunctionsFast, maximumWeightCandidateMatching } from '../js/recognition/matcher.js';
import { createMatchBudget } from '../js/recognition/match-budget.js';
import { solveCandidateMatching } from '../js/recognition/bounded-matching.js';

const sharedBytes=Uint8Array.from([0xc0,0x03,0x5f,0xd6]);
const template=fingerprintFunctionFast({
  address:1n, architecture:'arm64', size:4, bytes:sharedBytes,
  instructions:['ret'], cfg:{blocks:1,edges:0,exits:1,loops:0,calls:0},
  strings:['identical-template'], imports:[], calls:[], constants:[], semantic:{operations:['return']},
});

function identicalFingerprints(count, addressBase) {
  return Array.from({length:count}, (_x,i)=>({ ...template, address:BigInt(addressBase)+BigInt(i*4) }));
}

// Public exact matching API remains exact for small bounded components.
{
  const edges=[
    {i:0,j:0,confidence:0.91},{i:0,j:1,confidence:0.80},
    {i:1,j:0,confidence:0.89},{i:1,j:1,confidence:0.88},
  ];
  const selected=maximumWeightCandidateMatching(edges,{matchBudget:{maxWallMs:10_000}});
  assert.deepEqual(selected.map(x=>[x.i,x.j]),[[0,0],[1,1]]);
}

// Oversized ambiguity components are never partially solved as false-unambiguous matches.
{
  const edges=[];
  for(let i=0;i<40;i++) for(let j=0;j<40;j++) edges.push({i,j,confidence:0.9});
  const budget=createMatchBudget({maxComponentNodes:32,maxComponentEdges:256,maxWallMs:10_000});
  const solved=solveCandidateMatching(edges,budget);
  assert.equal(solved.selected.length,0);
  assert.equal(solved.ambiguousLeft.size,40);
  assert.equal(solved.ambiguousRight.size,40);
  assert.equal(solved.truncatedComponents.length,1);
  assert.equal(solved.truncatedComponents[0].reason,'component-budget');
}

// If the exact solver exhausts work inside one component, discard that component's partial assignment.
{
  const first=[{i:0,j:0,confidence:0.99}];
  const expensive=[];
  for(let i=10;i<18;i++) for(let j=10;j<18;j++) expensive.push({i,j,confidence:0.9});
  const budget=createMatchBudget({maxComponentNodes:100,maxComponentEdges:1000,maxSolverRelaxations:40,maxSolverAugmentations:100,maxWallMs:10_000});
  const solved=solveCandidateMatching([...first,...expensive],budget);
  assert.ok(solved.selected.some(x=>x.i===0&&x.j===0),'already-solved independent component remains safe');
  assert.equal(solved.selected.some(x=>x.i>=10),false,'partially solved exhausted component must return no matches');
  assert.ok(solved.ambiguousLeft.size>=8);
}

// Candidate graph truncation is stricter: unseen left nodes may compete with any seen right node,
// so no prefix match may be reported as certain.
{
  const before=identicalFingerprints(64,0x100000);
  const after=identicalFingerprints(64,0x200000);
  const result=matchFunctionsFast(before,after,{
    maxCandidates:8,maxBucketScan:8,
    matchBudget:{maxCandidateEvaluations:32,maxCandidateEdges:16,maxWallMs:10_000},
  });
  assert.equal(result.truncated,true);
  assert.equal(result.matching.candidateGraphIncomplete,true);
  assert.equal(result.matches.length,0);
  assert.equal(result.deleted.length,64);
  assert.equal(result.new.length,64);
  assert.ok(result.matching.budget.candidateEdges<=16);
  assert.ok(result.candidateComparisons<=32);
}

// Deterministic wall-clock cutoff during candidate generation also fails closed.
{
  let tick=0;
  const result=matchFunctionsFast(identicalFingerprints(4,0x300000),identicalFingerprints(4,0x400000),{
    maxCandidates:2,maxBucketScan:2,
    matchBudget:{maxCandidateEvaluations:100,maxCandidateEdges:100,maxWallMs:5,now:()=>{const v=tick;tick+=10;return v;}},
  });
  assert.equal(result.matches.length,0);
  assert.equal(result.matching.candidateGraphIncomplete,true);
  assert.match(result.matching.budget.reason,/wall-clock budget/);
}

// Required scale fixtures: huge identical populations are bounded by configured candidate work,
// not by N * 128 materialized edge objects. Pre-fingerprinted fixtures keep this test focused on matcher scaling.
for (const count of [1_000,10_000,100_000]) {
  const before=identicalFingerprints(count,0x1000000);
  const after=identicalFingerprints(count,0x2000000);
  const started=performance.now();
  const result=matchFunctionsFast(before,after,{
    maxCandidates:8,maxBucketScan:8,
    matchBudget:{maxCandidateEvaluations:256,maxCandidateEdges:128,maxWallMs:30_000},
  });
  const elapsed=performance.now()-started;
  assert.equal(result.matches.length,0,`${count}: truncated identical graph must not claim an unambiguous match`);
  assert.equal(result.matching.candidateGraphIncomplete,true,`${count}: global truncation must be explicit`);
  assert.ok(result.matching.budget.candidateEdges<=128,`${count}: edge objects stay within hard cap`);
  assert.ok(result.candidateComparisons<=256,`${count}: comparison work stays within hard cap`);
  assert.ok(elapsed<30_000,`${count}: stress fixture must complete inside the configured safety envelope`);
}

console.log('issue #500 matcher budget: PASS');
