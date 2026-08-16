import { toExactArrayBuffer } from './array-buffer.js';

export async function decompressGzipExact(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('The protected runtime compression format is unsupported.');
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  await writer.write(toExactArrayBuffer(bytes));
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
