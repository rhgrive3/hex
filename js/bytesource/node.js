import { open } from 'node:fs/promises';
import { ByteSource, safeNumber } from '../binary/source.js';

export class NodeFileByteSource extends ByteSource {
  constructor(handle, size, options = {}) {
    super(BigInt(size), options);
    this.handle = handle;
  }

  static async open(path, options = {}) {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat({ bigint: true });
      return new NodeFileByteSource(handle, stat.size, options);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset, length) {
    const range = this.validateRange(offset, length);
    const buffer = new Uint8Array(range.length);
    let done = 0;
    const position = safeNumber(range.offset, 'file read offset');
    while (done < range.length) {
      const { bytesRead } = await this.handle.read(buffer, done, range.length - done, position + done);
      if (!bytesRead) break;
      done += bytesRead;
    }
    return done === buffer.length ? buffer : buffer.subarray(0, done);
  }

  async close() { await this.handle.close(); }
}
