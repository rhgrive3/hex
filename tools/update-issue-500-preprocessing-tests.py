from pathlib import Path

p=Path('tests/issue-500-matcher-budget.mjs')
text=p.read_text()
marker="\nconsole.log('issue #500 matcher budget: PASS');\n"
block=r'''

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
'''
if block.strip() not in text:
    if marker not in text: raise SystemExit('issue-500 test marker not found')
    text=text.replace(marker,block+marker,1)
p.write_text(text)
