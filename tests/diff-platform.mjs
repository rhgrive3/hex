import assert from 'node:assert/strict';
import { diffFunctions, fingerprintFunction } from '../js/diff/index.js';

const base = { address: 0x1000n, bytes: Uint8Array.from([1,2,3,4,5,6,7,8]), cfg: { blocks: 2, edges: 1, exits: 1 }, strings: ['coins'], imports: ['memcpy'], calls: ['helper'], constants: [100] };
let diff = diffFunctions([base], [{ ...base }]);
assert.equal(diff.matches[0].status, 'identical');

diff = diffFunctions([base], [{ ...base, address: 0x781000n }]);
assert.equal(diff.matches[0].status, 'moved');
assert.ok(diff.matches[0].confidence > 0.9);

diff = diffFunctions([base], [{ ...base, address: 0x781000n, bytes: Uint8Array.from([1,2,3,4,5,6,9,8]), constants: [101] }]);
assert.equal(diff.matches[0].status, 'slightly changed');
assert.ok(diff.matches[0].confidence >= 0.62);

const fp = fingerprintFunction({ ...base, relocationOffsets: [0] });
const movedReloc = fingerprintFunction({ ...base, address: 9n, bytes: Uint8Array.from([9,9,9,9,9,9,9,9]), relocationOffsets: [0] });
assert.equal(fp.normalizedByteHash, movedReloc.normalizedByteHash);
console.log('diff-platform: PASS');
