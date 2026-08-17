import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VariableInstructionIndex,
  X86_MAX_INSTRUCTION_BYTES,
  VARIABLE_DECODE_PAGE_BYTES,
  VARIABLE_DECODE_OVERLAP_BYTES,
  VARIABLE_MAX_DECODE_REQUEST_BYTES,
  VARIABLE_PREFETCH_PAGES,
  VARIABLE_CACHE_PAGES,
  VARIABLE_RETAINED_INSTRUCTION_LIMIT,
} from '../../../js/viewer/variable-instruction-index.js';

function ins(address, length, mnemonic = 'nop', opStr = '') {
  return Object.freeze({ address:BigInt(address), length, size:length, rawBytes:Uint8Array.from({ length }, (_, i) => (Number(address) + i) & 0xff), mnemonic, opStr });
}

function streamDecoder(entries, { delay = null } = {}) {
  const sorted = entries.slice().sort((a,b) => a.address < b.address ? -1 : 1);
  const calls = [];
  const decode = async (address, options) => {
    calls.push({ address:BigInt(address), length:options.length, signal:options.signal, priority:options.priority });
    if (delay) await delay(address, options);
    if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name:'AbortError' });
    const end = BigInt(address) + BigInt(options.length);
    const instructions = [];
    let cursor = BigInt(address);
    while (cursor < end) {
      const found = sorted.find((entry) => entry.address === cursor);
      if (!found || found.address + BigInt(found.length) > end) break;
      instructions.push(found);
      cursor += BigInt(found.length);
    }
    return { supported:true, found:instructions.length > 0, instructions, bytesRead:options.length };
  };
  decode.calls = calls;
  return decode;
}

const MIXED = [
  ins(0x1000n, 1, 'nop'),
  ins(0x1001n, 2, 'push', 'rax'),
  ins(0x1003n, 3, 'add', 'eax, ebx'),
  ins(0x1006n, 5, 'call', '0x2000'),
  ins(0x100bn, 7, 'mov', 'rax, [rip+0x1234]'),
  ins(0x1012n, 15, 'nop'),
  ins(0x1021n, 1, 'ret'),
];

test('mixed variable widths map exact addresses and exact raw bytes', async () => {
  const decode = streamDecoder(MIXED);
  const index = new VariableInstructionIndex({ disassembleAt:decode, pageBytes:64, maxPrefetchPages:0 });
  index.configureRegion({ id:'mixed', vmAddr:0x1000n, size:0x100n });
  const nav = await index.navigate(0x1000n, { trusted:true });
  assert.equal(nav.status, 'decoded');
  const rows = index.localRows();
  assert.deepEqual(rows.map((r) => [r.address, r.length]), MIXED.map((r) => [r.address, r.length]));
  assert.deepEqual(rows.map((r) => r.bytes.length), [1,2,3,5,7,15,1]);
  assert.equal(rows[5].address + BigInt(rows[5].length), 0x1021n);
  assert.equal(index.localIndexOfAddress(0x100bn), 4);
  assert.equal(index.containingEntry(0x1018n)?.address, 0x1012n);
  assert.equal(index.knownEntry(0x1004n), null);
});

test('page requests are strictly byte bounded and page-crossing instruction appears once', async () => {
  const base = 0x4000n;
  const pageBytes = 32;
  const entries = [];
  let cursor = base;
  while (cursor < base + 30n) { entries.push(ins(cursor, 1)); cursor++; }
  entries.push(ins(base + 30n, 15, 'nop'));
  entries.push(ins(base + 45n, 1, 'ret'));
  const decode = streamDecoder(entries);
  const index = new VariableInstructionIndex({ disassembleAt:decode, pageBytes, overlapBytes:14, maxPrefetchPages:0, maxPages:4 });
  index.configureRegion({ id:'boundary', vmAddr:base, size:128n });
  const first = await index.ensurePage(base);
  assert.equal(first.requested, 46);
  assert.equal(first.entries.at(-1).address, base + 30n);
  assert.equal(first.entries.at(-1).length, 15);
  assert.equal(first.nextAddress, base + 45n);
  const second = await index.ensurePage(first.nextAddress);
  assert.equal(second.entries[0].address, base + 45n);
  const all = index.localRows(base + 30n);
  assert.equal(all.filter((r) => r.address === base + 30n).length, 1);
  assert.ok(decode.calls.every((call) => call.length <= pageBytes + 14));
});

test('empty, malformed length, and non-monotonic decoder results fail conservatively', async () => {
  const region = { id:'bad', vmAddr:0x8000n, size:0x100n };
  const empty = new VariableInstructionIndex({ disassembleAt:async () => ({ supported:true, instructions:[] }), pageBytes:64, maxPrefetchPages:0 });
  empty.configureRegion(region);
  const page = await empty.ensurePage(0x8000n);
  assert.equal(page.status, 'undecodable');
  assert.equal(page.entries.length, 0);
  assert.equal(page.nextAddress, 0x8000n);

  for (const bad of [0, 16]) {
    const idx = new VariableInstructionIndex({ disassembleAt:async (address) => ({ supported:true, instructions:[{ address, length:bad, rawBytes:new Uint8Array(Math.max(0,bad)), mnemonic:'bad' }] }), pageBytes:64, maxPrefetchPages:0 });
    idx.configureRegion(region);
    await assert.rejects(() => idx.ensurePage(0x8000n), /invalid-instruction-length/);
  }
  const backward = new VariableInstructionIndex({ disassembleAt:async (address) => ({ supported:true, instructions:[ins(BigInt(address)+1n, 1)] }), pageBytes:64, maxPrefetchPages:0 });
  backward.configureRegion(region);
  await assert.rejects(() => backward.ensurePage(0x8000n), /non-monotonic/);
});

test('cache has hard finite page and instruction bounds and revisits can decode safely', async () => {
  const base = 0x100000n;
  const entries = Array.from({ length:1024 }, (_, i) => ins(base + BigInt(i), 1));
  const decode = streamDecoder(entries);
  const index = new VariableInstructionIndex({ disassembleAt:decode, pageBytes:32, maxPages:3, maxInstructions:96, maxPrefetchPages:0 });
  index.configureRegion({ id:'evict', vmAddr:base, size:1024n });
  let start = base;
  for (let i=0; i<8; i++) {
    const page = await index.ensurePage(start);
    start = page.nextAddress;
  }
  const metrics = index.metrics();
  assert.ok(metrics.retainedPages <= 3);
  assert.ok(metrics.retainedInstructions <= 96);
  assert.ok(metrics.evictions >= 5);
  const requests = metrics.decodeRequestCount;
  await index.ensurePage(base, { protect:true });
  assert.equal(index.metrics().decodeRequestCount, requests + 1, 'evicted page must re-decode');
  assert.ok(index.metrics().retainedPages <= 3);
});

test('inflight requests coalesce and cancellation does not publish stale page', async () => {
  const base = 0x200000n;
  const entries = Array.from({ length:256 }, (_, i) => ins(base + BigInt(i), 1));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const decode = streamDecoder(entries, { delay:async () => gate });
  const index = new VariableInstructionIndex({ disassembleAt:decode, pageBytes:32, maxPrefetchPages:0 });
  index.configureRegion({ id:'coalesce', vmAddr:base, size:256n });
  const a = index.ensurePage(base);
  const b = index.ensurePage(base);
  assert.equal(decode.calls.length, 1);
  release();
  const [pa,pb] = await Promise.all([a,b]);
  assert.equal(pa.start, pb.start);
  assert.equal(index.metrics().decodeRequestCount, 1);
  assert.ok(index.metrics().cacheHits >= 1);

  let resolveOld;
  const oldGate = new Promise((resolve) => { resolveOld = resolve; });
  const staleDecode = streamDecoder(entries, { delay:async () => oldGate });
  const stale = new VariableInstructionIndex({ disassembleAt:staleDecode, pageBytes:32, maxPrefetchPages:0 });
  stale.configureRegion({ id:'A', vmAddr:base, size:256n });
  const old = stale.ensurePage(base).catch((error) => error);
  stale.configureRegion({ id:'B', vmAddr:base + 0x1000n, size:256n });
  resolveOld();
  const result = await old;
  assert.ok(result?.name === 'AbortError' || result?.stale === true);
  assert.equal(stale.metrics().retainedPages, 0);
  assert.ok(stale.metrics().cancelledRequests >= 1);
});

test('constants encode explicit iPad/WebKit retention bounds', () => {
  assert.equal(X86_MAX_INSTRUCTION_BYTES, 15);
  assert.equal(VARIABLE_DECODE_PAGE_BYTES, 2048);
  assert.equal(VARIABLE_DECODE_OVERLAP_BYTES, 14);
  assert.equal(VARIABLE_MAX_DECODE_REQUEST_BYTES, 2062);
  assert.equal(VARIABLE_PREFETCH_PAGES, 1);
  assert.equal(VARIABLE_CACHE_PAGES, 8);
  assert.equal(VARIABLE_RETAINED_INSTRUCTION_LIMIT, 16384);
});
