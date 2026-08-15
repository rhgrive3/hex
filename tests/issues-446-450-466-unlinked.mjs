import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeChainedPointer } from '../js/binary/macho-dyld.js';
import { parseSourceRanges } from '../js/binary/source-reader.js';

// #446: chained-pointer next fields are scaled according to the pointer format ABI.
for (const format of [7, 10]) assert.equal(decodeChainedPointer(1n << 51n, format).stride, 4, `format ${format}`);
for (const format of [1, 9, 12]) assert.equal(decodeChainedPointer(1n << 51n, format).stride, 8, `format ${format}`);

// #447: ELF entry-size validation must reject less than ABI minima and permit extensions.
const elf = fs.readFileSync('js/binary/elf-dynamic.js','utf8');
assert.match(elf,/const defaultSyment = BigInt\(bits === 64 \? 24 : 16\)/);
assert.match(elf,/const symentValid = syment >= defaultSyment/);
assert.match(elf,/requested < minimum/);
assert.doesNotMatch(elf,/requested === minimum/);

// #448: PE thunk reads are capped by both INT and IAT file-backed section extents.
const pe = fs.readFileSync('js/binary/pe-loader.js','utf8');
assert.match(pe,/function fileBackedSectionEnd/);
assert.match(pe,/thunkOff \+ ptrSize > thunkEnd/);
assert.match(pe,/iatEntryOff \+ ptrSize > iatEnd/);
assert.match(pe,/reached its file-backed section boundary without a terminator/);

// #450: the direct sandbox API must strictly reject NaN/Infinity/fractional/unbounded step budgets.
const sandbox = fs.readFileSync('js/symbolic/function-sandbox.js','utf8');
assert.match(sandbox,/boundedInteger\(o\.maxSteps, 20000, 1, 1_000_000, 'maxSteps'\)/);

// #466: cancellation after an asynchronous range read prevents another parser pass/read.
const controller = new AbortController();
let reads = 0, parses = 0;
const source = {
  size: 64n,
  maxReadLength: 64,
  async readExactly(offset, length, { signal } = {}) {
    reads++;
    assert.equal(signal, controller.signal);
    controller.abort();
    return new Uint8Array(length);
  },
};
const parser = () => {
  parses++;
  const error = new Error('miss');
  error.code = 'BINARY_SOURCE_RANGE_MISSING'; error.offset = 0n; error.length = 8n;
  throw error;
};
await assert.rejects(() => parseSourceRanges(source, parser, {}, { pageSize:8, maxPageSize:8, signal:controller.signal }), (e) => e?.name === 'AbortError' && e?.code === 'BYTE_SOURCE_CANCELLED');
assert.equal(reads,1);
assert.equal(parses,1);

const loaders = fs.readFileSync('js/binary/source-loaders.js','utf8');
assert.match(loaders,/signal: opts\.ranges\?\.signal \?\? opts\.signal/);
assert.match(loaders,/readExactly\(0n, prefixLength, \{ signal: opts\.signal \}\)/);

console.log('issues #446-#450/#466 binary trust-boundary regressions passed');
