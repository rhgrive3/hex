import assert from 'node:assert/strict';
import { maximumWeightCandidateMatching } from '../js/recognition/matcher.js';

const pairs = (result) => result.map(({i,j}) => [i,j]);

const twoByTwo = maximumWeightCandidateMatching([
  { i:0, j:0, confidence:0.90 }, { i:0, j:1, confidence:0.80 },
  { i:1, j:0, confidence:0.89 }, { i:1, j:1, confidence:0.10 },
]);
assert.deepEqual(pairs(twoByTwo), [[0,1],[1,0]], '2x2 matching must maximize total confidence instead of taking the top greedy edge');

const threeByThree = maximumWeightCandidateMatching([
  { i:0, j:0, confidence:0.95 }, { i:0, j:1, confidence:0.94 },
  { i:1, j:0, confidence:0.93 }, { i:1, j:2, confidence:0.50 },
  { i:2, j:1, confidence:0.92 }, { i:2, j:2, confidence:0.91 },
]);
assert.deepEqual(pairs(threeByThree), [[0,1],[1,0],[2,2]], '3x3 ambiguity component must choose the global maximum-weight assignment');

const disconnected = maximumWeightCandidateMatching([
  { i:0, j:0, confidence:0.7 },
  { i:4, j:7, confidence:0.8 },
]);
assert.deepEqual(pairs(disconnected), [[0,0],[4,7]], 'disconnected sparse components must remain independently matchable');

console.log('issue-193-matching: PASS');
