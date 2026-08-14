import assert from 'node:assert/strict';
import {
  BlobByteSource, ByteSourceLimitError, ByteSourceRangeError, MemoryByteSource,
  openBinary, openBinarySource,
} from '../js/binary/index.js';
import { makeElf64Fixture, makeFatMachOFixture, makeMachO64Fixture, makePe64Fixture } from './universal-binary.mjs';
import { makeSectionlessElf64Fixture } from './universal-binary-sectionless.mjs';

class SpySource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = BigInt(bytes.length);
    this.reads = [];
  }

  async read(offset, length) {
    this.reads.push({ offset, length });
    const start = Number(offset);
    return this.bytes.subarray(start, start + length);
  }
}

async function testMemoryAndBlobSources() {
  const memory = new MemoryByteSource(Uint8Array.from([1, 2, 3, 4]), { maxReadLength: 4 });
  assert.equal(memory.size, 4n);
  assert.deepEqual([...await memory.read(1n, 2)], [2, 3]);
  await assert.rejects(() => memory.read(3n, 2), ByteSourceRangeError);
  await assert.rejects(() => memory.read(0n, 5), ByteSourceLimitError);

  const blob = new BlobByteSource(new Blob([makeElf64Fixture()]));
  const image = await openBinarySource(blob, { ranges: { pageSize: 128 } });
  assert.equal(image.format, 'elf');
  assert.equal(image.bytes, null);
  assert.equal(image.source, blob);
}

async function assertRangeEquivalent(bytes, label) {
  const expected = openBinary(bytes);
  const spy = new SpySource(bytes);
  const actual = await openBinarySource(spy, { ranges: { pageSize: 128, maxCachedBytes: 2 * 1024 * 1024 } });
  assert.deepEqual(actual.summary(), expected.summary(), `${label}: summary`);
  const expectedJson = expected.toJSON();
  const actualJson = actual.toJSON();
  delete actualJson.metadata.sourceBacked;
  delete actualJson.metadata.sourceReads;
  assert.deepEqual(actualJson, expectedJson, `${label}: parser result`);
  assert.equal(actual.bytes, null, `${label}: source-backed image must not retain a whole byte array`);
  assert.ok(spy.reads.length > 1, `${label}: expected multiple range reads`);
  assert.ok(spy.reads.every((read) => read.length < bytes.length), `${label}: a read requested the entire fixture`);
  assert.ok(Math.max(...spy.reads.map((read) => read.length)) <= 128, `${label}: page limit`);
  return actual;
}

async function testRangeLoaders() {
  const macho = await assertRangeEquivalent(makeMachO64Fixture(), 'Mach-O');
  assert.deepEqual(macho.functions.map((item) => item.address), [0x100000300n, 0x100000310n]);

  const elf = await assertRangeEquivalent(makeElf64Fixture(), 'ELF');
  assert.equal(elf.imports.find((item) => item.name === 'puts')?.source, 'elf-dynsym');

  const pe = await assertRangeEquivalent(makePe64Fixture(), 'PE');
  assert.equal(pe.imports[0]?.name, 'ExitProcess');
  const code = await pe.readVirtualAsync(0x140001000n, 16);
  assert.equal(code?.length, 16);

  const fat = await assertRangeEquivalent(makeFatMachOFixture(), 'fat Mach-O');
  assert.equal(fat.metadata.fat.selected.offset, 0x100n);

  const sectionless = await assertRangeEquivalent(makeSectionlessElf64Fixture(), 'sectionless ELF');
  assert.equal(sectionless.sections.length, 0);
  assert.equal(sectionless.metadata.programDynamic?.sectionless, true);
}

async function testMalformedInputs() {
  await assert.rejects(
    () => openBinarySource(makePe64Fixture().subarray(0, 0x90), { ranges: { pageSize: 64 } }),
    /invalid PE signature|outside file|truncated/,
  );

  const hugeCommands = makeMachO64Fixture();
  new DataView(hugeCommands.buffer).setUint32(20, 0xffffffff, true);
  await assert.rejects(() => openBinarySource(hugeCommands, { ranges: { pageSize: 64 } }), /load commands exceed file/);

  await assert.rejects(
    () => openBinarySource(makeElf64Fixture(), { ranges: { pageSize: 128, maxCachedBytes: 32 } }),
    ByteSourceLimitError,
  );

  const impossible = {
    size: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    async read(offset, length) {
      if (offset !== 0n || length !== 16) throw new Error('unexpected read');
      return makeElf64Fixture().subarray(0, length);
    },
  };
  await assert.rejects(() => openBinarySource(impossible), /safe integer range/);

  const short = {
    size: 64n,
    async read(_offset, length) { return new Uint8Array(Math.max(0, length - 1)); },
  };
  await assert.rejects(() => openBinarySource(short), /truncated read/);
}

await testMemoryAndBlobSources();
await testRangeLoaders();
await testMalformedInputs();
console.log('universal-binary-source: PASS');
