import { toExactArrayBuffer } from './array-buffer.js';

export async function decompressGzipExact(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('The protected runtime compression format is unsupported.');
  const exact = toExactArrayBuffer(bytes);
  try {
    return await decompressWithChunk(exact);
  } catch (error) {
    if (!isChunkTypeError(error)) throw error;
    return decompressWithChunk(new Uint8Array(exact));
  }
}

async function decompressWithChunk(chunk) {
  const stream = new DecompressionStream('gzip');
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(chunk);
  await writer.close();
  return new Uint8Array(await output);
}

function isChunkTypeError(error) {
  const message = String(error?.message || error || '');
  return error instanceof TypeError || /arraybuffer|typedarray|dataview|chunk|invalid type/i.test(message);
}
