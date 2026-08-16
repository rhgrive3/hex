import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decompressGzipExact } from '../js/userscript/decompress.js';

const NativeDecompressionStream = globalThis.DecompressionStream;
assert.equal(typeof NativeDecompressionStream, 'function', 'Node runtime must provide DecompressionStream');

class StrictArrayBufferDecompressionStream {
  constructor(format) {
    const inner = new NativeDecompressionStream(format);
    const writer = inner.writable.getWriter();
    this.readable = inner.readable;
    this.writable = {
      getWriter() {
        return {
          write(value) {
            assert.ok(value instanceof ArrayBuffer, 'decompressor input must be an exact ArrayBuffer');
            return writer.write(new Uint8Array(value));
          },
          close() { return writer.close(); },
        };
      },
    };
  }
}

const source = 'Hex strict iOS decompression bridge';
const gz = gzipSync(Buffer.from(source));
const backing = new Uint8Array(gz.length + 4);
backing.set(gz, 2);
const view = backing.subarray(2, 2 + gz.length);

globalThis.DecompressionStream = StrictArrayBufferDecompressionStream;
try {
  const result = await decompressGzipExact(view);
  assert.equal(new TextDecoder().decode(result), source);
} finally {
  globalThis.DecompressionStream = NativeDecompressionStream;
}

const nativeResult = await decompressGzipExact(view);
assert.equal(new TextDecoder().decode(nativeResult), source, 'standard typed-array DecompressionStream fallback must remain compatible');

console.log('userscript-decompress ArrayBuffer compatibility: ok');
