import assert from 'node:assert/strict';
import { NodeBackend } from './harness.mjs';

const bytes = new Uint8Array(32);
const file = {
  name: 'worker-harness.bin',
  size: bytes.length,
  slice(start, end) {
    const part = bytes.subarray(start, end);
    return {
      arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
    };
  },
};

const backend = new NodeBackend();
const info = await backend.open(file);
assert.equal(info.format, 'Raw binary');
assert.ok(info.raw?.id, 'raw region must be available');

// Exercise an entry point replaced by worker-fixes.js. This proves the Node
// harness gives importScripts() files the same shared classic-script scope as
// a browser worker instead of merely proving that worker-legacy.js can boot.
const xrefs = await backend.xrefs({ regionId: info.raw.id, target: 0n, limit: 4 });
assert.ok(Array.isArray(xrefs.results));
assert.equal(xrefs.cancelled, false);

console.log('classic worker harness regression passed');
