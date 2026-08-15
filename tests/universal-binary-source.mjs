import assert from 'node:assert/strict';
import {
  BinaryImage, BlobByteSource, ByteSourceLimitError, ByteSourceRangeError, ByteView, MemoryByteSource,
  mergeFunctionSeeds, openBinary, openBinarySource,
} from '../js/binary/index.js';
import { SparseByteBuffer, parseSourceRanges } from '../js/binary/source-reader.js';
import { CachedByteSource, ByteSourceCancelledError } from '../js/bytesource/cached.js';
import { scanSourceStrings } from '../js/bytesource/strings.js';
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

  const hugeSparse = new SparseByteBuffer(BigInt(Number.MAX_SAFE_INTEGER) + 0x1000n);
  const hugeOffset = BigInt(Number.MAX_SAFE_INTEGER) + 0x100n;
  hugeSparse.add(hugeOffset, Uint8Array.of(0xaa, 0xbb));
  assert.deepEqual([...hugeSparse.subarray(hugeOffset, hugeOffset + 2n)], [0xaa, 0xbb]);

  const short = {
    size: 64n,
    async read(_offset, length) { return new Uint8Array(Math.max(0, length - 1)); },
  };
  await assert.rejects(() => openBinarySource(short), /truncated read/);
}

async function testIssue48To60Regressions() {
  const exactBase = (1n << 53n) + 0x123n;
  const view = new ByteView(Uint8Array.of(1), { base: exactBase });
  assert.throws(() => view.u32(0), new RegExp((exactBase).toString(16)));
  assert.throws(() => new ByteView(Uint8Array.of(1), { base: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);

  const sparse = new SparseByteBuffer(64n);
  assert.equal(sparse.add(0n, Uint8Array.of(1, 2, 3, 4)), 4);
  assert.equal(sparse.add(2n, Uint8Array.of(9, 9, 9, 9)), 2);
  assert.equal(sparse.chunks.length, 1);
  assert.deepEqual([...sparse.subarray(0n, 6n)], [1, 2, 9, 9, 9, 9]);

  let parserPasses = 0;
  const stagedSource = new MemoryByteSource(new Uint8Array(4096), { maxReadLength: 64 });
  const staged = await parseSourceRanges(stagedSource, (backing) => {
    parserPasses++;
    new ByteView(backing).slice(0, 2048);
    return new BinaryImage(backing, { format: 'test' });
  }, {}, { pageSize: 64, maxPageSize: 64, maxCachedBytes: 4096 });
  assert.equal(parserPasses, 2);
  assert.equal(staged.metadata.sourceReads.parserPasses, 2);

  const stringImage = await openBinarySource(makeElf64Fixture(), { strings: { minLength: 4 }, ranges: { pageSize: 128, maxCachedBytes: 2 * 1024 * 1024 } });
  assert.ok(stringImage.strings.some((s) => s.text.includes('puts')));

  const thin = makeMachO64Fixture();
  const fat = new Uint8Array(0x200 + thin.length * 2);
  const fv = new DataView(fat.buffer);
  fv.setUint32(0, 0xcafebabe, false); fv.setUint32(4, 2, false);
  const addSlice = (p, subtype, offset) => { fv.setUint32(p, 0x0100000c, false); fv.setUint32(p + 4, subtype, false); fv.setUint32(p + 8, offset, false); fv.setUint32(p + 12, thin.length, false); fv.setUint32(p + 16, 2, false); };
  addSlice(8, 0, 0x100); addSlice(28, 2, 0x100 + thin.length);
  fat.set(thin, 0x100); const arm64eThin = thin.slice(); new DataView(arm64eThin.buffer).setInt32(8, 2, true); fat.set(arm64eThin, 0x100 + thin.length);
  assert.equal(openBinary(fat).metadata.fat.selected.arch, 'arm64e');
  assert.equal(openBinary(fat, { arch: 'arm64' }).metadata.fat.selected.arch, 'arm64');
  assert.throws(() => openBinary(fat, { arch: 'x86_64' }), /not present/);
  assert.equal((await openBinarySource(fat, { arch: 'arm64e', ranges: { pageSize: 128, maxCachedBytes: 2 * 1024 * 1024 } })).metadata.fat.selected.arch, 'arm64e');
  await assert.rejects(() => openBinarySource(fat, { arch: 'x86_64' }), /not present/);

  let backendResolve; let backendReads = 0;
  const sharedSource = {
    size: 16n,
    async read(_offset, length, options) { backendReads++; assert.equal(options?.signal, undefined); return new Promise((resolve) => { backendResolve = () => resolve(new Uint8Array(length).fill(7)); }); },
  };
  const cached = new CachedByteSource(sharedSource, { pageSize: 16, maxCachedBytes: 16 });
  const a = new AbortController(), b = new AbortController();
  const first = cached.read(0n, 4, { signal: a.signal });
  const second = cached.read(0n, 4, { signal: b.signal });
  a.abort();
  await assert.rejects(first, ByteSourceCancelledError);
  backendResolve();
  assert.deepEqual([...await second], [7, 7, 7, 7]);
  assert.equal(backendReads, 1);

  const asciiBytes = new TextEncoder().encode('ABCDEFGH\0');
  const asciiImage = new BinaryImage(asciiBytes, { format: 'test' });
  asciiImage.addSection({ name: 'data', address: 0x1000n, size: BigInt(asciiBytes.length), fileOffset: 0n, fileSize: BigInt(asciiBytes.length), perms: { read: true } });
  const asciiScan = await scanSourceStrings(asciiImage, asciiBytes, { minLength: 2, maxLength: 4, utf16: false, chunkSize: 64 });
  assert.deepEqual(asciiScan.results.map((x) => x.text), ['ABCD', 'EFGH']);

  const beBytes = Uint8Array.of(0, 0x41, 0, 0x42, 0, 0x43, 0, 0);
  const beImage = new BinaryImage(beBytes, { format: 'test', endian: 'big' });
  beImage.addSection({ name: 'data', address: 0x2000n, size: 8n, fileOffset: 0n, fileSize: 8n, perms: { read: true } });
  const beScan = await scanSourceStrings(beImage, beBytes, { minLength: 3, maxLength: 8 });
  assert.ok(beScan.results.some((x) => x.encoding === 'utf16be' && x.text === 'ABC'));

  let observedSignal = null;
  const aborter = new AbortController();
  const cancelSource = { size: 64n, async read(_offset, _length, options) { observedSignal = options?.signal; aborter.abort(); const e = new Error('abort'); e.name = 'AbortError'; throw e; } };
  const cancelImage = new BinaryImage(null, { format: 'test', endian: 'little', fileSize: 64n });
  cancelImage.addSection({ name: 'data', address: 0x3000n, size: 64n, fileOffset: 0n, fileSize: 64n, perms: { read: true } });
  const cancelled = await scanSourceStrings(cancelImage, cancelSource, { signal: aborter.signal });
  assert.equal(observedSignal, aborter.signal); assert.equal(cancelled.cancelled, true);

  const symbolGap = mergeFunctionSeeds([{ address: 0x1000n, source: 'symbol', confidence: 0.9 }, { address: 0x2000n, source: 'symbol', confidence: 0.9 }]);
  assert.ok(symbolGap[0].size == null);
  const starts = mergeFunctionSeeds([{ address: 0x1000n, source: 'function_starts', confidence: 0.995 }, { address: 0x1100n, source: 'function_starts', confidence: 0.995 }]);
  assert.equal(starts[0].size, 0x100n); assert.equal(starts[0].extentInferred, true);

  const importImage = new BinaryImage(new Uint8Array(1), { format: 'test' });
  importImage.imports.push(
    { name: 'x', library: 'L', ordinal: 1, weak: false, addend: 0n, pointerFormat: 1, sites: [] },
    { name: 'x', library: 'L', ordinal: 1, weak: true, addend: 0n, pointerFormat: 1, sites: [] },
    { name: 'x', library: 'L', ordinal: 1, weak: false, addend: 4n, pointerFormat: 1, sites: [] },
    { name: 'x', library: 'L', ordinal: 1, weak: false, addend: 0n, pointerFormat: 2, sites: [] },
  );
  importImage.finalize();
  assert.equal(importImage.imports.length, 4);
}

await testMemoryAndBlobSources();
await testRangeLoaders();
await testMalformedInputs();
await testIssue48To60Regressions();
console.log('universal-binary-source: PASS');
