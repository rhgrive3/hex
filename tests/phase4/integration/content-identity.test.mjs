import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncrementalSha256, sha256BlobHex } from '../../../js/cache/content-identity.js';
import { createBinaryIdFromDigest } from '../../../js/core/identity/index.js';

const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const length of [0,1,3,55,56,57,63,64,65,127,128,129,1024,65537]) {
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length * 17) & 0xff);
  const hasher = new IncrementalSha256();
  for (let offset = 0; offset < bytes.length; offset += 17) hasher.update(bytes.subarray(offset, Math.min(bytes.length, offset + 17)));
  assert.equal(hasher.hexDigest(), hex(bytes), `incremental SHA-256 mismatch at length ${length}`);
}

class SyntheticBlob {
  constructor(size, tracker, start = 0) { this.size = size; this.tracker = tracker; this.start = start; }
  slice(start, end) {
    const length = Math.max(0, Math.min(this.size, end) - Math.max(0, start));
    const absolute = this.start + Math.max(0, start);
    return {
      arrayBuffer: async () => {
        this.tracker.reads++;
        this.tracker.bytesRead += length;
        this.tracker.largestRead = Math.max(this.tracker.largestRead, length);
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) out[i] = (absolute + i * 29) & 0xff;
        return out.buffer;
      },
    };
  }
}

const tracker = { reads:0, bytesRead:0, largestRead:0 };
const size = 5 * 1024 * 1024 + 37;
const chunkBytes = 256 * 1024;
const source = new SyntheticBlob(size, tracker);
const bounded = await sha256BlobHex(source, { chunkBytes });
assert.equal(bounded.bytesRead, size);
assert.equal(bounded.largestRead, chunkBytes);
assert.equal(tracker.largestRead, chunkBytes);
assert.equal(tracker.reads, Math.ceil(size / chunkBytes));
assert.match(createBinaryIdFromDigest(bounded.hex), /^bin_sha256_[0-9a-f]{64}$/);

const whole = new Uint8Array(size);
for (let i = 0; i < whole.length; i++) whole[i] = (i * 29) & 0xff;
assert.equal(bounded.hex, hex(whole), 'bounded file digest must equal conventional whole-file SHA-256');

const cancelledTracker = { reads:0, bytesRead:0, largestRead:0 };
const controller = new AbortController();
let progressCalls = 0;
await assert.rejects(
  sha256BlobHex(new SyntheticBlob(4 * chunkBytes, cancelledTracker), {
    chunkBytes,
    signal:controller.signal,
    onProgress() { progressCalls++; if (progressCalls === 1) controller.abort(); },
  }),
  (error) => error?.name === 'AbortError',
);
assert.equal(cancelledTracker.reads, 1, 'cancellation must stop further identity reads');

console.log('PHASE4_CONTENT_IDENTITY ' + JSON.stringify({
  conventionalSha256:true,
  binaryIdCanonicalHelper:true,
  bytesRead:bounded.bytesRead,
  reads:bounded.reads,
  largestRead:bounded.largestRead,
  cancellationReads:cancelledTracker.reads,
}));
console.log('phase4 content identity: PASS');
