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


function identicalRawFunctions(count, addressBase) {
  const instructions=['mov x0, x0','ret'];
  return Array.from({length:count},(_x,i)=>({
    address:BigInt(addressBase)+BigInt(i*4),
    architecture:'arm64', size:sharedBytes.length, bytes:sharedBytes,
    instructions,
    cfg:{blocks:1,edges:0,exits:1,loops:0,calls:0},
    strings:['raw-identical-template'], imports:[], calls:[], constants:[7],
    relocationOffsets:[], semantic:{operations:['return']},
  }));
}

// Re-audit #500: the hard budget must start before raw fingerprint generation
// and index construction. These are deliberately raw functions, not cached
// fingerprint objects. Population size must not increase preprocessing work
// after the configured cap is reached.
for (const count of [1_000,10_000,100_000]) {
  const before=identicalRawFunctions(count,0x3000000);
  const after=identicalRawFunctions(count,0x4000000);
  const started=performance.now();
  const result=matchFunctionsFast(before,after,{
    maxCandidates:8,maxBucketScan:8,
    matchBudget:{
      maxPreprocessFunctions:64,
      maxPreprocessInputBytes:4096,
      maxPreprocessEstimatedBytes:1<<20,
      maxPreprocessWork:4096,
      maxIndexEntries:512,
      maxCandidateEvaluations:256,
      maxCandidateEdges:128,
      maxWallMs:30_000,
    },
  });
  const elapsed=performance.now()-started;
  assert.equal(result.truncated,true,`${count}: preprocessing cap must truncate`);
  assert.equal(result.matching.preprocessingIncomplete,true,`${count}: preprocessing incompleteness must be explicit`);
  assert.equal(result.matching.candidateGraphIncomplete,true,`${count}: incomplete preprocessing invalidates the candidate graph`);
  assert.equal(result.matches.length,0,`${count}: incomplete raw preprocessing must fail closed`);
  assert.ok(result.matching.budget.preprocessFunctions<=64,`${count}: raw fingerprint count is hard bounded`);
  assert.ok(result.matching.budget.fingerprintsBuilt<=64,`${count}: materialized fingerprints are hard bounded`);
  assert.ok(result.matching.budget.indexEntries<=512,`${count}: token index entries are hard bounded`);
  assert.ok(result.matching.budget.preprocessEstimatedBytes<=1<<20,`${count}: estimated preprocessing heap remains bounded`);
  assert.ok(elapsed<30_000,`${count}: raw stress fixture must complete inside safety envelope`);
}

// A single raw function whose byte payload exceeds the preprocessing budget is
// rejected before fingerprintFunctionFast can copy/hash it.
{
  const huge={
    address:0x5000000n, architecture:'arm64', size:4096,
    bytes:new Uint8Array(4096), instructions:['ret'],
    cfg:{blocks:1,edges:0,exits:1,loops:0,calls:0},
  };
  const result=matchFunctionsFast([huge],[],{
    matchBudget:{
      maxPreprocessFunctions:8,maxPreprocessInputBytes:1024,
      maxPreprocessEstimatedBytes:1<<20,maxPreprocessWork:1<<20,
      maxIndexEntries:128,maxWallMs:10_000,
    },
  });
  assert.equal(result.matching.preprocessingIncomplete,true);
  assert.equal(result.matching.budget.fingerprintsBuilt,0,'oversized raw input is stopped before fingerprint allocation');
  assert.match(result.matching.budget.reason,/preprocessing input bytes exceed 1024/);
}

// Abort is checked before the first fingerprint/index allocation.
{
  const controller=new AbortController();
  controller.abort();
  const result=matchFunctionsFast(identicalRawFunctions(4,0x6000000),identicalRawFunctions(4,0x7000000),{
    matchBudget:{signal:controller.signal,maxWallMs:10_000},
  });
  assert.equal(result.matching.preprocessingIncomplete,true);
  assert.equal(result.matching.budget.fingerprintsBuilt,0);
  assert.match(result.matching.budget.reason,/aborted/);
}

// Precomputed fingerprints remain the low-cost cache path: a tiny raw-input
// byte budget must not reject already materialized compatible fingerprints.
{
  const before=[{...template,address:0x8000000n}];
  const after=[{...template,address:0x9000000n}];
  const result=matchFunctionsFast(before,after,{
    matchBudget:{
      maxPreprocessFunctions:4,maxPreprocessInputBytes:1,
      maxPreprocessEstimatedBytes:4096,maxPreprocessWork:64,
      maxIndexEntries:128,maxCandidateEvaluations:128,maxCandidateEdges:128,
      maxComponentNodes:64,maxComponentEdges:128,maxSolverRelaxations:1024,
      maxSolverAugmentations:64,maxWallMs:10_000,
    },
  });
  assert.equal(result.matching.preprocessingIncomplete,false);
  assert.equal(result.matching.budget.preprocessInputBytes,0);
  assert.equal(result.matches.length,1);
}

console.log('issue #500 matcher budget: PASS');
