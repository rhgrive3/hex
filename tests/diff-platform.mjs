import assert from 'node:assert/strict';
import { compareFingerprints, diffFunctions, fingerprintFunction } from '../js/diff/index.js';

const base = { address: 0x1000n, bytes: Uint8Array.from([1,2,3,4,5,6,7,8]), cfg: { blocks: 2, edges: 1, exits: 1 }, strings: ['coins'], imports: ['memcpy'], calls: ['helper'], constants: [100] };
let diff = diffFunctions([base], [{ ...base }]);
assert.equal(diff.matches[0].status, 'identical');

diff = diffFunctions([base], [{ ...base, address: 0x781000n }]);
assert.equal(diff.matches[0].status, 'moved');
assert.ok(diff.matches[0].confidence > 0.9);

diff = diffFunctions([base], [{ ...base, address: 0x781000n, bytes: Uint8Array.from([1,2,3,4,5,6,9,8]), constants: [101] }]);
assert.equal(diff.matches[0].status, 'rewritten');
assert.equal(diff.matches[0].changeType, 'rewritten');
assert.ok(diff.matches[0].confidence >= 0.62);

const relocation = [{ offset: 0, width: 8 }];
const fp = fingerprintFunction({ ...base, relocationOffsets: relocation });
const movedReloc = fingerprintFunction({ ...base, address: 9n, bytes: Uint8Array.from([9,9,9,9,9,9,9,9]), relocationOffsets: relocation });
assert.equal(fp.normalizedByteHash, movedReloc.normalizedByteHash);

// Missing metadata is absence of evidence, not perfect semantic similarity.
const sparseA = fingerprintFunction({ address: 1n, size: 64, bytes: Uint8Array.from({ length: 64 }, (_, i) => i) });
const sparseB = fingerprintFunction({ address: 2n, size: 64, bytes: Uint8Array.from({ length: 64 }, (_, i) => i < 40 ? i : 255 - i) });
const sparseCmp = compareFingerprints(sparseA, sparseB);
assert.ok(!sparseCmp.reasons.includes('strings'));
assert.ok(!sparseCmp.reasons.includes('imports'));
assert.ok(!sparseCmp.reasons.includes('cfg-shape'));

// Empty byte arrays are not an exact fingerprint shared by unrelated functions.
const emptyA = fingerprintFunction({ address: 3n, bytes: new Uint8Array(0) });
const emptyB = fingerprintFunction({ address: 4n, bytes: new Uint8Array(0) });
assert.equal(compareFingerprints(emptyA, emptyB).reasons.includes('normalized-bytes'), false);
assert.equal(diffFunctions([emptyA], [emptyB]).matches.length, 0);


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

console.log('diff-platform: PASS');
