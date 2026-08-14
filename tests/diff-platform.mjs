import assert from 'node:assert/strict';
import { compareFingerprints, diffFunctions, fingerprintFunction } from '../js/diff/index.js';

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

console.log('diff-platform: PASS');
