import assert from 'node:assert/strict';
import { NodeBackend } from './harness.mjs';

const bytes = new Uint8Array(32);
const file = {
  name: 'worker-harness.bin',
  size: bytes.length,
  slice(start, end) {
    const part = bytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};

const backend = new NodeBackend();
const info = await backend.open(file);
assert.equal(info.format, 'Raw binary');
assert.ok(info.raw?.id, 'raw region must be available');
const xrefs = await backend.xrefs({ regionId: info.raw.id, target: 0n, limit: 4 });
assert.ok(Array.isArray(xrefs.results));
assert.equal(xrefs.cancelled, false);
console.log('classic worker harness regression passed');

function fileFromWords(name, words) {
  const raw = new Uint8Array(words.length * 4);
  const dv = new DataView(raw.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return {
    name, size: raw.length,
    slice(start, end) {
      const part = raw.subarray(start, end);
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    },
  };
}

// #814: ADR establishes x2 provenance; LDPSW #4 must reference +4 (not +8)
// and expose the real 8-byte pair width through the worker field scanner.
{
  const b = new NodeBackend();
  const opened = await b.open(fileFromWords('ldpsw-worker.bin', [0x10000002, 0x69408440]));
  const id = opened.raw.id;
  const scan = await b.scanProgram(id);
  assert.equal(scan.kinds[1], globalThis.Words.KIND.LOAD);
  const ref = Array.from({ length: scan.refCount }, (_, i) => ({ from: scan.refFrom[i], to: scan.refTo[i], kind: scan.refKind[i] }))
    .find((x) => x.from === 4n);
  assert.deepEqual(ref, { from: 4n, to: 4n, kind: 1 });
  const fields = await b.fieldAccess({ regionId: id, offset: 4n, size: 8, limit: 8 });
  assert.equal(fields.results.length, 1);
  assert.equal(fields.results[0].size, 8);
  assert.equal(fields.results[0].kind, 'load');
  const xrefs2 = await b.xrefs({ regionId: id, target: 4n, limit: 8 });
  assert.ok(xrefs2.results.some((x) => x.addr === 4n && x.kind === 'load'));
}

// #815: pair exclusives stay atomic, keep total pair width, and do not become
// fabricated scalar value-shape mutations.
{
  const b = new NodeBackend();
  const opened = await b.open(fileFromWords('exclusive-pair-worker.bin', [0xc87f0440, 0xc8230440]));
  const id = opened.raw.id;
  const scan = await b.scanProgram(id);
  assert.deepEqual(Array.from(scan.kinds.slice(0, 2)), [globalThis.Words.KIND.ATOMIC, globalThis.Words.KIND.ATOMIC]);
  const fields = await b.fieldAccess({ regionId: id, offset: 0n, size: 16, limit: 8 });
  assert.deepEqual(fields.results.map((x) => x.kind), ['load', 'store']);
  assert.ok(fields.results.every((x) => x.size === 16 && x.atomic === true));
  const shapes = await b.valueShapes(id);
  assert.equal(shapes.count, 0);
}

// #816: every RMW reaches worker consumers as both read and write, while
// valueShapes records a neutral atomic mutation instead of choosing one side.
{
  const b = new NodeBackend();
  const opened = await b.open(fileFromWords('lse-rmw-worker.bin', [0xc8a07c41, 0xf8200041]));
  const id = opened.raw.id;
  const scan = await b.scanProgram(id);
  assert.deepEqual(Array.from(scan.kinds.slice(0, 2)), [globalThis.Words.KIND.ATOMIC, globalThis.Words.KIND.ATOMIC]);
  const fields = await b.fieldAccess({ regionId: id, offset: 0n, size: 8, limit: 8 });
  assert.deepEqual(fields.results.map((x) => x.kind), ['load', 'store', 'load', 'store']);
  assert.ok(fields.results.every((x) => x.atomic === true && x.rmw === true));
  const shapes = await b.valueShapes(id);
  assert.equal(shapes.count, 2);
  assert.ok(Array.from(shapes.flags).every((f) => (f & 32) !== 0));
}

// issues-814-816 ARM64 memory E2E
