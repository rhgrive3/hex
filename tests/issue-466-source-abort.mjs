import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/index.js';
import { normalizeByteSource } from '../js/binary/source.js';
import { parseSourceRanges } from '../js/binary/source-reader.js';
import { openBinarySource } from '../js/binary/source-loaders.js';
import { makeElf64Fixture, makeMachO64Fixture, makePe64Fixture } from './universal-binary.mjs';

function abortingSource(bytes, controller, abortOnRead = 2) {
  const state = { reads:0, signals:[] };
  return {
    size:BigInt(bytes.length), maxReadLength:64, state,
    async read(offset, length, options = {}) {
      state.reads++;
      state.signals.push(options.signal || null);
      const out = bytes.subarray(Number(offset), Number(offset) + length);
      if (state.reads === abortOnRead) controller.abort();
      return out;
    },
  };
}

for (const [label, bytes] of [
  ['ELF', makeElf64Fixture()], ['PE', makePe64Fixture()], ['Mach-O', makeMachO64Fixture()],
]) {
  const controller = new AbortController();
  const source = abortingSource(bytes, controller, 2);
  await assert.rejects(
    () => openBinarySource(source, { signal:controller.signal, ranges:{ pageSize:32, maxPageSize:32, maxCachedBytes:1 << 20 } }),
    (error) => error?.name === 'AbortError',
    `${label}: structural loader should abort`,
  );
  assert.equal(source.state.reads, 2, `${label}: no reads may occur after the aborting structural read`);
  assert.ok(source.state.signals.every((signal) => signal === controller.signal), `${label}: signal must reach every source read`);
}

{
  const controller = new AbortController();
  let reads = 0, passes = 0;
  const rawSource = {
    size:4096n, maxReadLength:64,
    async read(_offset, length, options = {}) {
      reads++;
      assert.equal(options.signal, controller.signal);
      return new Uint8Array(length);
    },
  };
  const source = normalizeByteSource(rawSource);
  await assert.rejects(
    () => parseSourceRanges(source, (backing) => {
      passes++;
      if (passes === 2) controller.abort();
      backing.subarray(0, 2048);
      return new BinaryImage(backing, { format:'test' });
    }, {}, { signal:controller.signal, pageSize:64, maxPageSize:64, maxCachedBytes:4096 }),
    (error) => error?.name === 'AbortError' && error?.code === 'BYTE_SOURCE_CANCELLED',
  );
  assert.equal(passes, 2);
  assert.equal(reads, 1, 'second parser pass abort must not trigger another missing-range read');
}

console.log('issue #466 source abort regressions passed');
