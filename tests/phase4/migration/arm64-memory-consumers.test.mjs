import assert from 'node:assert/strict';
import { NodeBackend } from '../../harness.mjs';

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

// #814: canonical LDPSW displacement/width must survive every worker consumer.
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
  const xrefs = await b.xrefs({ regionId: id, target: 4n, limit: 8 });
  assert.ok(xrefs.results.some((x) => x.addr === 4n && x.kind === 'load'));
  const falseXrefs = await b.xrefs({ regionId: id, target: 8n, limit: 8 });
  assert.ok(!falseXrefs.results.some((x) => x.addr === 4n && x.kind === 'load'));
}

// #815: pair exclusives keep total width and stay out of scalar value-shape inference.
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

// #816: atomic RMW remains both a read and a write and is neutral in valueShapes.
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

console.log('phase4 ARM64 memory consumer regressions: ok');
